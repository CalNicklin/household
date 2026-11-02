import {
  ActorKind,
  type BacklogItem,
  BacklogStatus,
  DeletedThing,
  Limits,
  type Reminder,
  ReminderStatus,
  zBacklogCreateInput,
  zBacklogItem,
  zBacklogSetTagsInput,
  zIdInput,
  zLocalDateRangeInput,
  zPersonInput,
  zReminder,
  zReminderMoveInput,
  zRemindersToBacklogInput,
  zRemindInput,
} from "@household/contracts";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte } from "drizzle-orm";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso } from "../../db/map.ts";
import { actingPerson, actorProcedure, forbid, logDeleted, personProcedure, readProcedure, router, systemProcedure } from "../../trpc.ts";
import * as schema from "./schema.ts";

export type BacklogDb = DomainDb<typeof schema>;

const toItem = (r: typeof schema.items.$inferSelect): BacklogItem => ({
  id: r.id,
  text: r.text,
  tags: r.tags,
  confirmedTags: r.confirmedTags,
  status: r.status,
  notNowCount: r.notNowCount,
  createdBy: r.createdBy,
  createdVia: r.createdVia,
  createdAt: iso(r.createdAt),
});

const toReminder = (r: typeof schema.reminders.$inferSelect): Reminder => ({
  id: r.id,
  text: r.text,
  for: r.for,
  date: r.date,
  time: r.time,
  askedBy: r.askedBy,
  createdVia: r.createdVia,
  status: r.status,
  createdAt: iso(r.createdAt),
});

export function backlogRouter(db: BacklogDb) {
  const reminderRow = async (id: string) => {
    const row = await db.query.reminders.findFirst({ where: eq(schema.reminders.id, id) });
    if (row === undefined) forbid(`no reminder ${id}`);
    return row;
  };
  const get = async (id: string) => {
    const row = await db.query.items.findFirst({ where: eq(schema.items.id, id) });
    if (row === undefined) forbid(`no backlog item ${id}`);
    return row;
  };
  const update = async (ctx: { publish: (t: "backlog") => void }, id: string, values: Partial<typeof schema.items.$inferInsert>) => {
    const [row] = await db.update(schema.items).set(values).where(eq(schema.items.id, id)).returning();
    if (row === undefined) throw new Error("update failed");
    ctx.publish("backlog");
    return toItem(row);
  };
  return router({
    list: readProcedure.output(z.array(zBacklogItem)).query(async () => (await db.select().from(schema.items).orderBy(desc(schema.items.createdAt))).map(toItem)),

    get: readProcedure.input(zIdInput).output(zBacklogItem.nullable()).query(async ({ input }) => {
      const row = await db.query.items.findFirst({ where: eq(schema.items.id, input.id) });
      return row === undefined ? null : toItem(row);
    }),

    /**
     * CAP-1. A job may create an item only from the person's own message (PRV-1): the author is
     * the person who said it and the source message must be the one the job is handling.
     */
    create: actorProcedure
      .input(zBacklogCreateInput)
      .output(zBacklogItem)
      .mutation(async ({ ctx, input }) => {
        const author = actingPerson(ctx.actor);
        if (author === null) forbid("PRV-1: a backlog item must be written by a person");
        if (ctx.actor.kind === ActorKind.agent && ctx.actor.message !== input.sourceMessage) forbid("PRV-1: a job can only capture the message it is handling");
        // One message can capture several jobs; a retried job (whose model may word them differently)
        // finds each again by its position, so nothing is written twice (HOU-148).
        const index = input.index ?? 0;
        const key = index === 0 ? input.sourceMessage : `${input.sourceMessage}#${index}`;
        const existing = await db.query.items.findFirst({ where: eq(schema.items.sourceMessage, key) });
        if (existing !== undefined) return toItem(existing);
        const [row] = await db
          .insert(schema.items)
          .values({ text: input.text, tags: [...new Set(input.tags)], createdBy: author, createdVia: input.createdVia, sourceMessage: key, createdAt: ctx.now })
          .returning();
        if (row === undefined) throw new Error("insert failed");
        ctx.publish("backlog");
        return toItem(row);
      }),

    /** CAP-3: one tap fixes a wrong tag. Only a person can change tags. */
    setTags: personProcedure.input(zBacklogSetTagsInput).output(zBacklogItem).mutation(async ({ ctx, input }) => {
      await get(input.id);
      return update(ctx, input.id, { tags: [...new Set(input.tags)], confirmedTags: true });
    }),

    /** CAP-5: the third "not now" parks it. Recorded for the person who tapped. */
    notNow: actorProcedure.input(zIdInput).output(zBacklogItem).mutation(async ({ ctx, input }) => {
      const person = actingPerson(ctx.actor);
      if (person === null) forbid("needs a person");
      const item = await get(input.id);
      await db.insert(schema.notNows).values({ itemId: item.id, person, createdAt: ctx.now });
      const count = item.notNowCount + 1;
      // limit: notNowParkThreshold
      const parked = count >= Limits.notNowParkThreshold.value;
      const [row] = await db
        .update(schema.items)
        .set({ notNowCount: count, status: parked ? BacklogStatus.parked : item.status })
        .where(eq(schema.items.id, item.id))
        .returning();
      if (row === undefined) throw new Error("update failed");
      ctx.publish("backlog");
      return toItem(row);
    }),

    markDone: actorProcedure.input(zIdInput).output(zBacklogItem).mutation(async ({ ctx, input }) => {
      await get(input.id);
      return update(ctx, input.id, { status: BacklogStatus.done, doneAt: ctx.now });
    }),

    /** CAP-5: until you bring it back. */
    bringBack: personProcedure.input(zIdInput).output(zBacklogItem).mutation(async ({ ctx, input }) => {
      await get(input.id);
      return update(ctx, input.id, { status: BacklogStatus.active, notNowCount: 0 });
    }),

    /**
     * Only a person can delete a backlog item (PRV-1), any adult's, from the app (HOU-158). It is gone
     * from the backlog at once and from today's plan when it is next drawn. Logged with who did it.
     */
    remove: personProcedure.input(zIdInput).mutation(async ({ ctx, input }) => {
      const [row] = await db.delete(schema.items).where(eq(schema.items.id, input.id)).returning();
      if (row === undefined) return;
      logDeleted(DeletedThing.backlogItem, row.id, ctx.actor.person, row.createdBy);
      ctx.publish("backlog");
    }),

    /**
     * CAP-10: a reminder someone asked for. As with a capture (PRV-1), a job may write one only from the
     * person's own message, as that person; a retried job finds it again by its position.
     */
    remind: actorProcedure
      .input(zRemindInput)
      .output(zReminder)
      .mutation(async ({ ctx, input }) => {
        const author = actingPerson(ctx.actor);
        if (author === null) forbid("PRV-1: a reminder must be asked for by a person");
        if (ctx.actor.kind === ActorKind.agent && ctx.actor.message !== input.sourceMessage) forbid("PRV-1: a job can only set a reminder from the message it is handling");
        const index = input.index ?? 0;
        const key = index === 0 ? input.sourceMessage : `${input.sourceMessage}#${index}`;
        const existing = await db.query.reminders.findFirst({ where: eq(schema.reminders.sourceMessage, key) });
        if (existing !== undefined) return toReminder(existing);
        const [row] = await db
          .insert(schema.reminders)
          .values({ text: input.text, for: [...new Set(input.for)], date: input.date, time: input.time, askedBy: author, createdVia: input.createdVia, sourceMessage: key, createdAt: ctx.now })
          .returning();
        if (row === undefined) throw new Error("insert failed");
        ctx.publish("backlog");
        return toReminder(row);
      }),

    /** CAP-10: open reminders on the days from `from` to `to`, by day and time. */
    reminders: readProcedure
      .input(zLocalDateRangeInput)
      .output(z.array(zReminder))
      .query(async ({ input }) =>
        (
          await db
            .select()
            .from(schema.reminders)
            .where(and(eq(schema.reminders.status, ReminderStatus.open), gte(schema.reminders.date, input.from), lte(schema.reminders.date, input.to)))
            .orderBy(asc(schema.reminders.date), asc(schema.reminders.time), asc(schema.reminders.createdAt))
        ).map(toReminder),
      ),

    getReminder: readProcedure.input(zIdInput).output(zReminder.nullable()).query(async ({ input }) => {
      const row = await db.query.reminders.findFirst({ where: eq(schema.reminders.id, input.id) });
      return row === undefined ? null : toReminder(row);
    }),

    /** CAP-10: Done, by a person or a job acting for one. */
    reminderDone: actorProcedure.input(zIdInput).output(zReminder).mutation(async ({ ctx, input }) => {
      await reminderRow(input.id);
      const [row] = await db.update(schema.reminders).set({ status: ReminderStatus.done, doneAt: ctx.now }).where(eq(schema.reminders.id, input.id)).returning();
      if (row === undefined) throw new Error("update failed");
      ctx.publish("backlog");
      return toReminder(row);
    }),

    /** CAP-10: "Not now" (or "Later" on a message) moves an open reminder to another day; its time stays. */
    moveReminder: actorProcedure.input(zReminderMoveInput).output(zReminder).mutation(async ({ ctx, input }) => {
      const reminder = await reminderRow(input.id);
      if (reminder.status !== ReminderStatus.open) return toReminder(reminder);
      const [row] = await db.update(schema.reminders).set({ date: input.date }).where(eq(schema.reminders.id, input.id)).returning();
      if (row === undefined) throw new Error("update failed");
      ctx.publish("backlog");
      return toReminder(row);
    }),

    /**
     * CAP-10: a reminder with no time stays on Today for the rest of its day; one still open after that
     * becomes a backlog item (CAP-1/CAP-2) with the same text, written by whoever asked for it.
     */
    remindersToBacklog: systemProcedure
      .input(zRemindersToBacklogInput)
      .output(z.array(zBacklogItem))
      .mutation(async ({ ctx, input }) => {
        const due = await db
          .select()
          .from(schema.reminders)
          .where(and(eq(schema.reminders.status, ReminderStatus.open), isNull(schema.reminders.time), lt(schema.reminders.date, input.today)));
        const moved: BacklogItem[] = [];
        for (const r of due) {
          const item = await db.transaction(async (tx) => {
            const [row] = await tx
              .insert(schema.items)
              .values({ text: r.text, tags: [], createdBy: r.askedBy, createdVia: r.createdVia, sourceMessage: `reminder:${r.id}`, createdAt: ctx.now })
              .returning();
            if (row === undefined) throw new Error("insert failed");
            await tx.update(schema.reminders).set({ status: ReminderStatus.moved, itemId: row.id }).where(eq(schema.reminders.id, r.id));
            return row;
          });
          moved.push(toItem(item));
        }
        if (due.length > 0) ctx.publish("backlog");
        return moved;
      }),

    /** PRV-7. */
    exportPerson: systemProcedure.input(zPersonInput).query(async ({ input }) => ({
      items: (await db.select().from(schema.items).where(eq(schema.items.createdBy, input.person))).map(toItem),
      notNows: await db.select().from(schema.notNows).where(eq(schema.notNows.person, input.person)),
      reminders: (await db.select().from(schema.reminders).where(eq(schema.reminders.askedBy, input.person))).map(toReminder),
    })),
    deletePerson: systemProcedure.input(zPersonInput).mutation(async ({ input }) => {
      await db.delete(schema.notNows).where(eq(schema.notNows.person, input.person));
      await db.delete(schema.reminders).where(eq(schema.reminders.askedBy, input.person));
      const mine = await db.select({ id: schema.items.id }).from(schema.items).where(eq(schema.items.createdBy, input.person));
      if (mine.length > 0) await db.delete(schema.items).where(and(inArray(schema.items.id, mine.map((m) => m.id))));
    }),
  });
}
