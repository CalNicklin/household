/**
 * Google Calendar, read-only (PRV-1). The source asks for the `calendar.readonly` scope and only
 * ever issues GET requests to the Calendar API; nothing here can create, move or delete an event.
 *
 * How a Google event becomes a household event. These are conventions, chosen so the shared
 * calendar needs no new fields; the household can change them here:
 * - attendees: the organizer plus every attendee who has not declined, mapped from email to a
 *   person with `personForEmail`; unknown emails (friends, colleagues) are ignored.
 * - away: everyone attending is out of the house, unless the description carries `#home`.
 * - work: the summary or description carries `#work`, or the event comes from a calendar listed
 *   in `workCalendarIds`.
 * - soloWithKids: the description carries `#solo:<person>` (e.g. `#solo:tom`) when that person has
 *   the kids alone during the event.
 * - all-day events start and end at local midnight in the house's time zone.
 * - cancelled events are reported as deleted.
 */
import { z } from "zod";
import type { CalendarPush, CalendarSource, Clock, ExternalEvent } from "../ports.ts";
import { startOfLocalDay } from "../time.ts";
import { defaultFetch, expectOk, type Fetch, IntegrationError } from "./http.ts";

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

const zDateTime = z.object({ dateTime: z.string().optional(), date: z.string().optional() });
const zEvent = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: zDateTime.optional(),
  end: zDateTime.optional(),
  organizer: z.object({ email: z.string().optional() }).optional(),
  attendees: z.array(z.object({ email: z.string().optional(), responseStatus: z.string().optional() })).optional(),
});
type GoogleEvent = z.infer<typeof zEvent>;
const zList = z.object({ items: z.array(zEvent).optional(), nextPageToken: z.string().optional(), nextSyncToken: z.string().optional() });

export type GoogleCalendarOptions = {
  calendarId: string;
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

export class GoogleCalendarSource implements CalendarSource {
  readonly #o: GoogleCalendarOptions;
  readonly #fetch: Fetch;
  readonly #baseUrl: string;
  constructor(options: GoogleCalendarOptions) {
    this.#o = options;
    this.#fetch = options.fetch ?? defaultFetch;
    this.#baseUrl = options.baseUrl ?? CALENDAR_API;
  }

  async changes(syncToken: string | null): Promise<{ upserts: ExternalEvent[]; deletedExternalIds: string[]; nextSyncToken: string | null }> {
    try {
      return await this.#list(syncToken);
    } catch (error) {
      // 410 Gone: the sync token expired; Google says to start again with a full sync.
      if (error instanceof IntegrationError && error.status === 410 && syncToken !== null) return this.#list(null);
      throw error;
    }
  }

  async #list(syncToken: string | null) {
    const upserts: ExternalEvent[] = [];
    const deletedExternalIds: string[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    do {
      const url = new URL(`${this.#baseUrl}/calendars/${encodeURIComponent(this.#o.calendarId)}/events`);
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
        if (item.status === "cancelled") deletedExternalIds.push(item.id);
        else {
          const event = this.toExternal(item);
          if (event !== null) upserts.push(event);
        }
      }
      pageToken = page.nextPageToken;
      nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    } while (pageToken !== undefined);
    return { upserts, deletedExternalIds, nextSyncToken };
  }

  /** Map one Google event using the conventions at the top of this file. */
  toExternal(item: GoogleEvent): ExternalEvent | null {
    const start = this.#instant(item.start);
    const end = this.#instant(item.end);
    if (start === null || end === null) return null;
    const description = item.description ?? "";
    const summary = item.summary ?? "(no title)";
    const emails = [item.organizer?.email, ...(item.attendees ?? []).filter((a) => a.responseStatus !== "declined").map((a) => a.email)];
    const attendees: string[] = [];
    for (const email of emails) {
      if (email === undefined) continue;
      const person = this.#o.personForEmail(email.toLowerCase());
      if (person !== null && !attendees.includes(person)) attendees.push(person);
    }
    const home = /#home\b/i.test(description);
    const work = /#work\b/i.test(`${summary} ${description}`) || (this.#o.workCalendarIds ?? []).includes(this.#o.calendarId);
    const solo = /#solo:([a-z0-9_-]+)/i.exec(description)?.[1]?.toLowerCase() ?? null;
    return {
      externalId: item.id,
      title: summary,
      start: start.toISOString(),
      end: end.toISOString(),
      allDay: item.start?.date !== undefined,
      attendees,
      away: home ? [] : [...attendees],
      work,
      soloWithKids: solo,
    };
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
 * CH-6: Google's push notifications for one calendar. `open` is `events.watch`, which creates a
 * notification channel, not an event; Google then calls `address` with `token` echoed in
 * X-Goog-Channel-Token. `close` is `channels.stop`. Neither can create, move or delete an event (PRV-1).
 */
export class GoogleCalendarPush implements CalendarPush {
  readonly #o: { calendarId: string; getAccessToken: () => Promise<string>; baseUrl: string; fetch: Fetch };
  constructor(options: { calendarId: string; getAccessToken: () => Promise<string>; baseUrl?: string; fetch?: Fetch }) {
    this.#o = { calendarId: options.calendarId, getAccessToken: options.getAccessToken, baseUrl: options.baseUrl ?? CALENDAR_API, fetch: options.fetch ?? defaultFetch };
  }

  async open(channel: { id: string; address: string; token: string }): Promise<{ resourceId: string; expiresAt: string }> {
    const response = await this.#post(`/calendars/${encodeURIComponent(this.#o.calendarId)}/events/watch`, { id: channel.id, type: "web_hook", address: channel.address, token: channel.token });
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
