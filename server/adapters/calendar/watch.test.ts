import { randomBytes } from "node:crypto";
import { Practice } from "@household/contracts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { fakeServer, json, type Recorded } from "../../integrations/fake-http.ts";
import { GoogleCalendarPush } from "../../integrations/google-calendar.ts";
import { realPorts } from "../../integrations/index.ts";
import { launchJobs, stopJobs } from "../../jobs/launch.ts";
import { createRuntime, type Runtime } from "../../runtime.ts";
import { testHousehold, type TestHousehold } from "../../testing/household.ts";
import { jobForKey, poll } from "../../testing/http.ts";
import type { HttpEnv } from "../registry.ts";
import { adapter, ensureWatches, WATCH_CHECK_CRON } from "./index.ts";

/** HOU-168: made up per run, so no credential-shaped literal is in the repo. */
const CLIENT_SECRET = randomBytes(12).toString("base64url");
const REFRESH = `refresh-${randomBytes(12).toString("base64url")}`;

/**
 * HOU-147 / HOU-152: the real Google adapter (token file → refresh-token grant → events.list /
 * events.watch) against a stand-in Google on localhost with two calendars (the shared one and Tom's),
 * inside a practice household on the fake clock.
 */
const FAMILY = "family@group.calendar.google.com";
const TOM = "tom@example.com";
const DAY = 86_400_000;
let h: TestHousehold;
let rt: Runtime;
let google: Awaited<ReturnType<typeof fakeServer>>;
let dir: string;
let dentist = { start: "2026-11-04T10:00:00Z", end: "2026-11-04T10:30:00Z" };

function standInGoogle(req: Recorded, res: Parameters<Parameters<typeof fakeServer>[0]>[1]) {
  const url = new URL(req.path, "http://google");
  if (url.pathname === "/token") return json(res, 200, { access_token: `access-${google.requests.length}`, expires_in: 3600 });
  if (url.pathname === "/channels/stop") return res.writeHead(204).end();
  if (/^\/calendars\/[^/]+\/events\/watch$/.test(url.pathname)) {
    const { id } = z.object({ id: z.string() }).parse(JSON.parse(req.body.toString()));
    // Google's own default: a channel lasts a week from when it was opened.
    return json(res, 200, { kind: "api#channel", id, resourceId: `res-${id}`, expiration: String(h.ports.clock.now().getTime() + 7 * DAY) });
  }
  const lists = google.requests.filter((r) => r.path.includes("/events?")).length;
  if (url.pathname === `/calendars/${encodeURIComponent(FAMILY)}/events`) {
    const item = { id: "g-dentist", iCalUID: "dentist@google.com", summary: "Stand-in dentist", organizer: { email: "priya@practice.home" }, start: { dateTime: dentist.start }, end: { dateTime: dentist.end } };
    return json(res, 200, { items: [item], nextSyncToken: `standin-${lists}` });
  }
  if (url.pathname === `/calendars/${encodeURIComponent(TOM)}/events`) {
    // Tom is going too: the same event (same iCalUID) is on his own calendar.
    const item = { id: "g-dentist", iCalUID: "dentist@google.com", summary: "Stand-in dentist", start: { dateTime: dentist.start }, end: { dateTime: dentist.end } };
    return json(res, 200, { items: [item], nextSyncToken: `tom-${lists}` });
  }
  return json(res, 404, { error: "unknown" });
}

const posts = () => google.requests.filter((r) => r.method === "POST" && !r.path.startsWith("/token"));

beforeAll(async () => {
  google = await fakeServer(standInGoogle);
  dir = mkdtempSync(path.join(tmpdir(), "hou147-"));
  const file = path.join(dir, "google.json");
  writeFileSync(file, JSON.stringify({ client_id: "cid", client_secret: CLIENT_SECRET, refresh_token: REFRESH, token_url: `${google.url}/token` }), { mode: 0o600 });
  h = await testHousehold({ jobs: false, env: { PUBLIC_URL: "https://house.example/" } });
  const real = realPorts({ ...h.env, GOOGLE_CALENDARS: `shared:${FAMILY},tom:${TOM}`, GOOGLE_ACCESS_TOKEN_FILE: file, GOOGLE_CALENDAR_API: google.url }, h.ports.clock, {
    timeZone: "Europe/London",
    personForEmail: (email) => (email === "priya@practice.home" ? "priya" : null),
  });
  if (real.missing.includes("calendar")) throw new Error("the real calendar adapter was not configured");
  rt = await createRuntime(h.env, { ...h.ports, calendar: real.ports.calendar, ...(real.ports.calendarPush === undefined ? {} : { calendarPush: real.ports.calendarPush }) });
  await launchJobs(rt);
});
afterAll(async () => {
  await stopJobs();
  await rt.close();
  await h.close();
  await google.close();
  rmSync(dir, { recursive: true, force: true });
});

const inUse = (calendarId: string) => async () => (await rt.system("test").calendar.watches()).find((w) => w.calendarId === calendarId) ?? null;

describe("Google Calendar on the real adapter (HOU-147, HOU-152)", () => {
  test("[CH-6][HOME-1][PRV-1] the house opens a watch per calendar, reads them as one, and a push re-syncs", async () => {
    // After the practice seed's own sync (at PRACTICE_START), so this sync is the newest.
    h.ports.clock.set("2026-11-02T08:00:00Z", true);
    const app = new Hono<HttpEnv>();
    await adapter.start?.(rt);
    adapter.routes?.(app, rt);

    // Starting the adapter opened one channel per calendar to the house's public address and synced once.
    const family = await poll(inUse(FAMILY));
    const tom = await poll(inUse(TOM));
    expect(family).toMatchObject({ calendarId: FAMILY, address: "https://house.example/webhooks/calendar", expiresAt: "2026-11-09T08:00:00.000Z", openedAt: "2026-11-02T08:00:00.000Z", closedAt: null });
    expect(tom).toMatchObject({ calendarId: TOM, address: "https://house.example/webhooks/calendar", closedAt: null });
    expect(posts().map((r) => r.path)).toEqual([`/calendars/${encodeURIComponent(FAMILY)}/events/watch`, `/calendars/${encodeURIComponent(TOM)}/events/watch`]);
    expect(JSON.parse(posts()[0]?.body.toString() ?? "{}")).toEqual({ id: family?.channelId, type: "web_hook", address: "https://house.example/webhooks/calendar", token: Practice.settings.CALENDAR_WEBHOOK_TOKEN });
    const first = await jobForKey(rt, "calendar:opened:2026-11-02T08:00:00.000Z");
    expect(first.job.status).toBe("succeeded");
    // The practice seed's copies (from calendars this house doesn't read) are gone; the dentist is one
    // event with both owners on it.
    const week = await rt.system("test").calendar.between({ from: "2026-11-02T00:00:00Z", to: "2026-11-09T00:00:00Z" });
    expect(week).toHaveLength(1);
    expect(week[0]).toMatchObject({ externalId: "dentist@google.com", title: "Stand-in dentist", start: "2026-11-04T10:00:00.000Z", attendees: ["priya", "tom"], away: ["priya", "tom"], calendars: ["shared", "tom"] });
    expect(await rt.system("test").calendar.syncTokens()).toEqual({ [FAMILY]: expect.stringMatching(/^standin-/), [TOM]: expect.stringMatching(/^tom-/) });

    // The schedule that renews them is DBOS's, hourly.
    expect((await DBOS.getSchedule("household:calendar-watch"))?.schedule).toBe(WATCH_CHECK_CRON);

    // Google pushes a change on Tom's calendar: the same webhook path syncs each calendar incrementally.
    dentist = { start: "2026-11-04T11:00:00Z", end: "2026-11-04T11:30:00Z" };
    h.ports.clock.set("2026-11-02T08:05:00Z", true);
    const push = (n: string) =>
      app.request("/webhooks/calendar", {
        method: "POST",
        headers: { "x-goog-channel-id": tom?.channelId ?? "", "x-goog-channel-token": Practice.settings.CALENDAR_WEBHOOK_TOKEN, "x-goog-resource-state": "exists", "x-goog-message-number": n, "x-goog-resource-id": tom?.resourceId ?? "" },
      });
    expect((await push("2")).status).toBe(200);
    const second = await jobForKey(rt, `calendar:${tom?.channelId}:2`);
    // CH-6: only the day affected is re-planned.
    expect(second.job.toolCalls[0]?.output).toEqual({ changedDates: ["2026-11-04"] });
    const lists = google.requests.filter((r) => r.path.includes("/events?"));
    expect(lists.slice(-2).map((r) => new URL(r.path, google.url).searchParams.get("syncToken"))).toEqual([expect.stringMatching(/^standin-/), expect.stringMatching(/^tom-/)]);
    // CH-4: the same notification again is the same job, not another.
    const again = await (await push("2")).json();
    expect(again).toMatchObject({ jobId: second.job.id });

    // PRV-1: every call but the token, the watch and the channel stop is a read.
    const writes = google.requests.filter((r) => r.method !== "GET").map((r) => new URL(r.path, google.url).pathname);
    expect(writes.filter((p) => !/^\/token$|\/events\/watch$|^\/channels\/stop$/.test(p))).toEqual([]);
    // The refresh-token grant from the file, never the token itself in a URL.
    const grant = new URLSearchParams(google.requests.find((r) => r.path === "/token")?.body.toString());
    expect(grant.get("grant_type")).toBe("refresh_token");
    for (const r of google.requests) expect(r.path).not.toContain(REFRESH);
  });

  test("[CH-6] fake clock: each watch is kept until a day before Google ends it, then renewed and the old one closed", async () => {
    const before = await inUse(FAMILY)();
    const tomBefore = await inUse(TOM)();
    if (before === null || tomBefore === null) throw new Error("no watches from the first test");
    const stopsBefore = posts().filter((r) => r.path === "/channels/stop").length;

    h.ports.clock.set("2026-11-07T08:00:00Z", true); // five days in: two left
    expect(await ensureWatches(rt)).toEqual({
      action: "checked",
      calendars: [
        { calendarId: FAMILY, action: "kept", expiresAt: "2026-11-09T08:00:00.000Z" },
        { calendarId: TOM, action: "kept", expiresAt: "2026-11-09T08:00:00.000Z" },
      ],
      closed: [],
      syncJobId: null,
    });
    h.ports.clock.set("2026-11-08T07:59:00Z", true); // a day and a minute left
    expect(await ensureWatches(rt)).toMatchObject({ calendars: [{ action: "kept" }, { action: "kept" }] });

    h.ports.clock.set("2026-11-08T08:17:00Z", true); // the next hourly check: under a day left
    const renewed = await ensureWatches(rt);
    expect(renewed).toMatchObject({
      calendars: [
        { calendarId: FAMILY, action: "opened", expiresAt: "2026-11-15T08:17:00.000Z", replaced: before.channelId },
        { calendarId: TOM, action: "opened", replaced: tomBefore.channelId },
      ],
    });
    const after = await inUse(FAMILY)();
    expect(after?.channelId).not.toBe(before.channelId);
    expect(await rt.system("test").calendar.watches()).toHaveLength(2);
    const stops = posts().filter((r) => r.path === "/channels/stop");
    expect(stops).toHaveLength(stopsBefore + 2);
    expect(JSON.parse(stops.at(-2)?.body.toString() ?? "{}")).toEqual({ id: before.channelId, resourceId: before.resourceId });
    const sync = await jobForKey(rt, "calendar:opened:2026-11-08T08:17:00.000Z");
    expect(sync.job.status).toBe("succeeded");

    h.ports.clock.set("2026-11-08T09:17:00Z", true);
    expect(await ensureWatches(rt)).toMatchObject({ calendars: [{ action: "kept" }, { action: "kept" }], syncJobId: null });
  });

  test("[HOME-1] a calendar that has never been read is tried once a day at the hourly check, not every hour", async () => {
    // Everything as the house has it, except that Tom's calendar has no sync token yet.
    const unread = {
      ...rt,
      system: (reason: string) => {
        const api = rt.system(reason);
        const calendar = new Proxy(api.calendar, { get: (t, k) => (k === "syncTokens" ? async () => ({ [FAMILY]: "s" }) : Reflect.get(t, k)) });
        return new Proxy(api, { get: (t, k) => (k === "calendar" ? calendar : Reflect.get(t, k)) });
      },
    };
    h.ports.clock.set("2026-11-09T10:17:00Z", true);
    const first = await ensureWatches(unread);
    expect(first.action === "checked" ? first.syncJobId : null).not.toBeNull();
    h.ports.clock.set("2026-11-09T11:17:00Z", true);
    expect(await ensureWatches(unread)).toMatchObject({ syncJobId: null });
    h.ports.clock.set("2026-11-10T10:17:00Z", true);
    expect(await ensureWatches(unread)).toMatchObject({ syncJobId: expect.any(String) });
  });

  test("[CH-6] when the calendars change, the next check opens a channel on the new one and closes those no longer read", async () => {
    const family = await inUse(FAMILY)();
    const tom = await inUse(TOM)();
    if (family === null || tom === null) throw new Error("no watches from the earlier tests");
    const other = new GoogleCalendarPush({ calendarIds: ["cal@example.com"], getAccessToken: async () => "a", baseUrl: google.url });
    const moved = await ensureWatches({ ...rt, ports: { ...rt.ports, calendarPush: other } });
    expect(moved).toMatchObject({ calendars: [{ calendarId: "cal@example.com", action: "opened", replaced: null }], closed: [family.channelId, tom.channelId] });
    expect((await rt.system("test").calendar.watches()).map((w) => w.calendarId)).toEqual(["cal@example.com"]);
    expect(posts().at(-3)?.path).toBe("/calendars/cal%40example.com/events/watch");
    expect(posts().slice(-2).map((r) => JSON.parse(r.body.toString()))).toEqual([
      { id: family.channelId, resourceId: family.resourceId },
      { id: tom.channelId, resourceId: tom.resourceId },
    ]);
  });

  test("[CH-6] a channel the house couldn't record is closed again, the one in use is unchanged, and other calendars carry on", async () => {
    const before = await rt.system("test").calendar.watches();
    const failing = {
      ...rt,
      system: (reason: string) => {
        const api = rt.system(reason);
        return { ...api, calendar: { ...api.calendar, watches: async () => [], syncTokens: async () => ({ [FAMILY]: "s", [TOM]: "t" }), recordWatch: async () => Promise.reject(new Error("db down")) } } as typeof api;
      },
    };
    const out = await ensureWatches(failing);
    expect(out).toMatchObject({ calendars: [{ calendarId: FAMILY, action: "failed", error: "db down" }, { calendarId: TOM, action: "failed", error: "db down" }] });
    const [open, stop] = posts().slice(-2);
    const opened = z.object({ id: z.string() }).parse(JSON.parse(open?.body.toString() ?? "{}"));
    expect(stop?.path).toBe("/channels/stop");
    expect(JSON.parse(stop?.body.toString() ?? "{}")).toEqual({ id: opened.id, resourceId: `res-${opened.id}` });
    expect(await rt.system("test").calendar.watches()).toEqual(before);
  });

  test("[CH-6] the practice household has no push, so it opens nothing", async () => {
    expect(await ensureWatches(h.rt)).toEqual({ action: "no-push" });
  });
});
