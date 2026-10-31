import { type Question, zAnswerQuestionInput, zAskQuestionInput, zForgetInput, zIdInput, zLearningEvent, zLearningEventInput, zPersonInput, zPreferenceInput, zQuestion, zRhythm, zRhythmInput, zSubjectInput } from "@household/contracts";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso } from "../../db/map.ts";
import { actorProcedure, personProcedure, readProcedure, router, systemProcedure } from "../../trpc.ts";
import * as schema from "./schema.ts";

export type LearningDb = DomainDb<typeof schema>;

const toQuestion = (r: typeof schema.questions.$inferSelect): Question => ({ id: r.id, topic: r.topic, subject: r.subject, text: r.text, options: r.options, askedOn: r.askedOn, answer: r.answer });
const zPreference = z.object({ id: z.string(), kind: z.string(), subject: z.string(), value: z.string(), sentence: z.string() });

export function learningRouter(db: LearningDb) {
  return router({
    /** LRN-1. */
    record: actorProcedure.input(zLearningEventInput).mutation(async ({ ctx, input }) => {
      await db.insert(schema.events).values({ ...input, at: new Date(input.at) });
      ctx.publish("learning");
    }),
    events: readProcedure.output(z.array(zLearningEvent)).query(async () => (await db.select().from(schema.events).orderBy(schema.events.at)).map((e) => ({ ...e, at: iso(e.at) }))),

    rhythms: readProcedure.output(z.array(zRhythm)).query(async () => db.select().from(schema.rhythms)),
    /** LRN-2: learned or answered; a person's own edit always wins over what was learned. */
    upsertRhythm: actorProcedure.input(zRhythmInput).output(zRhythm).mutation(async ({ ctx, input }) => {
      const existing = await db.query.rhythms.findFirst({ where: eq(schema.rhythms.subject, input.subject) });
      if (existing !== undefined && existing.source !== "learned" && input.source === "learned") return existing;
      const [row] = await db.insert(schema.rhythms).values(input).onConflictDoUpdate({ target: schema.rhythms.subject, set: input }).returning();
      if (row === undefined) throw new Error("upsert failed");
      ctx.publish("learning");
      return row;
    }),
    /** LRN-2 from the event log (system). Never overwrites an answered or edited rhythm, never relearns a forgotten one. */
    learnRhythm: systemProcedure.input(zRhythmInput).output(zRhythm.nullable()).mutation(async ({ ctx, input }) => {
      const gone = await db.query.forgotten.findFirst({ where: and(eq(schema.forgotten.kind, "rhythm"), eq(schema.forgotten.subject, input.subject)) });
      if (gone !== undefined) return null;
      const existing = await db.query.rhythms.findFirst({ where: eq(schema.rhythms.subject, input.subject) });
      if (existing !== undefined && existing.source !== "learned") return existing;
      if (existing !== undefined && existing.everyDays === input.everyDays && existing.usualWeekday === input.usualWeekday) return existing;
      const values = { ...input, source: "learned" as const };
      const [row] = await db.insert(schema.rhythms).values(values).onConflictDoUpdate({ target: schema.rhythms.subject, set: values }).returning();
      if (row === undefined) throw new Error("upsert failed");
      ctx.publish("learning");
      return row;
    }),
    editRhythm: personProcedure.input(z.object({ id: z.string(), everyDays: z.number().int().min(1) })).output(zRhythm).mutation(async ({ ctx, input }) => {
      const [row] = await db.update(schema.rhythms).set({ everyDays: input.everyDays, source: "edited" }).where(eq(schema.rhythms.id, input.id)).returning();
      if (row === undefined) throw new Error("no rhythm");
      ctx.publish("learning");
      return row;
    }),

    questions: readProcedure.output(z.array(zQuestion)).query(async () => (await db.select().from(schema.questions).orderBy(desc(schema.questions.askedOn))).map(toQuestion)),
    /** LRN-3/4: unique indexes make "one a day" and "never the same thing twice" database facts. */
    ask: systemProcedure.input(zAskQuestionInput).output(zQuestion.nullable()).mutation(async ({ ctx, input }) => {
      const [row] = await db.insert(schema.questions).values(input).onConflictDoNothing().returning();
      if (row !== undefined) ctx.publish("learning");
      return row === undefined ? null : toQuestion(row);
    }),
    answer: actorProcedure.input(zAnswerQuestionInput).output(zQuestion).mutation(async ({ ctx, input }) => {
      const [row] = await db.update(schema.questions).set({ answer: input.answer }).where(eq(schema.questions.id, input.id)).returning();
      if (row === undefined) throw new Error("no question");
      ctx.publish("learning");
      return toQuestion(row);
    }),

    preferences: readProcedure.output(z.array(zPreference)).query(async () => db.select().from(schema.preferences)),
    setPreference: systemProcedure.input(zPreferenceInput).mutation(async ({ ctx, input }) => {
      const gone = await db.query.forgotten.findFirst({ where: and(eq(schema.forgotten.kind, input.kind), eq(schema.forgotten.subject, input.subject)) });
      if (gone !== undefined) return;
      await db.insert(schema.preferences).values(input).onConflictDoUpdate({ target: [schema.preferences.kind, schema.preferences.subject], set: input });
      ctx.publish("learning");
    }),
    clearPreference: systemProcedure.input(zForgetInput).mutation(async ({ input }) => {
      await db.delete(schema.preferences).where(and(eq(schema.preferences.kind, input.kind), eq(schema.preferences.subject, input.subject)));
    }),

    /** LRN-7: delete a sentence and it forgets (and does not quietly relearn it). */
    forgetRhythm: personProcedure.input(zIdInput).mutation(async ({ ctx, input }) => {
      const row = await db.query.rhythms.findFirst({ where: eq(schema.rhythms.id, input.id) });
      if (row === undefined) return;
      await db.update(schema.questions).set({ rhythmId: null }).where(eq(schema.questions.rhythmId, row.id));
      await db.delete(schema.rhythms).where(eq(schema.rhythms.id, input.id));
      await db.insert(schema.forgotten).values({ kind: "rhythm", subject: row.subject, at: ctx.now });
      await db.delete(schema.events).where(eq(schema.events.subject, row.subject));
      ctx.publish("learning");
    }),
    forgetPreference: personProcedure.input(zIdInput).mutation(async ({ ctx, input }) => {
      const row = await db.query.preferences.findFirst({ where: eq(schema.preferences.id, input.id) });
      if (row === undefined) return;
      await db.delete(schema.preferences).where(eq(schema.preferences.id, input.id));
      await db.insert(schema.forgotten).values({ kind: row.kind, subject: row.subject, at: ctx.now });
      ctx.publish("learning");
    }),
    forgotten: readProcedure.output(z.array(z.object({ kind: z.string(), subject: z.string() }))).query(async () => db.select({ kind: schema.forgotten.kind, subject: schema.forgotten.subject }).from(schema.forgotten)),
    isForgotten: readProcedure.input(zSubjectInput.extend({ kind: z.string() })).output(z.boolean()).query(async ({ input }) =>
      (await db.query.forgotten.findFirst({ where: and(eq(schema.forgotten.kind, input.kind), eq(schema.forgotten.subject, input.subject)) })) !== undefined,
    ),

    exportPerson: systemProcedure.input(zPersonInput).query(async ({ input }) => ({ events: await db.select().from(schema.events).where(eq(schema.events.person, input.person)) })),
    deletePerson: systemProcedure.input(zPersonInput).mutation(async ({ input }) => {
      await db.delete(schema.events).where(eq(schema.events.person, input.person));
    }),
  });
}
