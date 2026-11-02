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
  zReminderCancelInput,
  zReminderChangeInput,
  zReminderDoneInput,
  zReminderMoveInput,
  zRemindersToBacklogInput,
  zRemindInput,
  zUpcomingRemindersInput,
} from "@household/contracts";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso } from "../../db/map.ts";
import { actingPerson, type Actor, actorProcedure, forbid, logDeleted, personProcedure, readProcedure, router, systemProcedure } from "../../trpc.ts";
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

/**
 * HOU-174: a change a person asked for to a reminder, with who asked and who set it. The change itself
 * is the person acting (PRV-1), whether they tapped it or said it to the house.
 */
function logReminderChange(change: "retimed" | "cancelled" | "done" | "moved", r: Reminder, by: string, to: Pick<Reminder, "date" | "time"> | null): void {
  console.info(JSON.stringify({ event: "reminder-changed-by-person", change, id: r.id, by, askedBy: r.askedBy, from: { date: r.date, time: r.time }, to }));
}

/** HOU-174: only a person, or a job acting on the message that person sent, may change or cancel a reminder. */
function askingPerson(actor: Actor, sourceMessage: string): string {
  const person = actingPerson(actor);
  if (person === null) forbid("PRV-1: only a person can change a reminder");
  if (actor.kind === ActorKind.agent && actor.message !== sourceMessage) forbid("PRV-1: a job can only change a reminder from the message it is handling");
  return person;
}

export function backlogRouter(db: BacklogDb) {
  const reminderRow = async (id: string) => {
    const row = await db.query.reminders.findFirst({ where: eq(schema.reminders.id, id) });
    if (row === undefined) forbid(`no reminder ${id}`);
    return row;
  };
  /** CAP-10: open reminders matching `when`, by day and time. HOU-177: or only the closed ones. */
  const openReminders = async (when: SQL | undefined, closed = false) =>
    (
      await db
        .select()
        .from(schema.reminders)
        .where(and(closed ? ne(schema.reminders.status, ReminderStatus.open) : eq(schema.reminders.status, ReminderStatus.open), when))
        .orderBy(asc(schema.reminders.date), asc(schema.reminders.time), asc(schema.reminders.createdAt))
    ).map(toReminder);
  const setReminder = async (ctx: { publish: (t: "backlog") => void }, id: string, values: Partial<typeof schema.reminders.$inferInsert>) => {
    const [row] = await db.update(schema.reminders).set(values).where(eq(schema.reminders.id, id)).returning();
    if (row === undefined) throw new Error("update failed");
    ctx.publish("backlog");
    return toReminder(row);
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
      .query(async ({ input }) => openReminders(and(gte(schema.reminders.date, input.from), lte(schema.reminders.date, input.to)))),

    getReminder: readProcedure.input(zIdInput).output(zReminder.nullable()).query(async ({ input }) => {
      const row = await db.query.reminders.findFirst({ where: eq(schema.reminders.id, input.id) });
      return row === undefined ? null : toReminder(row);
    }),

    /**
     * CAP-10: Done, because a person tapped it. HOU-177: only a person, or a job acting on the message they
     * sent (PRV-1), never the system or a job handling another message. Logged with who.
     */
    reminderDone: actorProcedure.input(zReminderDoneInput).output(zReminder).mutation(async ({ ctx, input }) => {
      const by = askingPerson(ctx.actor, input.sourceMessage);
      const reminder = toReminder(await reminderRow(input.id));
      if (reminder.status !== ReminderStatus.open) return reminder;
      const done = await setReminder(ctx, input.id, { status: ReminderStatus.done, doneAt: ctx.now });
      logReminderChange("done", reminder, by, null);
      return done;
    }),

    /**
     * CAP-10: "Not now" (or "Later" on a message) moves an open reminder to another day; its time stays.
     * HOU-177: only for a person, as reminderDone. Logged with who.
     */
    moveReminder: actorProcedure.input(zReminderMoveInput).output(zReminder).mutation(async ({ ctx, input }) => {
      const by = askingPerson(ctx.actor, input.sourceMessage);
      const reminder = toReminder(await reminderRow(input.id));
      if (reminder.status !== ReminderStatus.open) return reminder;
      const moved = await setReminder(ctx, input.id, { date: input.date });
      logReminderChange("moved", reminder, by, { date: moved.date, time: moved.time });
      return moved;
    }),

    /** HOU-174: open reminders from a day on, by day and time: the ones a person could still change. */
    upcomingReminders: readProcedure
      .input(zUpcomingRemindersInput)
      .output(z.array(zReminder))
      .query(async ({ input }) => openReminders(gte(schema.reminders.date, input.from), input.closed === true)),

    /**
     * HOU-174: a new day or time for an open reminder, because a person asked (PRV-1). Logged with who
     * asked. A reminder already done, moved or cancelled is left as it is.
     */
    changeReminder: actorProcedure.input(zReminderChangeInput).output(zReminder).mutation(async ({ ctx, input }) => {
      const by = askingPerson(ctx.actor, input.sourceMessage);
      const reminder = toReminder(await reminderRow(input.id));
      if (reminder.status !== ReminderStatus.open) return reminder;
      const changed = await setReminder(ctx, input.id, { date: input.date, time: input.time });
      logReminderChange("retimed", reminder, by, { date: changed.date, time: changed.time });
      return changed;
    }),

    /** HOU-174: cancel an open reminder because a person asked (PRV-1). Logged with who asked. */
    cancelReminder: actorProcedure.input(zReminderCancelInput).output(zReminder).mutation(async ({ ctx, input }) => {
      const by = askingPerson(ctx.actor, input.sourceMessage);
      const reminder = toReminder(await reminderRow(input.id));
      if (reminder.status !== ReminderStatus.open) return reminder;
      const cancelled = await setReminder(ctx, input.id, { status: ReminderStatus.cancelled });
      logReminderChange("cancelled", reminder, by, null);
      return cancelled;
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
