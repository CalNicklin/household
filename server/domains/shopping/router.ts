import { DeletableShoppingStatuses, DeletedThing, type ShoppingRequest, ShoppingStatus, zBasketAddInput, zIdInput, zPersonInput, zShoppingRequest, zShoppingRequestInput, zShoppingRequestUpdate, zShoppingRun, zShoppingRunInput, zSummaryInput } from "@household/contracts";
import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso } from "../../db/map.ts";
import { actingPerson, actorProcedure, forbid, logDeleted, personProcedure, readProcedure, router, systemProcedure } from "../../trpc.ts";
import * as schema from "./schema.ts";

export type ShoppingDb = DomainDb<typeof schema>;

export function shoppingRouter(db: ShoppingDb) {
  const toRequest = async (r: typeof schema.requests.$inferSelect): Promise<ShoppingRequest> => {
    const run = await db.query.runs.findFirst({ where: eq(schema.runs.requestId, r.id), orderBy: desc(schema.runs.createdAt) });
    return { id: r.id, item: r.item, person: r.person, status: r.status, chosen: r.chosen ?? null, options: r.options, runId: run?.id ?? null, createdAt: iso(r.createdAt) };
  };
  return router({
    /** AUT-1: a shopping mention becomes a request; the helper fills it in its own sealed space. */
    request: actorProcedure.input(zShoppingRequestInput).output(zShoppingRequest).mutation(async ({ ctx, input }) => {
      const person = actingPerson(ctx.actor);
      if (person === null) forbid("a shopping request is for a person");
      const existing = await db.query.requests.findFirst({ where: eq(schema.requests.sourceMessage, input.sourceMessage) });
      if (existing !== undefined && existing.item === input.item) return toRequest(existing);
      const [row] = await db.insert(schema.requests).values({ item: input.item, person, status: ShoppingStatus.queued, sourceMessage: input.sourceMessage, createdAt: ctx.now }).returning();
      if (row === undefined) throw new Error("insert failed");
      ctx.publish("shopping");
      return toRequest(row);
    }),
    update: systemProcedure.input(zShoppingRequestUpdate).output(zShoppingRequest).mutation(async ({ ctx, input }) => {
      const [row] = await db.update(schema.requests).set({ status: input.status, chosen: input.chosen, options: input.options }).where(eq(schema.requests.id, input.id)).returning();
      if (row === undefined) throw new Error("no request");
      ctx.publish("shopping");
      return toRequest(row);
    }),
    get: readProcedure.input(zIdInput).output(zShoppingRequest.nullable()).query(async ({ input }) => {
      const row = await db.query.requests.findFirst({ where: eq(schema.requests.id, input.id) });
      return row === undefined ? null : toRequest(row);
    }),
    recent: readProcedure.output(z.array(zShoppingRequest)).query(async () =>
      Promise.all((await db.select().from(schema.requests).where(ne(schema.requests.status, ShoppingStatus.dismissed)).orderBy(desc(schema.requests.createdAt)).limit(50)).map(toRequest)),
    ),
    /**
     * HOU-148: a person's tap dismisses a request that went nowhere (saved, or not found). The row is
     * kept as dismissed, never deleted; dismissing it again is a no-op; a request in any other state
     * is left as it is.
     */
    dismiss: actorProcedure.input(zIdInput).output(zShoppingRequest).mutation(async ({ ctx, input }) => {
      if (actingPerson(ctx.actor) === null) forbid("a dismissal is a person's");
      const [updated] = await db
        .update(schema.requests)
        .set({ status: ShoppingStatus.dismissed })
        .where(and(eq(schema.requests.id, input.id), inArray(schema.requests.status, [ShoppingStatus.failed, ShoppingStatus.saved, ShoppingStatus.dismissed])))
        .returning();
      if (updated === undefined) forbid("only a request that went nowhere can be dismissed");
      ctx.publish("shopping");
      return toRequest(updated);
    }),
    /**
     * HOU-158: a person deletes a request that went nowhere, anyone's, from the Shop screen. Only a
     * person (PRV-1): no job or system path reaches this. A request the helper is still working on, or
     * whose item it put in the basket, is refused (AUT-4). Logged with who did it.
     */
    remove: personProcedure.input(zIdInput).mutation(async ({ ctx, input }) => {
      const [row] = await db
        .delete(schema.requests)
        .where(and(eq(schema.requests.id, input.id), inArray(schema.requests.status, [...DeletableShoppingStatuses])))
        .returning();
      if (row === undefined) {
        if ((await db.query.requests.findFirst({ where: eq(schema.requests.id, input.id) })) !== undefined) forbid("only a request that went nowhere can be deleted");
        return;
      }
      logDeleted(DeletedThing.shoppingRequest, row.id, ctx.actor.person, row.person);
      ctx.publish("shopping");
    }),
    addRun: systemProcedure.input(zShoppingRunInput).output(z.string()).mutation(async ({ ctx, input }) => {
      // Whose request it ran for, kept on the run itself so PRV-7 finds it after the request is deleted (HOU-158).
      const request = await db.query.requests.findFirst({ where: eq(schema.requests.id, input.requestId) });
      const [row] = await db
        .insert(schema.runs)
        .values({ ...input, person: request?.person ?? null, createdAt: ctx.now })
        .returning();
      if (row === undefined) throw new Error("insert failed");
      return row.id;
    }),
    run: readProcedure.input(zIdInput).output(zShoppingRun.nullable()).query(async ({ input }) => {
      const row = await db.query.runs.findFirst({ where: eq(schema.runs.id, input.id) });
      return row === undefined ? null : { id: row.id, requestId: row.requestId, log: row.log, screenshots: row.screenshots, createdAt: iso(row.createdAt) };
    }),
    /** AUT-4: what the helper itself added; it may only ever remove these. */
    recordAdd: systemProcedure.input(zBasketAddInput).mutation(async ({ ctx, input }) => {
      await db.insert(schema.basketAdds).values({ ...input, at: ctx.now });
    }),
    addsSince: readProcedure.input(z.object({ since: z.iso.datetime({ offset: true }) })).output(z.array(z.object({ sku: z.string(), name: z.string(), at: z.string() }))).query(async ({ input }) =>
      (await db.select().from(schema.basketAdds).where(gt(schema.basketAdds.at, new Date(input.since)))).map((a) => ({ sku: a.sku, name: a.name, at: iso(a.at) })),
    ),
    ownSkus: readProcedure.output(z.array(z.string())).query(async () => (await db.select({ sku: schema.basketAdds.sku }).from(schema.basketAdds)).map((r) => r.sku)),
    /** AUT-5: when each of us last saw a basket summary. */
    recordSummary: systemProcedure.input(zSummaryInput).mutation(async ({ ctx, input }) => {
      await db.insert(schema.summaries).values({ ...input, at: ctx.now });
    }),
    lastSummary: readProcedure.input(zPersonInput).output(z.object({ deliveryDate: z.string(), at: z.string() }).nullable()).query(async ({ input }) => {
      const row = await db.query.summaries.findFirst({ where: eq(schema.summaries.person, input.person), orderBy: desc(schema.summaries.at) });
      return row === undefined ? null : { deliveryDate: row.deliveryDate, at: iso(row.at) };
    }),
    exportPerson: systemProcedure.input(zPersonInput).query(async ({ input }) => ({ requests: await db.select().from(schema.requests).where(eq(schema.requests.person, input.person)) })),
    deletePerson: systemProcedure.input(zPersonInput).mutation(async ({ input }) => {
      // Their runs too, including ones whose request a person already deleted (HOU-158).
      await db.delete(schema.runs).where(eq(schema.runs.person, input.person));
      await db.delete(schema.requests).where(eq(schema.requests.person, input.person));
      await db.delete(schema.summaries).where(eq(schema.summaries.person, input.person));
    }),
  });
}
