import { ActorKind, type BacklogItem, BacklogStatus, Limits, zBacklogCreateInput, zBacklogItem, zBacklogSetTagsInput, zIdInput, zPersonInput } from "@household/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso } from "../../db/map.ts";
import { actingPerson, actorProcedure, forbid, personProcedure, readProcedure, router, systemProcedure } from "../../trpc.ts";
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

export function backlogRouter(db: BacklogDb) {
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
        // A retried job writes the same item once; one message that lists separate jobs writes each (HOU-148).
        const existing = await db.query.items.findFirst({ where: and(eq(schema.items.sourceMessage, input.sourceMessage), eq(schema.items.text, input.text)) });
        if (existing !== undefined) return toItem(existing);
        const [row] = await db
          .insert(schema.items)
          .values({ text: input.text, tags: [...new Set(input.tags)], createdBy: author, createdVia: input.createdVia, sourceMessage: input.sourceMessage, createdAt: ctx.now })
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

    /** Only a person can delete a backlog item (PRV-1). */
    remove: personProcedure.input(zIdInput).mutation(async ({ ctx, input }) => {
      await db.delete(schema.items).where(eq(schema.items.id, input.id));
      ctx.publish("backlog");
    }),

    /** PRV-7. */
    exportPerson: systemProcedure.input(zPersonInput).query(async ({ input }) => ({
      items: (await db.select().from(schema.items).where(eq(schema.items.createdBy, input.person))).map(toItem),
      notNows: await db.select().from(schema.notNows).where(eq(schema.notNows.person, input.person)),
    })),
    deletePerson: systemProcedure.input(zPersonInput).mutation(async ({ input }) => {
      await db.delete(schema.notNows).where(eq(schema.notNows.person, input.person));
      const mine = await db.select({ id: schema.items.id }).from(schema.items).where(eq(schema.items.createdBy, input.person));
      if (mine.length > 0) await db.delete(schema.items).where(and(inArray(schema.items.id, mine.map((m) => m.id))));
    }),
  });
}
