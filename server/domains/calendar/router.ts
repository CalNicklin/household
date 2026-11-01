import { type CalendarWatch, zCalendarEvent, zCalendarSyncInput, zCalendarSyncOutput, zCalendarWatch, zDateRangeInput, zRecordWatchInput } from "@household/contracts";
import { and, desc, eq, gt, inArray, isNull, lt, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso, isoOrNull } from "../../db/map.ts";
import { readProcedure, router, systemProcedure } from "../../trpc.ts";
import { mergeCopies, type StoredCopy } from "./merge.ts";
import * as schema from "./schema.ts";

export type CalendarDb = DomainDb<typeof schema>;

const toCopy = (r: typeof schema.events.$inferSelect): StoredCopy => ({
  id: r.id,
  externalId: r.externalId,
  calendarId: r.calendarId,
  owner: r.owner,
  uid: r.uid,
  busy: r.busy,
  title: r.title,
  start: iso(r.start),
  end: iso(r.end),
  allDay: r.allDay,
  attendees: r.attendees,
  away: r.away,
  work: r.work,
  soloWithKids: r.soloWithKids,
});

const toWatch = (w: typeof schema.watches.$inferSelect): CalendarWatch => ({
  channelId: w.channelId,
  calendarId: w.calendarId,
  resourceId: w.resourceId,
  address: w.address,
  expiresAt: iso(w.expiresAt),
  openedAt: iso(w.openedAt),
  closedAt: isoOrNull(w.closedAt),
});

const datesTouched = (start: Date, end: Date, timeZone: string): string[] => {
  const out = new Set<string>();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  for (let t = start.getTime(); t < end.getTime(); t += 3_600_000) out.add(fmt.format(new Date(t)));
  out.add(fmt.format(start));
  return [...out];
};

/**
 * The calendar copy. Only calendar sync (the system actor) writes it, and only from Google; there
 * is no procedure that creates, moves or deletes an event in Google (PRV-1).
 */
export function calendarRouter(db: CalendarDb, timeZone: string) {
  return router({
    /** HOME-1: events overlapping the range, each copy on several calendars read back as one event. */
    between: readProcedure.input(zDateRangeInput).output(z.array(zCalendarEvent)).query(async ({ input }) =>
      mergeCopies((await db.select().from(schema.events).where(and(lt(schema.events.start, new Date(input.to)), gt(schema.events.end, new Date(input.from))))).map(toCopy)),
    ),
    /** CH-6: the push channels in use (not closed), newest first; one per calendar once the house has checked. */
    watches: readProcedure.output(z.array(zCalendarWatch)).query(async () => (await db.select().from(schema.watches).where(isNull(schema.watches.closedAt)).orderBy(desc(schema.watches.openedAt))).map(toWatch)),
    recordWatch: systemProcedure.input(zRecordWatchInput).mutation(async ({ input }) => {
      await db.insert(schema.watches).values({ ...input, expiresAt: new Date(input.expiresAt), openedAt: new Date(input.openedAt) });
    }),
    /** CH-6: the house closed this channel (replaced, or its calendar is no longer read). */
    closeWatch: systemProcedure.input(z.object({ channelId: z.string() })).mutation(async ({ ctx, input }) => {
      await db.update(schema.watches).set({ closedAt: ctx.now }).where(eq(schema.watches.channelId, input.channelId));
    }),
    /** Each calendar's sync token from the last sync; a calendar missing here has never been read. */
    syncTokens: readProcedure.output(z.record(z.string(), z.string())).query(async () => (await db.query.syncs.findFirst({ orderBy: desc(schema.syncs.at) }))?.syncTokens ?? {}),

    /** CH-6: apply a sync and report exactly which local days changed, so only those are re-planned. */
    applySync: systemProcedure.input(zCalendarSyncInput).output(zCalendarSyncOutput).mutation(async ({ ctx, input }) => {
      const changed = new Set<string>();
      const touch = (start: Date, end: Date) => {
        for (const d of datesTouched(start, end, timeZone)) changed.add(d);
      };
      const externalIds = [...input.upserts.map((u) => u.externalId), ...input.deletedExternalIds];
      const before = externalIds.length === 0 ? [] : await db.select().from(schema.events).where(inArray(schema.events.externalId, externalIds));
      const beforeById = new Map(before.map((b) => [b.externalId, b]));
      const [sync] = await db.insert(schema.syncs).values({ syncTokens: input.syncTokens, at: ctx.now }).returning();
      for (const u of input.upserts) {
        const prev = beforeById.get(u.externalId);
        const same =
          prev !== undefined &&
          prev.calendarId === u.calendarId &&
          prev.owner === u.owner &&
          prev.uid === u.uid &&
          prev.busy === u.busy &&
          prev.title === u.title &&
          iso(prev.start) === u.start &&
          iso(prev.end) === u.end &&
          prev.allDay === u.allDay &&
          prev.attendees.join() === u.attendees.join() &&
          prev.away.join() === u.away.join() &&
          prev.work === u.work &&
          prev.soloWithKids === u.soloWithKids;
        if (same) continue;
        if (prev !== undefined) touch(prev.start, prev.end);
        touch(new Date(u.start), new Date(u.end));
        const values = { ...u, start: new Date(u.start), end: new Date(u.end), syncId: sync?.id ?? null };
        await db.insert(schema.events).values(values).onConflictDoUpdate({ target: schema.events.externalId, set: values });
      }
      for (const ext of input.deletedExternalIds) {
        const prev = beforeById.get(ext);
        if (prev === undefined) continue;
        touch(prev.start, prev.end);
        await db.delete(schema.events).where(eq(schema.events.externalId, ext));
      }
      // A calendar the house no longer reads is dropped. Copies from before calendars were recorded
      // (calendar_id '') go only once every calendar has been read, so a failed read never empties the screen.
      const gone = input.complete ? input.calendarIds : [...input.calendarIds, ""];
      const stale = await db.delete(schema.events).where(notInArray(schema.events.calendarId, gone)).returning();
      for (const s of stale) touch(s.start, s.end);
      const changedDates = [...changed].sort();
      if (sync !== undefined) await db.update(schema.syncs).set({ changedDates }).where(eq(schema.syncs.id, sync.id));
      if (changedDates.length > 0) ctx.publish("plan");
      return { changedDates };
    }),
  });
}
