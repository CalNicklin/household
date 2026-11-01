/**
 * Google Calendar, read-only (PRV-1). The source asks for the `calendar.readonly` scope and only
 * ever issues GET requests to the Calendar API; nothing here can create, move or delete an event.
 *
 * HOME-1: the house reads several calendars through one sign-in (Cal's): Cal's own, Chloe's (shared
 * with Cal's account) and the shared one, each named with its owner (GOOGLE_CALENDARS). Each
 * calendar's copy of an event is kept separately and read back merged by `uid` (calendar/merge.ts).
 *
 * How a Google event becomes a household event. These are conventions, chosen so the calendars need
 * no new fields; the household can change them here:
 * - attendees: on a person's own calendar, that person (unless they declined it, when it isn't
 *   theirs). On the shared calendar, the organizer plus every attendee who has not declined, mapped
 *   from email to a person with `personForEmail`; unknown emails (friends, colleagues) are ignored.
 * - uid: Google's iCalUID plus, for one instance of a recurring event, its original start. The same
 *   invite on Cal's and Chloe's calendars (or a copy on the shared one) has the same uid.
 * - busy: on a calendar shared as free/busy only (or a private event on it) Google gives no title;
 *   the copy is "Busy" for its owner.
 * - away: everyone attending is out of the house, unless the description carries `#home` or the event
 *   is marked "free" in Google (a reminder, a birthday).
 * - work: the summary or description carries `#work`, or the event comes from a calendar listed
 *   in `workCalendarIds`.
 * - soloWithKids: the description carries `#solo:<person>` (e.g. `#solo:tom`) when that person has
 *   the kids alone during the event.
 * - all-day events start and end at local midnight in the house's time zone.
 * - cancelled events are reported as deleted.
 */
import { CalendarOwnerKind, type HouseCalendar } from "@household/contracts";
import { z } from "zod";
import type { CalendarChanges, CalendarPush, CalendarSource, Clock, ExternalEvent } from "../ports.ts";
import { startOfLocalDay } from "../time.ts";
import { defaultFetch, expectOk, type Fetch, IntegrationError } from "./http.ts";

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

const zDateTime = z.object({ dateTime: z.string().optional(), date: z.string().optional() });
const zEvent = z.object({
  id: z.string(),
  status: z.string().optional(),
  iCalUID: z.string().optional(),
  originalStartTime: zDateTime.optional(),
  transparency: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: zDateTime.optional(),
  end: zDateTime.optional(),
  organizer: z.object({ email: z.string().optional() }).optional(),
  attendees: z.array(z.object({ email: z.string().optional(), responseStatus: z.string().optional(), self: z.boolean().optional() })).optional(),
});
type GoogleEvent = z.infer<typeof zEvent>;
const zList = z.object({ items: z.array(zEvent).optional(), nextPageToken: z.string().optional(), nextSyncToken: z.string().optional() });

export type GoogleCalendarOptions = {
  /** Every calendar the house reads, each with its owner (a person ID, or `shared`). */
  calendars: readonly HouseCalendar[];
  getAccessToken: () => Promise<string>;
  personForEmail: (email: string) => string | null;
  timeZone: string;
  clock: Clock;
  workCalendarIds?: readonly string[];
  baseUrl?: string;
  fetch?: Fetch;
};

const DAY_MS = 86_400_000;
/** How far the first sync reaches: yesterday to two months ahead (a planning horizon, not a limit on a call). */
const FIRST_SYNC_PAST_DAYS = 1;
const FIRST_SYNC_FUTURE_DAYS = 60;

/** A copy's ID in the house: the same Google event ID can be on two calendars (an invite). */
const copyId = (calendarId: string, eventId: string): string => `${calendarId}/${eventId}`;

/** Google's iCalUID, plus the original start for one instance of a recurring event. */
function uidOf(item: GoogleEvent): string | null {
  if (item.iCalUID === undefined) return null;
  const original = item.originalStartTime;
  const at = original?.dateTime === undefined ? original?.date : new Date(original.dateTime).toISOString();
  return at === undefined ? item.iCalUID : `${item.iCalUID}@${at}`;
}

export class GoogleCalendarSource implements CalendarSource {
  readonly #o: GoogleCalendarOptions;
  readonly #fetch: Fetch;
  readonly #baseUrl: string;
  readonly calendars: readonly HouseCalendar[];
  constructor(options: GoogleCalendarOptions) {
    this.#o = options;
    this.calendars = options.calendars;
    this.#fetch = options.fetch ?? defaultFetch;
    this.#baseUrl = options.baseUrl ?? CALENDAR_API;
  }

  /**
   * Every calendar's changes since its token. One calendar that can't be read (not shared with this
   * account yet, say) is logged and keeps its token and its copies; the others still sync. If none
   * can be read, the sync fails.
   */
  async changes(syncTokens: Readonly<Record<string, string>>): Promise<CalendarChanges> {
    const out: CalendarChanges = { upserts: [], deletedExternalIds: [], nextSyncTokens: {}, sharedRead: true };
    let failure: unknown = null;
    let read = 0;
    for (const calendar of this.calendars) {
      const token = syncTokens[calendar.calendarId] ?? null;
      try {
        const one = await this.#calendarChanges(calendar, token);
        out.upserts.push(...one.upserts);
        out.deletedExternalIds.push(...one.deletedExternalIds);
        if (one.nextSyncToken !== null) out.nextSyncTokens[calendar.calendarId] = one.nextSyncToken;
        read += 1;
      } catch (error) {
        failure = error;
        if (calendar.owner === CalendarOwnerKind.shared) out.sharedRead = false;
        if (token !== null) out.nextSyncTokens[calendar.calendarId] = token;
        console.warn(JSON.stringify({ event: "calendar-read-failed", owner: calendar.owner, calendarId: calendar.calendarId, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    if (read === 0 && failure !== null) throw failure;
    return out;
  }

  async #calendarChanges(calendar: HouseCalendar, syncToken: string | null) {
    try {
      return await this.#list(calendar, syncToken);
    } catch (error) {
      // 410 Gone: the sync token expired; Google says to start again with a full sync.
      if (error instanceof IntegrationError && error.status === 410 && syncToken !== null) return this.#list(calendar, null);
      throw error;
    }
  }

  async #list(calendar: HouseCalendar, syncToken: string | null) {
    const upserts: ExternalEvent[] = [];
    const deletedExternalIds: string[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    do {
      const url = new URL(`${this.#baseUrl}/calendars/${encodeURIComponent(calendar.calendarId)}/events`);
      url.searchParams.set("singleEvents", "true");
      if (syncToken === null) {
        const now = this.#o.clock.now().getTime();
        url.searchParams.set("timeMin", new Date(now - FIRST_SYNC_PAST_DAYS * DAY_MS).toISOString());
        url.searchParams.set("timeMax", new Date(now + FIRST_SYNC_FUTURE_DAYS * DAY_MS).toISOString());
      } else {
        url.searchParams.set("syncToken", syncToken);
      }
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
      const response = await this.#fetch(url.toString(), { method: "GET", headers: { authorization: `Bearer ${await this.#o.getAccessToken()}` } });
      await expectOk(response, "Google Calendar events.list");
      const page = zList.parse(await response.json());
      for (const item of page.items ?? []) {
        const event = item.status === "cancelled" ? "gone" : this.toExternal(item, calendar);
        if (event === "gone") deletedExternalIds.push(copyId(calendar.calendarId, item.id));
        else if (event !== null) upserts.push(event);
      }
      pageToken = page.nextPageToken;
      nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    } while (pageToken !== undefined);
    return { upserts, deletedExternalIds, nextSyncToken };
  }

  /**
   * Map one calendar's copy of a Google event using the conventions at the top of this file: null when
   * it has no usable times, "gone" when the owner of a personal calendar declined it (so it is not theirs).
   */
  toExternal(item: GoogleEvent, calendar: HouseCalendar): ExternalEvent | "gone" | null {
    const start = this.#instant(item.start);
    const end = this.#instant(item.end);
    if (start === null || end === null) return null;
    const attendees = this.#attendees(item, calendar);
    if (attendees === "gone") return attendees;
    const busy = calendar.owner !== CalendarOwnerKind.shared && item.summary === undefined;
    const description = item.description ?? "";
    const summary = item.summary ?? (busy ? "Busy" : "(no title)");
    const stayHome = /#home\b/i.test(description) || item.transparency === "transparent";
    return {
      externalId: copyId(calendar.calendarId, item.id),
      calendarId: calendar.calendarId,
      owner: calendar.owner,
      uid: uidOf(item),
      busy,
      title: summary,
      start: start.toISOString(),
      end: end.toISOString(),
      allDay: item.start?.date !== undefined,
      attendees,
      away: stayHome ? [] : [...attendees],
      work: /#work\b/i.test(`${summary} ${description}`) || (this.#o.workCalendarIds ?? []).includes(calendar.calendarId),
      soloWithKids: /#solo:([a-z0-9_-]+)/i.exec(description)?.[1]?.toLowerCase() ?? null,
    };
  }

  /** The owner on their own calendar (unless they declined); on the shared one, by attendee email. */
  #attendees(item: GoogleEvent, calendar: HouseCalendar): string[] | "gone" {
    const invited = item.attendees ?? [];
    if (calendar.owner !== CalendarOwnerKind.shared) return invited.some((a) => a.self === true && a.responseStatus === "declined") ? "gone" : [calendar.owner];
    const attendees: string[] = [];
    for (const email of [item.organizer?.email, ...invited.filter((a) => a.responseStatus !== "declined").map((a) => a.email)]) {
      const person = email === undefined ? null : this.#o.personForEmail(email.toLowerCase());
      if (person !== null && !attendees.includes(person)) attendees.push(person);
    }
    return attendees;
  }

  #instant(t: z.infer<typeof zDateTime> | undefined): Date | null {
    if (t?.dateTime !== undefined) return new Date(t.dateTime);
    if (t?.date !== undefined) return startOfLocalDay(t.date, this.#o.timeZone);
    return null;
  }
}

/** OAuth refresh-token grant, cached until shortly before the access token expires. */
export function refreshingTokenProvider(options: { clientId: string; clientSecret: string; refreshToken: string; tokenUrl?: string; fetch?: Fetch; clock?: Clock }): () => Promise<string> {
  const doFetch = options.fetch ?? defaultFetch;
  const now = () => (options.clock ?? { now: () => new Date() }).now().getTime();
  let cached: { token: string; expiresAt: number } | null = null;
  const zToken = z.object({ access_token: z.string(), expires_in: z.number() });
  return async () => {
    if (cached !== null && cached.expiresAt > now()) return cached.token;
    const response = await doFetch(options.tokenUrl ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: options.clientId, client_secret: options.clientSecret, refresh_token: options.refreshToken }).toString(),
    });
    await expectOk(response, "Google OAuth token refresh");
    const body = zToken.parse(await response.json());
    // Refresh a minute early so a request never goes out with a token that expires in flight.
    cached = { token: body.access_token, expiresAt: now() + (body.expires_in - 60) * 1000 };
    return cached.token;
  };
}

/**
 * CH-6: Google's push notifications, one channel per calendar. `open` is `events.watch`, which creates
 * a notification channel, not an event; Google then calls `address` with `token` echoed in
 * X-Goog-Channel-Token. `close` is `channels.stop`. Neither can create, move or delete an event (PRV-1).
 */
export class GoogleCalendarPush implements CalendarPush {
  readonly #o: { getAccessToken: () => Promise<string>; baseUrl: string; fetch: Fetch };
  readonly calendarIds: readonly string[];
  constructor(options: { calendarIds: readonly string[]; getAccessToken: () => Promise<string>; baseUrl?: string; fetch?: Fetch }) {
    this.calendarIds = options.calendarIds;
    this.#o = { getAccessToken: options.getAccessToken, baseUrl: options.baseUrl ?? CALENDAR_API, fetch: options.fetch ?? defaultFetch };
  }

  async open(calendarId: string, channel: { id: string; address: string; token: string }): Promise<{ resourceId: string; expiresAt: string }> {
    const response = await this.#post(`/calendars/${encodeURIComponent(calendarId)}/events/watch`, { id: channel.id, type: "web_hook", address: channel.address, token: channel.token });
    await expectOk(response, "Google Calendar events.watch");
    // Google gives the expiry as milliseconds since the epoch, in a string.
    const body = z.object({ resourceId: z.string(), expiration: z.string().regex(/^\d+$/) }).parse(await response.json());
    return { resourceId: body.resourceId, expiresAt: new Date(Number(body.expiration)).toISOString() };
  }

  async close(channel: { id: string; resourceId: string }): Promise<void> {
    await expectOk(await this.#post("/channels/stop", { id: channel.id, resourceId: channel.resourceId }), "Google Calendar channels.stop");
  }

  async #post(path: string, body: unknown): Promise<Response> {
    return this.#o.fetch(`${this.#o.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.#o.getAccessToken()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

export type CalendarListEntry = { id: string; name: string; primary: boolean; accessRole: string };

/** The calendars the token can see: names and IDs only, never events (for `household-google check`). */
export async function listCalendars(options: { getAccessToken: () => Promise<string>; baseUrl?: string; fetch?: Fetch }): Promise<CalendarListEntry[]> {
  const doFetch = options.fetch ?? defaultFetch;
  const zPage = z.object({
    items: z.array(z.object({ id: z.string(), summary: z.string().optional(), summaryOverride: z.string().optional(), primary: z.boolean().optional(), accessRole: z.string() })).optional(),
    nextPageToken: z.string().optional(),
  });
  const out: CalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${options.baseUrl ?? CALENDAR_API}/users/me/calendarList`);
    url.searchParams.set("fields", "items(id,summary,summaryOverride,primary,accessRole),nextPageToken");
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const response = await doFetch(url.toString(), { method: "GET", headers: { authorization: `Bearer ${await options.getAccessToken()}` } });
    await expectOk(response, "Google Calendar calendarList.list");
    const page = zPage.parse(await response.json());
    for (const c of page.items ?? []) out.push({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id, primary: c.primary ?? false, accessRole: c.accessRole });
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return out;
}

export type CalendarNotification = { channelId: string; token: string | null; state: string; messageNumber: string };

/** Headers of a Google push notification; the message number is unique per channel (CH-4 dedupe). */
export function parseCalendarNotification(headers: Headers | Record<string, string | undefined>): CalendarNotification | null {
  const get = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : headers[key];
  };
  const channelId = get("x-goog-channel-id");
  const state = get("x-goog-resource-state");
  const messageNumber = get("x-goog-message-number");
  if (channelId === undefined || state === undefined || messageNumber === undefined) return null;
  return { channelId, token: get("x-goog-channel-token") ?? null, state, messageNumber };
}
