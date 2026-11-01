import { randomUUID } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { AttachmentKind, type CalendarWatch, Channel } from "@household/contracts";
import { z } from "zod";
import { calendars as practiceCalendars } from "../../../practice/data.ts";
import { PracticeCalendar } from "../../../practice/fakes.ts";
import { accept, type Accepted } from "../../coordinator/accept.ts";
import { type CalendarNotification, parseCalendarNotification } from "../../integrations/google-calendar.ts";
import type { CalendarPush } from "../../ports.ts";
import type { Runtime } from "../../runtime.ts";
import { localDate } from "../../time.ts";
import type { Adapter } from "../registry.ts";

/**
 * A Google Calendar push notification becomes a message (CH-6). The channel token is the shared
 * secret (PRV-6); channel + message number is the duplicate-check key, so a webhook that fires
 * again is one job (CH-4). The job syncs and re-plans only the days that changed.
 */
export async function calendarChanged(rt: Runtime, n: CalendarNotification): Promise<Accepted | null> {
  if (n.state === "sync") return null;
  return accept(rt, {
    household: rt.env.HOUSEHOLD_ID,
    person: null,
    channel: Channel.webhook,
    text: "calendar changed",
    attachments: [{ kind: AttachmentKind.calendarChange, resourceState: n.state }],
    dedupeKey: `calendar:${n.channelId}:${n.messageNumber}`,
    receivedAt: rt.ports.clock.now().toISOString(),
  });
}

/**
 * Renew a channel this long before Google stops it. A day, so the hourly check (below) can miss most
 * of a day's runs, e.g. the house being down for a deploy, and the channel still never lapses.
 */
export const WATCH_RENEW_BEFORE_MS = 24 * 3_600_000;
/** CH-6: the hourly check that the channel is open, at a minute none of the house's timers use. */
export const WATCH_CHECK_CRON = "17 * * * *";

export type WatchOutcome =
  | { calendarId: string; action: "kept"; expiresAt: string }
  | { calendarId: string; action: "opened"; expiresAt: string; replaced: string | null }
  | { calendarId: string; action: "failed"; error: string };

export type WatchCheck = { action: "no-push" } | { action: "checked"; calendars: WatchOutcome[]; closed: string[]; syncJobId: string | null };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * CH-6: keep one channel open on one calendar. With none, or one that ends within WATCH_RENEW_BEFORE_MS,
 * or one pointing at another address, open a new one, record it, and close the old one.
 */
async function ensureWatch(rt: Runtime, push: CalendarPush, calendarId: string, current: CalendarWatch | undefined, address: string): Promise<WatchOutcome> {
  const api = rt.system("calendar-watch");
  const now = rt.ports.clock.now();
  if (current !== undefined && current.address === address && new Date(current.expiresAt).getTime() - now.getTime() > WATCH_RENEW_BEFORE_MS) return { calendarId, action: "kept", expiresAt: current.expiresAt };
  const id = randomUUID();
  const opened = await push.open(calendarId, { id, address, token: rt.env.CALENDAR_WEBHOOK_TOKEN });
  try {
    await api.calendar.recordWatch({ channelId: id, calendarId, resourceId: opened.resourceId, address, expiresAt: opened.expiresAt, openedAt: now.toISOString() });
  } catch (error) {
    // A channel the house has no record of would never be renewed or closed: close it now (best effort).
    await push.close({ id, resourceId: opened.resourceId }).catch(() => undefined);
    throw error;
  }
  if (current !== undefined) await closeWatch(rt, push, current);
  return { calendarId, action: "opened", expiresAt: opened.expiresAt, replaced: current?.channelId ?? null };
}

/**
 * Best effort: an old channel that can't be closed ends by itself at its expiry, and its notifications
 * only cause a sync that finds nothing new. Either way the house no longer counts it as in use.
 */
async function closeWatch(rt: Runtime, push: CalendarPush, w: CalendarWatch): Promise<void> {
  try {
    await push.close({ id: w.channelId, resourceId: w.resourceId });
  } catch (error) {
    console.warn(JSON.stringify({ event: "calendar-watch-close-failed", channelId: w.channelId, error: errorText(error) }));
  }
  await rt.system("calendar-watch").calendar.closeWatch({ channelId: w.channelId });
}

/**
 * CH-6 / HOME-1: keep one Google push channel open on each calendar the house reads (opened, renewed
 * and replaced as above), and close any channel on a calendar it no longer reads. One calendar that
 * fails (not shared with this account yet, say) doesn't stop the others; it is tried again next hour.
 * Then sync once if a channel was opened or a calendar has never been read: it may have changed while
 * no channel was open. Opening a channel is a subscription, never a change to a calendar (PRV-1).
 */
export async function ensureWatches(rt: Runtime): Promise<WatchCheck> {
  const push = rt.ports.calendarPush;
  if (push === undefined) return { action: "no-push" };
  const api = rt.system("calendar-watch");
  const address = `${rt.env.PUBLIC_URL.replace(/\/+$/, "")}/webhooks/calendar`;
  const inUse = await api.calendar.watches();
  const outcomes: WatchOutcome[] = [];
  const closed: string[] = [];
  for (const calendarId of push.calendarIds) {
    // Newest first: the first is current; any older one still open is closed.
    const [current, ...older] = inUse.filter((w) => w.calendarId === calendarId);
    for (const w of older) {
      await closeWatch(rt, push, w);
      closed.push(w.channelId);
    }
    try {
      outcomes.push(await ensureWatch(rt, push, calendarId, current, address));
    } catch (error) {
      outcomes.push({ calendarId, action: "failed", error: errorText(error) });
    }
  }
  for (const w of inUse.filter((x) => !push.calendarIds.includes(x.calendarId))) {
    await closeWatch(rt, push, w);
    closed.push(w.channelId);
  }
  const opened = outcomes.find((o) => o.action === "opened");
  const synced = await api.calendar.syncTokens();
  const neverRead = push.calendarIds.filter((id) => synced[id] === undefined);
  const now = rt.ports.clock.now();
  let syncJobId: string | null = null;
  if (opened !== undefined) {
    // Dedupe key `calendar:opened:<time>`: one sync per check that opened a channel.
    syncJobId = (await calendarChanged(rt, { channelId: "opened", messageNumber: now.toISOString(), token: rt.env.CALENDAR_WEBHOOK_TOKEN, state: "exists" }))?.jobId ?? null;
  } else if (neverRead.length > 0) {
    // A calendar never read (not shared yet, say) is tried once a day, not every hour:
    // dedupe key `calendar:never-read:<calendars>:<local date>`.
    const day = localDate(now, rt.timeZone);
    const accepted = await calendarChanged(rt, { channelId: "never-read", messageNumber: `${neverRead.join(",")}:${day}`, token: rt.env.CALENDAR_WEBHOOK_TOKEN, state: "exists" });
    syncJobId = accepted === null || accepted.duplicate ? null : accepted.jobId;
  }
  return { action: "checked", calendars: outcomes, closed, syncJobId };
}

async function checkWatch(rt: Runtime): Promise<void> {
  try {
    const check = await ensureWatches(rt);
    if (check.action === "no-push") return;
    for (const o of check.calendars) {
      if (o.action === "failed") console.error(JSON.stringify({ event: "calendar-watch-failed", ...o }));
      else console.log(JSON.stringify({ event: "calendar-watch", ...o }));
    }
    if (check.closed.length > 0 || check.syncJobId !== null) console.log(JSON.stringify({ event: "calendar-watch", closed: check.closed, syncJobId: check.syncJobId }));
  } catch (error) {
    // Logged, not thrown: the next hourly check tries again, and nothing else in the house waits on it.
    console.error(JSON.stringify({ event: "calendar-watch-failed", error: errorText(error) }));
  }
}

let runtime: Runtime | null = null;

const watchCheck = DBOS.registerWorkflow(
  async () => {
    const rt = runtime;
    if (rt === null) throw new Error("calendar adapter not started");
    await DBOS.runStep(() => checkWatch(rt), { name: "ensure-watch" });
  },
  { name: "calendarWatchCheck" },
);

const zPracticeEvent = z.object({
  externalId: z.string(),
  /** Whose practice calendar the copy is on (practice/data.ts `calendars`); the shared one by default. */
  calendar: z
    .string()
    .refine((owner) => practiceCalendars.some((c) => c.owner === owner), "not a practice calendar")
    .optional(),
  uid: z.string().optional(),
  title: z.string(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  allDay: z.boolean().default(false),
  attendees: z.array(z.string()).default([]),
  away: z.array(z.string()).default([]),
  work: z.boolean().default(false),
  soloWithKids: z.string().nullable().default(null),
});
const zPracticeEdit = z.object({ upsert: zPracticeEvent.optional(), remove: z.string().optional() });

let practiceMessageNumber = 0;

export const adapter: Adapter = {
  name: "calendar",
  start: async (rt) => {
    runtime = rt;
    if (rt.ports.calendarPush === undefined) return;
    await DBOS.applySchedules([{ scheduleName: "household:calendar-watch", workflowFn: watchCheck, schedule: WATCH_CHECK_CRON, cronTimezone: rt.timeZone, automaticBackfill: false }]);
    // Not awaited: the server starts listening (and passes its healthcheck) whatever Google is doing.
    void checkWatch(rt);
  },
  routes: (app, rt) => {
    app.post("/webhooks/calendar", async (c) => {
      const n = parseCalendarNotification(c.req.raw.headers);
      if (n === null || n.token !== rt.env.CALENDAR_WEBHOOK_TOKEN) return c.json({ error: "bad token" }, 401);
      const accepted = await calendarChanged(rt, n);
      return c.json({ ok: true, jobId: accepted?.jobId ?? null });
    });
  },
  privateRoutes: (app, rt) => {
    if (!rt.env.PRACTICE) return;
    /** Practice only: "someone changed Google Calendar" — edit the practice calendar, then the same webhook path runs. */
    app.post("/api/practice/calendar", async (c) => {
      const calendar = rt.ports.calendar;
      if (!(calendar instanceof PracticeCalendar)) return c.json({ error: "not the practice calendar" }, 400);
      const edit = zPracticeEdit.parse(await c.req.json());
      if (edit.upsert !== undefined) calendar.upsert(edit.upsert);
      if (edit.remove !== undefined) calendar.remove(edit.remove);
      practiceMessageNumber += 1;
      const accepted = await calendarChanged(rt, { channelId: "practice", token: rt.env.CALENDAR_WEBHOOK_TOKEN, state: "exists", messageNumber: `${Date.now()}-${practiceMessageNumber}` });
      return c.json({ ok: true, jobId: accepted?.jobId ?? null });
    });
  },
};
