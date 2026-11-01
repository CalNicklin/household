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
