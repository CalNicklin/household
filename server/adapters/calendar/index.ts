import { randomUUID } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { AttachmentKind, Channel } from "@household/contracts";
import { z } from "zod";
import { PracticeCalendar } from "../../../practice/fakes.ts";
import { accept, type Accepted } from "../../coordinator/accept.ts";
import { type CalendarNotification, parseCalendarNotification } from "../../integrations/google-calendar.ts";
import type { Runtime } from "../../runtime.ts";
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

export type WatchOutcome = { action: "no-push" } | { action: "kept"; expiresAt: string } | { action: "opened"; expiresAt: string; replaced: string | null; syncJobId: string | null };

/**
 * CH-6 / HOME-1: keep one Google push channel open on the calendar. With none, or one that ends within
 * WATCH_RENEW_BEFORE_MS, or one on another calendar or pointing at another address, open a new one, record it, close the old
 * one, and sync once at once (the calendar may have changed while no channel was open). Opening a channel
 * is a subscription, never a change to the calendar (PRV-1).
 */
export async function ensureWatch(rt: Runtime): Promise<WatchOutcome> {
  const push = rt.ports.calendarPush;
  if (push === undefined) return { action: "no-push" };
  const api = rt.system("calendar-watch");
  const now = rt.ports.clock.now();
  const address = `${rt.env.PUBLIC_URL.replace(/\/+$/, "")}/webhooks/calendar`;
  const current = await api.calendar.watch();
  if (current !== null && current.calendarId === push.calendarId && current.address === address && new Date(current.expiresAt).getTime() - now.getTime() > WATCH_RENEW_BEFORE_MS) return { action: "kept", expiresAt: current.expiresAt };
  const id = randomUUID();
  const opened = await push.open({ id, address, token: rt.env.CALENDAR_WEBHOOK_TOKEN });
  await api.calendar.recordWatch({ channelId: id, calendarId: push.calendarId, resourceId: opened.resourceId, address, expiresAt: opened.expiresAt, openedAt: now.toISOString() });
  if (current !== null) {
    // Best effort: an old channel that can't be closed ends by itself at its expiry, and its
    // notifications only cause a sync that finds nothing new.
    try {
      await push.close({ id: current.channelId, resourceId: current.resourceId });
    } catch (error) {
      console.warn(JSON.stringify({ event: "calendar-watch-close-failed", channelId: current.channelId, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  const sync = await calendarChanged(rt, { channelId: id, token: rt.env.CALENDAR_WEBHOOK_TOKEN, state: "exists", messageNumber: "opened" });
  return { action: "opened", expiresAt: opened.expiresAt, replaced: current?.channelId ?? null, syncJobId: sync?.jobId ?? null };
}

async function checkWatch(rt: Runtime): Promise<void> {
  try {
    const outcome = await ensureWatch(rt);
    if (outcome.action !== "no-push") console.log(JSON.stringify({ event: "calendar-watch", ...outcome }));
  } catch (error) {
    // Logged, not thrown: the next hourly check tries again, and nothing else in the house waits on it.
    console.error(JSON.stringify({ event: "calendar-watch-failed", error: error instanceof Error ? error.message : String(error) }));
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
