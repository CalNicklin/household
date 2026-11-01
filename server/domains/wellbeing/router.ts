import { type WellbeingScore, zMuteInput, zPersonInput, zScoreRangeInput, zWellbeingNudgeInput, zWellbeingScore } from "@household/contracts";
import { and, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso } from "../../db/map.ts";
import { readProcedure, router, systemProcedure } from "../../trpc.ts";
import * as schema from "./schema.ts";

export type WellbeingDb = DomainDb<typeof schema>;

const toScore = (r: typeof schema.scores.$inferSelect): WellbeingScore => ({ person: r.person, date: r.date, score: r.score, heavy: r.heavy, freeHours: r.freeHours, factors: r.factors });

export function wellbeingRouter(db: WellbeingDb) {
  return router({
    /** WB-8: the daily score and what it was made from — nothing else is stored. */
    upsertScore: systemProcedure.input(zWellbeingScore).mutation(async ({ input }) => {
      await db.insert(schema.scores).values(input).onConflictDoUpdate({ target: [schema.scores.person, schema.scores.date], set: input });
    }),
    scores: readProcedure.input(zScoreRangeInput).output(z.array(zWellbeingScore)).query(async ({ input }) =>
      (await db.select().from(schema.scores).where(and(eq(schema.scores.person, input.person), gte(schema.scores.date, input.from), lte(schema.scores.date, input.to))).orderBy(schema.scores.date)).map(toScore),
    ),
    recordNudge: systemProcedure.input(zWellbeingNudgeInput).mutation(async ({ ctx, input }) => {
      await db.insert(schema.nudges).values({ ...input, at: ctx.now });
    }),
    nudges: readProcedure.output(z.array(z.object({ about: z.string(), to: z.string(), date: z.string(), at: z.string() }))).query(async () =>
      (await db.select().from(schema.nudges)).map((n) => ({ about: n.about, to: n.to, date: n.date, at: iso(n.at) })),
    ),
    /** WB-5: "not helpful" stops them for a month. */
    mute: systemProcedure.input(zMuteInput).mutation(async ({ input }) => {
      await db.insert(schema.mutes).values({ person: input.person, until: new Date(input.until) }).onConflictDoUpdate({ target: schema.mutes.person, set: { until: new Date(input.until) } });
    }),
    mutedUntil: readProcedure.input(zPersonInput).output(z.string().nullable()).query(async ({ input }) => {
      const row = await db.query.mutes.findFirst({ where: eq(schema.mutes.person, input.person) });
      return row === undefined ? null : iso(row.until);
    }),
    exportPerson: systemProcedure.input(zPersonInput).query(async ({ input }) => ({
      scores: (await db.select().from(schema.scores).where(eq(schema.scores.person, input.person))).map(toScore),
      nudges: await db.select().from(schema.nudges).where(eq(schema.nudges.about, input.person)),
    })),
    deletePerson: systemProcedure.input(zPersonInput).mutation(async ({ input }) => {
      await db.delete(schema.scores).where(eq(schema.scores.person, input.person));
      await db.delete(schema.nudges).where(eq(schema.nudges.about, input.person));
      await db.delete(schema.nudges).where(eq(schema.nudges.to, input.person));
      await db.delete(schema.mutes).where(eq(schema.mutes.person, input.person));
    }),
  });
}
