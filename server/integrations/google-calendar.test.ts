import { afterEach, describe, expect, it } from "vitest";
import { fakeServer, json } from "./fake-http.ts";
import { GOOGLE_CALENDAR_SCOPE, GoogleCalendarPush, GoogleCalendarSource, listCalendars, parseCalendarNotification, refreshingTokenProvider } from "./google-calendar.ts";

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const clock = { now: () => new Date("2026-11-02T07:00:00Z") };
const people: Record<string, string> = { "priya@practice.home": "priya", "tom@practice.home": "tom" };
const FAMILY = "family@group.calendar.google.com";
const shared = { calendarId: FAMILY, owner: "shared" };
const source = (baseUrl: string, calendars = [shared]) =>
  new GoogleCalendarSource({
    calendars,
    getAccessToken: async () => "access-1",
    personForEmail: (email) => people[email] ?? null,
    timeZone: "Europe/London",
    clock,
    baseUrl,
  });

describe("Google Calendar source", () => {
  it("[PRV-1] google calendar source can only read: read-only scope, no write methods, every call a GET", async () => {
    expect(GOOGLE_CALENDAR_SCOPE).toMatch(/calendar\.readonly$/);
    const methods = Object.getOwnPropertyNames(GoogleCalendarSource.prototype);
    for (const m of methods) expect(m).not.toMatch(/insert|patch|update|delete|move|create|quickAdd|import|write|remove/i);

    const server = await fakeServer((req, res) =>
      req.path.includes("pageToken=p2")
        ? json(res, 200, { items: [], nextSyncToken: "s1" })
        : json(res, 200, { items: [{ id: "e1", summary: "Dinner", start: { dateTime: "2026-11-03T19:30:00Z" }, end: { dateTime: "2026-11-03T23:00:00Z" } }], nextPageToken: "p2" }),
    );
    servers.push(server);
    const cal = source(server.url);
    await cal.changes({});
    await cal.changes({ [FAMILY]: "s1" });
    expect(server.requests.length).toBeGreaterThan(0);
    for (const r of server.requests) expect(r.method).toBe("GET");
  });

  it("[HOME-1][CH-6] first sync covers yesterday to two months ahead, then syncs incrementally by token", async () => {
    const server = await fakeServer((req, res) =>
      req.path.includes("syncToken=")
        ? json(res, 200, { items: [{ id: "e1", status: "cancelled" }], nextSyncToken: "s2" })
        : json(res, 200, { items: [{ id: "e1", summary: "Dinner", start: { dateTime: "2026-11-03T19:30:00Z" }, end: { dateTime: "2026-11-03T23:00:00Z" } }], nextSyncToken: "s1" }),
    );
    servers.push(server);
    const cal = source(server.url);
    const first = await cal.changes({});
    expect(first.nextSyncTokens).toEqual({ [FAMILY]: "s1" });
    expect(first.upserts.map((e) => e.externalId)).toEqual([`${FAMILY}/e1`]);
    const firstUrl = new URL(server.requests[0]?.path ?? "", server.url);
    expect(firstUrl.searchParams.get("singleEvents")).toBe("true");
    expect(firstUrl.searchParams.get("timeMin")).toBe("2026-11-01T07:00:00.000Z");
    expect(firstUrl.searchParams.get("timeMax")).toBe("2027-01-01T07:00:00.000Z");
    expect(server.requests[0]?.headers.authorization).toBe("Bearer access-1");

    const next = await cal.changes({ [FAMILY]: "s1" });
    expect(next).toEqual({ upserts: [], deletedExternalIds: [`${FAMILY}/e1`], nextSyncTokens: { [FAMILY]: "s2" }, complete: true });
    const nextUrl = new URL(server.requests[1]?.path ?? "", server.url);
    expect(nextUrl.searchParams.get("syncToken")).toBe("s1");
    expect(nextUrl.searchParams.get("timeMin")).toBeNull();
  });

  it("starts again with a full sync when Google says the sync token is gone (410)", async () => {
    const server = await fakeServer((req, res) => (req.path.includes("syncToken=") ? json(res, 410, { error: "gone" }) : json(res, 200, { items: [], nextSyncToken: "fresh" })));
    servers.push(server);
    const out = await source(server.url).changes({ [FAMILY]: "stale" });
    expect(out.nextSyncTokens).toEqual({ [FAMILY]: "fresh" });
    expect(server.requests).toHaveLength(2);
  });

  it("maps attendees, away, work, solo-with-kids and all-day events by the documented conventions", () => {
    const cal = source("http://unused");
    const event = cal.toExternal(
      {
      id: "e2",
      summary: "Priya — client call #work",
      description: "#solo:tom",
      organizer: { email: "priya@practice.home" },
      attendees: [{ email: "Tom@practice.home", responseStatus: "declined" }, { email: "client@example.com" }],
      start: { dateTime: "2026-11-02T13:00:00Z" },
      end: { dateTime: "2026-11-02T13:45:00Z" },
      },
      shared,
    );
    expect(event).toEqual({
      externalId: `${FAMILY}/e2`,
      calendarId: FAMILY,
      owner: "shared",
      uid: null,
      busy: false,
      title: "Priya — client call #work",
      start: "2026-11-02T13:00:00.000Z",
      end: "2026-11-02T13:45:00.000Z",
      allDay: false,
      attendees: ["priya"],
      away: ["priya"],
      work: true,
      soloWithKids: "tom",
    });
    const home = cal.toExternal({ id: "e3", summary: "Video call", description: "#home", organizer: { email: "tom@practice.home" }, start: { dateTime: "2026-11-02T10:00:00Z" }, end: { dateTime: "2026-11-02T11:00:00Z" } }, shared);
    expect(home).toMatchObject({ away: [], attendees: ["tom"] });
    // British Summer Time: an all-day event starts at local midnight, 23:00 UTC the day before.
    const allDay = cal.toExternal({ id: "e4", summary: "Half term", start: { date: "2026-07-20" }, end: { date: "2026-07-21" } }, shared);
    expect(allDay).toMatchObject({ allDay: true, start: "2026-07-19T23:00:00.000Z", end: "2026-07-20T23:00:00.000Z" });
  });

  it("[HOME-1] reads each person's calendar and the shared one: a personal event is its owner's, an invite carries its iCalUID", async () => {
    const PRIYA = "priya@practice.home";
    const TOM = "tom@practice.home";
    const invite = { id: "inv", iCalUID: "inv@google.com", summary: "Dinner at Sam's", organizer: { email: PRIYA }, start: { dateTime: "2026-11-03T19:30:00Z" }, end: { dateTime: "2026-11-03T23:00:00Z" } };
    const items: Record<string, unknown[]> = {
      [PRIYA]: [invite, { id: "p1", iCalUID: "p1@google.com", summary: "Dentist", start: { dateTime: "2026-11-04T10:00:00Z" }, end: { dateTime: "2026-11-04T10:30:00Z" } }],
      [TOM]: [{ ...invite, attendees: [{ email: TOM, self: true, responseStatus: "accepted" }, { email: PRIYA }] }, { id: "t1", iCalUID: "t1@google.com", summary: "Gym", attendees: [{ email: TOM, self: true, responseStatus: "declined" }], start: { dateTime: "2026-11-04T07:00:00Z" }, end: { dateTime: "2026-11-04T08:00:00Z" } }],
      [FAMILY]: [{ id: "s1", iCalUID: "s1@google.com", summary: "Kids at Grandma's", start: { dateTime: "2026-11-07T09:30:00Z" }, end: { dateTime: "2026-11-07T13:00:00Z" } }],
    };
    const server = await fakeServer((req, res) => {
      const id = decodeURIComponent(/\/calendars\/([^/]+)\/events/.exec(req.path)?.[1] ?? "");
      return json(res, 200, { items: items[id] ?? [], nextSyncToken: `tok-${id}` });
    });
    servers.push(server);
    const cal = source(server.url, [{ calendarId: PRIYA, owner: "priya" }, { calendarId: TOM, owner: "tom" }, shared]);
    const out = await cal.changes({});
    expect(out.upserts.map((e) => [e.externalId, e.owner, e.uid, e.attendees, e.away])).toEqual([
      [`${PRIYA}/inv`, "priya", "inv@google.com", ["priya"], ["priya"]],
      [`${PRIYA}/p1`, "priya", "p1@google.com", ["priya"], ["priya"]],
      [`${TOM}/inv`, "tom", "inv@google.com", ["tom"], ["tom"]],
      [`${FAMILY}/s1`, "shared", "s1@google.com", [], []],
    ]);
    // Tom declined the gym invite on his own calendar: it isn't his.
    expect(out.deletedExternalIds).toEqual([`${TOM}/t1`]);
    expect(out.nextSyncTokens).toEqual({ [PRIYA]: `tok-${PRIYA}`, [TOM]: `tok-${TOM}`, [FAMILY]: `tok-${FAMILY}` });
    for (const r of server.requests) expect(r.method).toBe("GET");
  });

  it("[HOME-1] a recurring instance's uid carries its original start; a free/busy-only event is Busy for its owner; a 'free' event takes nobody out", () => {
    const tom = { calendarId: "tom@practice.home", owner: "tom" };
    const cal = source("http://unused", [tom, shared]);
    const instance = cal.toExternal({ id: "sw_1", iCalUID: "swim@google.com", originalStartTime: { dateTime: "2026-11-03T17:00:00+00:00" }, summary: "Swim", start: { dateTime: "2026-11-03T17:30:00Z" }, end: { dateTime: "2026-11-03T18:30:00Z" } }, tom);
    expect(instance).toMatchObject({ uid: "swim@google.com@2026-11-03T17:00:00.000Z" });
    const busy = cal.toExternal({ id: "b1", start: { dateTime: "2026-11-03T09:00:00Z" }, end: { dateTime: "2026-11-03T10:00:00Z" } }, tom);
    expect(busy).toMatchObject({ title: "Busy", busy: true, attendees: ["tom"], away: ["tom"], uid: null });
    const free = cal.toExternal({ id: "f1", summary: "Mum's birthday", transparency: "transparent", start: { date: "2026-11-05" }, end: { date: "2026-11-06" } }, tom);
    expect(free).toMatchObject({ attendees: ["tom"], away: [] });
  });

  it("[HOME-1] one calendar that can't be read is logged and keeps its token; the others still sync; if none can, the sync fails", async () => {
    const server = await fakeServer((req, res) => (req.path.includes("chloe") ? json(res, 404, { error: "notFound" }) : json(res, 200, { items: [], nextSyncToken: "ok" })));
    servers.push(server);
    const chloe = { calendarId: "chloe@example.com", owner: "chloe" };
    const out = await source(server.url, [chloe, shared]).changes({ "chloe@example.com": "old" });
    expect(out.nextSyncTokens).toEqual({ "chloe@example.com": "old", [FAMILY]: "ok" });
    expect(out.complete).toBe(false);
    await expect(source(server.url, [chloe]).changes({})).rejects.toThrow(/404/);
  });

  it("refreshes the OAuth access token with the refresh-token grant and caches it", async () => {
    const server = await fakeServer((_req, res) => json(res, 200, { access_token: "fresh-token", expires_in: 3600 }));
    servers.push(server);
    const get = refreshingTokenProvider({ clientId: "cid", clientSecret: "csecret", refreshToken: "rt", tokenUrl: `${server.url}/token`, clock });
    expect(await get()).toBe("fresh-token");
    expect(await get()).toBe("fresh-token");
    expect(server.requests).toHaveLength(1);
    const form = new URLSearchParams(server.requests[0]?.body.toString());
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt");
  });

  it("[CH-6][PRV-1] opens and closes a push channel with a shared token, and touches no event", async () => {
    const server = await fakeServer((req, res) => (req.path === "/channels/stop" ? res.writeHead(204).end() : json(res, 200, { kind: "api#channel", id: "ch1", resourceId: "r1", expiration: "1790000000000" })));
    servers.push(server);
    const push = new GoogleCalendarPush({ calendarIds: [FAMILY], getAccessToken: async () => "a", baseUrl: server.url });
    const out = await push.open(FAMILY, { id: "ch1", address: "https://house.example/webhooks/calendar", token: "tok" });
    expect(out).toEqual({ resourceId: "r1", expiresAt: new Date(1_790_000_000_000).toISOString() });
    await push.close({ id: "ch1", resourceId: "r1" });
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /calendars/family%40group.calendar.google.com/events/watch", "POST /channels/stop"]);
    expect(JSON.parse(server.requests[0]?.body.toString() ?? "{}")).toEqual({ id: "ch1", type: "web_hook", address: "https://house.example/webhooks/calendar", token: "tok" });
    expect(JSON.parse(server.requests[1]?.body.toString() ?? "{}")).toEqual({ id: "ch1", resourceId: "r1" });
    expect(server.requests[0]?.headers.authorization).toBe("Bearer a");
    const methods = Object.getOwnPropertyNames(GoogleCalendarPush.prototype);
    for (const m of methods) expect(m).not.toMatch(/insert|patch|update|delete|move|create|quickAdd|import|write|remove/i);
  });

  it("lists the calendars it can see by name and ID only, across pages", async () => {
    const server = await fakeServer((req, res) =>
      req.path.includes("pageToken=p2")
        ? json(res, 200, { items: [{ id: "family@group.calendar.google.com", summary: "Family", summaryOverride: "Us", accessRole: "writer" }] })
        : json(res, 200, { items: [{ id: "cal@example.com", summary: "cal@example.com", primary: true, accessRole: "owner" }], nextPageToken: "p2" }),
    );
    servers.push(server);
    const list = await listCalendars({ getAccessToken: async () => "a", baseUrl: server.url });
    expect(list).toEqual([
      { id: "cal@example.com", name: "cal@example.com", primary: true, accessRole: "owner" },
      { id: "family@group.calendar.google.com", name: "Us", primary: false, accessRole: "writer" },
    ]);
    for (const r of server.requests) {
      expect(r.method).toBe("GET");
      expect(new URL(r.path, server.url).pathname).toBe("/users/me/calendarList");
    }
  });

  it("[CH-4][PRV-6] reads push-notification headers so the webhook can dedupe and check the token", () => {
    const headers = new Headers({ "X-Goog-Channel-ID": "ch1", "X-Goog-Channel-Token": "tok", "X-Goog-Resource-State": "exists", "X-Goog-Message-Number": "17" });
    expect(parseCalendarNotification(headers)).toEqual({ channelId: "ch1", token: "tok", state: "exists", messageNumber: "17" });
    expect(parseCalendarNotification({ "x-goog-channel-id": "ch1", "x-goog-resource-state": "sync", "x-goog-message-number": "1" })).toEqual({ channelId: "ch1", token: null, state: "sync", messageNumber: "1" });
    expect(parseCalendarNotification({})).toBeNull();
  });
});
