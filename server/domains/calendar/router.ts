import { type CalendarEvent, type CalendarWatch, zCalendarEvent, zCalendarSyncInput, zCalendarSyncOutput, zCalendarWatch, zDateRangeInput } from "@household/contracts";
import { and, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso } from "../../db/map.ts";
import { readProcedure, router, systemProcedure } from "../../trpc.ts";
import * as schema from "./schema.ts";

export type CalendarDb = DomainDb<typeof schema>;

const toEvent = (r: typeof schema.events.$inferSelect): CalendarEvent => ({
  id: r.id,
  externalId: r.externalId,
  title: r.title,
  start: iso(r.start),
  end: iso(r.end),
  allDay: r.allDay,
  attendees: r.attendees,
  away: r.away,
  work: r.work,
  soloWithKids: r.soloWithKids,
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
    between: readProcedure.input(zDateRangeInput).output(z.array(zCalendarEvent)).query(async ({ input }) =>
      (await db.select().from(schema.events).where(and(lt(schema.events.start, new Date(input.to)), gt(schema.events.end, new Date(input.from)))).orderBy(schema.events.start)).map(toEvent),
    ),
    /** CH-6: the push channel in use (the newest opened), or null before the first one. */
    watch: readProcedure.output(zCalendarWatch.nullable()).query(async (): Promise<CalendarWatch | null> => {
      const w = await db.query.watches.findFirst({ orderBy: desc(schema.watches.openedAt) });
      return w === undefined ? null : { channelId: w.channelId, calendarId: w.calendarId, resourceId: w.resourceId, address: w.address, expiresAt: iso(w.expiresAt), openedAt: iso(w.openedAt) };
    }),
    recordWatch: systemProcedure.input(zCalendarWatch).mutation(async ({ input }) => {
      await db.insert(schema.watches).values({ ...input, expiresAt: new Date(input.expiresAt), openedAt: new Date(input.openedAt) });
    }),
    syncToken: readProcedure.output(z.string().nullable()).query(async () => (await db.query.syncs.findFirst({ orderBy: desc(schema.syncs.at) }))?.syncToken ?? null),

    /** CH-6: apply a sync and report exactly which local days changed, so only those are re-planned. */
    applySync: systemProcedure.input(zCalendarSyncInput).output(zCalendarSyncOutput).mutation(async ({ ctx, input }) => {
      const changed = new Set<string>();
      const externalIds = [...input.upserts.map((u) => u.externalId), ...input.deletedExternalIds];
      const before = externalIds.length === 0 ? [] : await db.select().from(schema.events).where(inArray(schema.events.externalId, externalIds));
      const beforeById = new Map(before.map((b) => [b.externalId, b]));
      const [sync] = await db.insert(schema.syncs).values({ syncToken: input.syncToken, at: ctx.now }).returning();
      for (const u of input.upserts) {
        const prev = beforeById.get(u.externalId);
        const same =
          prev !== undefined &&
          prev.title === u.title &&
          iso(prev.start) === u.start &&
          iso(prev.end) === u.end &&
          prev.allDay === u.allDay &&
          prev.attendees.join() === u.attendees.join() &&
          prev.away.join() === u.away.join() &&
          prev.work === u.work &&
          prev.soloWithKids === u.soloWithKids;
        if (same) continue;
        if (prev !== undefined) for (const d of datesTouched(prev.start, prev.end, timeZone)) changed.add(d);
        for (const d of datesTouched(new Date(u.start), new Date(u.end), timeZone)) changed.add(d);
        const values = { ...u, start: new Date(u.start), end: new Date(u.end), syncId: sync?.id ?? null };
        await db.insert(schema.events).values(values).onConflictDoUpdate({ target: schema.events.externalId, set: values });
      }
      for (const ext of input.deletedExternalIds) {
        const prev = beforeById.get(ext);
        if (prev === undefined) continue;
        for (const d of datesTouched(prev.start, prev.end, timeZone)) changed.add(d);
        await db.delete(schema.events).where(eq(schema.events.externalId, ext));
      }
      const changedDates = [...changed].sort();
      if (sync !== undefined) await db.update(schema.syncs).set({ changedDates }).where(eq(schema.syncs.id, sync.id));
      if (changedDates.length > 0) ctx.publish("plan");
      return { changedDates };
    }),
  });
}
