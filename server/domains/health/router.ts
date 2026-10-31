import { zHealthEntry, zHealthEntryInput, zPersonInput, zScoreRangeInput } from "@household/contracts";
import { and, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso } from "../../db/map.ts";
import { forbid, personProcedure, router, systemProcedure } from "../../trpc.ts";
import * as schema from "./schema.ts";

export type HealthDb = DomainDb<typeof schema>;

/**
 * PRV-2: separate database; only its owner can add to it or read it. The scorer reads it through
 * `forScore`, which the wellbeing job only calls when the owner has turned "health in score" on.
 * Nothing here is ever given to the agent.
 */
export function healthRouter(db: HealthDb, owner: string | null) {
  return router({
    add: personProcedure.input(zHealthEntryInput).output(zHealthEntry).mutation(async ({ ctx, input }) => {
      if (owner === null || ctx.actor.person !== owner) forbid("PRV-2: only its owner can add health tracking");
      const [row] = await db.insert(schema.entries).values({ owner, date: input.date, heavy: input.heavy, createdAt: ctx.now }).returning();
      if (row === undefined) throw new Error("insert failed");
      return { id: row.id, date: row.date, heavy: row.heavy, createdAt: iso(row.createdAt) };
    }),
    mine: personProcedure.output(z.array(zHealthEntry)).query(async ({ ctx }) => {
      if (owner === null || ctx.actor.person !== owner) forbid("PRV-2: only its owner can see health tracking");
      return (await db.select().from(schema.entries).where(eq(schema.entries.owner, owner))).map((r) => ({ id: r.id, date: r.date, heavy: r.heavy, createdAt: iso(r.createdAt) }));
    }),
    forScore: systemProcedure.input(zScoreRangeInput).output(z.array(z.object({ date: z.string(), heavy: z.boolean() }))).query(async ({ input }) =>
      db.select({ date: schema.entries.date, heavy: schema.entries.heavy }).from(schema.entries).where(and(eq(schema.entries.owner, input.person), gte(schema.entries.date, input.from), lte(schema.entries.date, input.to))),
    ),
    exportPerson: systemProcedure.input(zPersonInput).query(async ({ input }) => ({ entries: await db.select().from(schema.entries).where(eq(schema.entries.owner, input.person)) })),
    deletePerson: systemProcedure.input(zPersonInput).mutation(async ({ input }) => {
      await db.delete(schema.entries).where(eq(schema.entries.owner, input.person));
    }),
  });
}
