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
import { jobForKey } from "../../testing/http.ts";
import type { HttpEnv } from "../registry.ts";
import { adapter, ensureWatch, WATCH_CHECK_CRON } from "./index.ts";

/**
 * HOU-147: the real Google adapter (token file → refresh-token grant → events.list / events.watch)
 * against a stand-in Google on localhost, inside a practice household on the fake clock.
 */
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
  if (url.pathname === "/calendars/family%40group.calendar.google.com/events") {
    const item = { id: "g-dentist", summary: "Stand-in dentist", organizer: { email: "priya@practice.home" }, start: { dateTime: dentist.start }, end: { dateTime: dentist.end } };
    const lists = google.requests.filter((r) => r.path.includes("/events?")).length;
    return json(res, 200, { items: [item], nextSyncToken: `standin-${lists}` });
  }
  return json(res, 404, { error: "unknown" });
}

const posts = () => google.requests.filter((r) => r.method === "POST" && !r.path.startsWith("/token"));

beforeAll(async () => {
  google = await fakeServer(standInGoogle);
  dir = mkdtempSync(path.join(tmpdir(), "hou147-"));
  const file = path.join(dir, "google.json");
  writeFileSync(file, JSON.stringify({ client_id: "cid", client_secret: "csecret", refresh_token: "refresh-standin", token_url: `${google.url}/token` }), { mode: 0o600 });
  h = await testHousehold({ jobs: false, env: { PUBLIC_URL: "https://house.example/" } });
  const real = realPorts({ ...h.env, GOOGLE_CALENDAR_ID: "family@group.calendar.google.com", GOOGLE_ACCESS_TOKEN_FILE: file, GOOGLE_CALENDAR_API: google.url }, h.ports.clock, {
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

describe("Google Calendar on the real adapter (HOU-147)", () => {
  test("[CH-6][HOME-1][PRV-1] the house opens a watch, reads a stand-in calendar, and a push re-syncs it", async () => {
    // After the practice seed's own sync (at PRACTICE_START), so this sync is the newest.
    h.ports.clock.set("2026-11-02T08:00:00Z", true);
    const app = new Hono<HttpEnv>();
    await adapter.start?.(rt);
    adapter.routes?.(app, rt);

    // Starting the adapter opened a channel to the house's public address and synced once.
    const watch = await rt.system("test").calendar.watch();
    expect(watch).toMatchObject({ calendarId: "family@group.calendar.google.com", address: "https://house.example/webhooks/calendar", expiresAt: "2026-11-09T08:00:00.000Z", openedAt: "2026-11-02T08:00:00.000Z" });
    const opened = posts()[0];
    expect(JSON.parse(opened?.body.toString() ?? "{}")).toEqual({ id: watch?.channelId, type: "web_hook", address: "https://house.example/webhooks/calendar", token: "practice-calendar-token" });
    const first = await jobForKey(rt, `calendar:${watch?.channelId}:opened`);
    expect(first.job.status).toBe("succeeded");
    const week = await rt.system("test").calendar.between({ from: "2026-11-04T00:00:00Z", to: "2026-11-05T00:00:00Z" });
    expect(week.find((e) => e.externalId === "g-dentist")).toMatchObject({ title: "Stand-in dentist", start: "2026-11-04T10:00:00.000Z", attendees: ["priya"], away: ["priya"] });

    // The schedule that renews it is DBOS's, hourly.
    expect((await DBOS.getSchedule("household:calendar-watch"))?.schedule).toBe(WATCH_CHECK_CRON);

    // Google pushes a change: the same webhook path syncs incrementally with the token it was given.
    dentist = { start: "2026-11-04T11:00:00Z", end: "2026-11-04T11:30:00Z" };
    h.ports.clock.set("2026-11-02T08:05:00Z", true);
    const res = await app.request("/webhooks/calendar", {
      method: "POST",
      headers: { "x-goog-channel-id": watch?.channelId ?? "", "x-goog-channel-token": "practice-calendar-token", "x-goog-resource-state": "exists", "x-goog-message-number": "2", "x-goog-resource-id": watch?.resourceId ?? "" },
    });
    expect(res.status).toBe(200);
    const second = await jobForKey(rt, `calendar:${watch?.channelId}:2`);
    expect(second.job.toolCalls[0]?.output).toEqual({ changedDates: ["2026-11-04"] });
    const lists = google.requests.filter((r) => r.path.includes("/events?"));
    expect(new URL(lists.at(-1)?.path ?? "", google.url).searchParams.get("syncToken")).toBe(`standin-${lists.length - 1}`);

    // PRV-1: every call but the token, the watch and the channel stop is a read.
    const writes = google.requests.filter((r) => r.method !== "GET").map((r) => new URL(r.path, google.url).pathname);
    expect(writes.filter((p) => !/^\/token$|\/events\/watch$|^\/channels\/stop$/.test(p))).toEqual([]);
    // The refresh-token grant from the file, never the token itself in a URL.
    const grant = new URLSearchParams(google.requests.find((r) => r.path === "/token")?.body.toString());
    expect(grant.get("grant_type")).toBe("refresh_token");
    for (const r of google.requests) expect(r.path).not.toContain("refresh-standin");
  });

  test("[CH-6] fake clock: the watch is kept until a day before Google ends it, then renewed and the old one closed", async () => {
    const before = await rt.system("test").calendar.watch();
    if (before === null) throw new Error("no watch from the first test");
    const stopsBefore = posts().filter((r) => r.path === "/channels/stop").length;

    h.ports.clock.set("2026-11-07T08:00:00Z", true); // five days in: two left
    expect(await ensureWatch(rt)).toEqual({ action: "kept", expiresAt: "2026-11-09T08:00:00.000Z" });
    h.ports.clock.set("2026-11-08T07:59:00Z", true); // a day and a minute left
    expect((await ensureWatch(rt)).action).toBe("kept");

    h.ports.clock.set("2026-11-08T08:17:00Z", true); // the next hourly check: under a day left
    const renewed = await ensureWatch(rt);
    expect(renewed).toMatchObject({ action: "opened", expiresAt: "2026-11-15T08:17:00.000Z", replaced: before.channelId });
    const after = await rt.system("test").calendar.watch();
    expect(after?.channelId).not.toBe(before.channelId);
    const stops = posts().filter((r) => r.path === "/channels/stop");
    expect(stops).toHaveLength(stopsBefore + 1);
    expect(JSON.parse(stops.at(-1)?.body.toString() ?? "{}")).toEqual({ id: before.channelId, resourceId: before.resourceId });
    const sync = await jobForKey(rt, `calendar:${after?.channelId}:opened`);
    expect(sync.job.status).toBe("succeeded");

    h.ports.clock.set("2026-11-08T09:17:00Z", true);
    expect((await ensureWatch(rt)).action).toBe("kept");
  });

  test("[CH-6] after GOOGLE_CALENDAR_ID changes, the next check opens a channel on the new calendar and closes the old one", async () => {
    const before = await rt.system("test").calendar.watch();
    if (before === null) throw new Error("no watch from the earlier tests");
    const other = new GoogleCalendarPush({ calendarId: "cal@example.com", getAccessToken: async () => "a", baseUrl: google.url });
    const moved = await ensureWatch({ ...rt, ports: { ...rt.ports, calendarPush: other } });
    expect(moved).toMatchObject({ action: "opened", replaced: before.channelId });
    expect(await rt.system("test").calendar.watch()).toMatchObject({ calendarId: "cal@example.com" });
    expect(posts().at(-2)?.path).toBe("/calendars/cal%40example.com/events/watch");
    expect(JSON.parse(posts().at(-1)?.body.toString() ?? "{}")).toEqual({ id: before.channelId, resourceId: before.resourceId });
  });

  test("[CH-6] the practice household has no push, so it opens nothing", async () => {
    expect(await ensureWatch(h.rt)).toEqual({ action: "no-push" });
  });
});
