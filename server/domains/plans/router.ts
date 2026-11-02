import { ActionKind, type Plan, type Response, zDateInput, zHandOver, zHandOverInput, zOffer, zOfferInput, zPersonInput, zPlan, zRespondInput, zResponse, zSavePlanInput } from "@household/contracts";
import { and, desc, eq, gte, lt, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso } from "../../db/map.ts";
import { actingPerson, actorProcedure, forbid, readProcedure, router, systemProcedure } from "../../trpc.ts";
import * as schema from "./schema.ts";

export type PlansDb = DomainDb<typeof schema>;

const toPlan = (r: typeof schema.plans.$inferSelect): Plan => {
  const build = r.inputs["build"];
  return { date: r.date, version: r.version, createdAt: iso(r.createdAt), blocks: r.blocks, build: typeof build === "string" ? build : null };
};
const toResponse = (r: typeof schema.responses.$inferSelect): Response => ({ id: r.id, ref: r.ref, action: r.action, person: r.person, channel: r.channel, date: r.date, value: r.value, at: iso(r.at) });

export function plansRouter(db: PlansDb) {
  return router({
    /**
     * PLT-4: every version is kept, with the inputs that made it. HOU-162: saves of one date take turns
     * (a transaction lock on the date), so two jobs planning the same day at once both land, the later
     * one as the next version, instead of one failing on `plans_date_version`.
     */
    save: systemProcedure.input(zSavePlanInput).output(zPlan).mutation(async ({ ctx, input }) => {
      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`plans:${input.date}`}, 0))`);
        const [{ v } = { v: null }] = await tx.select({ v: max(schema.plans.version) }).from(schema.plans).where(eq(schema.plans.date, input.date));
        const [inserted] = await tx.insert(schema.plans).values({ ...input, version: (v ?? 0) + 1, createdAt: ctx.now }).returning();
        return inserted;
      });
      if (row === undefined) throw new Error("insert failed");
      ctx.publish("plan");
      return toPlan(row);
    }),
    latest: readProcedure.input(zDateInput).output(zPlan.nullable()).query(async ({ input }) => {
      const row = await db.query.plans.findFirst({ where: eq(schema.plans.date, input.date), orderBy: desc(schema.plans.version) });
      return row === undefined ? null : toPlan(row);
    }),
    versions: readProcedure.input(zDateInput).output(z.array(zPlan.extend({ trigger: z.string(), inputs: z.record(z.string(), z.unknown()) }))).query(async ({ input }) =>
      (await db.select().from(schema.plans).where(eq(schema.plans.date, input.date)).orderBy(schema.plans.version)).map((r) => ({ ...toPlan(r), trigger: r.trigger, inputs: r.inputs })),
    ),
    plannedDates: readProcedure.output(z.array(z.string())).query(async () => (await db.selectDistinct({ date: schema.plans.date }).from(schema.plans).orderBy(schema.plans.date)).map((r) => r.date)),

    /** HOME-4/5: Done, Not today, Snooze. Recorded, never "overdue". */
    respond: actorProcedure.input(zRespondInput).output(zResponse).mutation(async ({ ctx, input }) => {
      const person = actingPerson(ctx.actor);
      if (person === null) forbid("a response belongs to a person");
      const [row] = await db.insert(schema.responses).values({ ...input, person, at: ctx.now }).returning();
      if (row === undefined) throw new Error("insert failed");
      ctx.publish("plan");
      return toResponse(row);
    }),
    responsesOn: readProcedure.input(zDateInput).output(z.array(zResponse)).query(async ({ input }) => (await db.select().from(schema.responses).where(eq(schema.responses.date, input.date))).map(toResponse)),
    responsesBetween: readProcedure.input(z.object({ from: z.iso.date(), to: z.iso.date() })).output(z.array(zResponse)).query(async ({ input }) =>
      (await db.select().from(schema.responses).where(and(gte(schema.responses.date, input.from), lt(schema.responses.date, input.to)))).map(toResponse),
    ),
    responsesForRef: readProcedure.input(z.object({ ref: z.string() })).output(z.array(zResponse)).query(async ({ input }) => (await db.select().from(schema.responses).where(eq(schema.responses.ref, input.ref))).map(toResponse)),

    /** MOM-6: "Cal can do it". */
    handOver: actorProcedure.input(zHandOverInput).output(zHandOver).mutation(async ({ ctx, input }) => {
      const from = actingPerson(ctx.actor);
      if (from === null) forbid("a hand-over is from a person");
      const date = ctx.now.toISOString().slice(0, 10);
      const [response] = await db.insert(schema.responses).values({ ref: input.ref, action: ActionKind.handOver, person: from, channel: "app", date, value: input.to, at: ctx.now }).returning();
      const [row] = await db.insert(schema.handOvers).values({ ref: input.ref, title: input.title, from, to: input.to, responseId: response?.id ?? null, at: ctx.now }).returning();
      if (row === undefined) throw new Error("insert failed");
      ctx.publish("plan");
      return { id: row.id, ref: row.ref, from: row.from, to: row.to, title: row.title, at: iso(row.at) };
    }),
    handOvers: readProcedure.output(z.array(zHandOver)).query(async () => (await db.select().from(schema.handOvers)).map((r) => ({ id: r.id, ref: r.ref, from: r.from, to: r.to, title: r.title, at: iso(r.at) }))),

    /** PRO-6: the unique indexes make "one a day, and only once" a database fact. */
    recordOffer: systemProcedure.input(zOfferInput).output(zOffer.nullable()).mutation(async ({ input }) => {
      const [row] = await db.insert(schema.offers).values(input).onConflictDoNothing().returning();
      return row === undefined ? null : { id: row.id, itemId: row.itemId, date: row.date, person: row.person };
    }),
    offers: readProcedure.output(z.array(zOffer)).query(async () => (await db.select().from(schema.offers)).map((r) => ({ id: r.id, itemId: r.itemId, date: r.date, person: r.person }))),

    exportPerson: systemProcedure.input(zPersonInput).query(async ({ input }) => ({
      responses: (await db.select().from(schema.responses).where(eq(schema.responses.person, input.person))).map(toResponse),
      handOvers: await db.select().from(schema.handOvers).where(eq(schema.handOvers.from, input.person)),
    })),
    deletePerson: systemProcedure.input(zPersonInput).mutation(async ({ input }) => {
      await db.delete(schema.handOvers).where(eq(schema.handOvers.from, input.person));
      await db.delete(schema.handOvers).where(eq(schema.handOvers.to, input.person));
      await db.delete(schema.responses).where(eq(schema.responses.person, input.person));
    }),
  });
}
