import {
  ActorKind,
  Channel,
  type Mode,
  ModeKind,
  PersonRole,
  type PersonSettings,
  zDateRangeInput,
  zHouseholdSettings,
  zHouseholdSettingsPatch,
  zIdInput,
  zLoginInput,
  zMode,
  zNurseryEvent,
  zNurseryEventInput,
  zNurseryTerm,
  zPerson,
  zPersonInput,
  zPersonSettings,
  zPersonSettingsPatch,
  zResolveIdentityInput,
  zRule,
  zRuleCreateInput,
  zRuleUpdateInput,
  zSetModeRequest,
  zSetTelegramIdInput,
  zSetTelegramIdResult,
  zSitter,
  zSitterBooking,
  zSitterBookingInput,
  zWellbeingIdea,
  zWellbeingIdeaInput,
} from "@household/contracts";
import { and, desc, eq, gt, inArray, lt, lte } from "drizzle-orm";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso } from "../../db/map.ts";
import { actingPerson, actorProcedure, forbid, personProcedure, readProcedure, router, systemProcedure } from "../../trpc.ts";
import * as schema from "./schema.ts";

export type HouseholdDb = DomainDb<typeof schema>;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}

function checkPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (salt === undefined || hash === undefined) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

const toMode = (r: typeof schema.modes.$inferSelect): Mode => ({ id: r.id, mode: r.mode, setBy: r.setBy, setAt: iso(r.setAt), startsAt: iso(r.startsAt), endsAt: iso(r.endsAt) });
const toSettings = (r: typeof schema.personSettings.$inferSelect): PersonSettings => ({
  person: r.personId,
  dailyMessageBudget: r.dailyMessageBudget,
  quietStartHour: r.quietStartHour,
  quietEndHour: r.quietEndHour,
  routing: r.routing,
  wellbeingEnabled: r.wellbeingEnabled,
  healthInScore: r.healthInScore,
});

export function householdRouter(db: HouseholdDb) {
  return router({
    settings: readProcedure.output(zHouseholdSettings).query(async () => {
      const row = await db.query.settings.findFirst();
      if (row === undefined) throw new Error("household not seeded");
      return row;
    }),
    /** PRV-5: one setting turns message retention off completely. */
    updateSettings: personProcedure.input(zHouseholdSettingsPatch).output(zHouseholdSettings).mutation(async ({ ctx, input }) => {
      const [row] = await db.update(schema.settings).set(input).returning();
      if (row === undefined) throw new Error("household not seeded");
      ctx.publish("settings");
      return row;
    }),

    people: readProcedure.output(z.array(zPerson)).query(async () => db.select().from(schema.people)),
    adults: readProcedure.output(z.array(zPerson)).query(async () => db.select().from(schema.people).where(eq(schema.people.role, PersonRole.adult))),

    /** CH-3: a channel address maps to a person at the edge; unknown addresses return null. */
    resolveIdentity: readProcedure.input(zResolveIdentityInput).output(z.string().nullable()).query(async ({ input }) => {
      const row = await db.query.identities.findFirst({ where: and(eq(schema.identities.channel, input.channel), eq(schema.identities.address, input.address)) });
      return row?.personId ?? null;
    }),
    addressesFor: readProcedure.input(zPersonInput).output(z.array(z.object({ channel: z.string(), address: z.string() }))).query(async ({ input }) =>
      db.select({ channel: schema.identities.channel, address: schema.identities.address }).from(schema.identities).where(eq(schema.identities.personId, input.person)),
    ),
    /**
     * CH-3: an adult's Telegram user ID, set after setup by `household-telegram set` on the server. It
     * replaces any Telegram ID that adult had, and refuses an ID that is already someone else's.
     */
    setTelegramId: systemProcedure.input(zSetTelegramIdInput).output(zSetTelegramIdResult).mutation(async ({ input }) =>
      db.transaction(async (tx) => {
        const person = await tx.query.people.findFirst({ where: eq(schema.people.id, input.person) });
        if (person?.role !== PersonRole.adult) forbid(`${input.person} is not one of the adults`);
        const taken = await tx.query.identities.findFirst({ where: and(eq(schema.identities.channel, Channel.telegram), eq(schema.identities.address, input.telegram)) });
        if (taken !== undefined && taken.personId !== input.person) forbid(`that Telegram ID is already ${taken.personId}'s`);
        const old = await tx.delete(schema.identities).where(and(eq(schema.identities.personId, input.person), eq(schema.identities.channel, Channel.telegram))).returning({ address: schema.identities.address });
        await tx.insert(schema.identities).values({ personId: input.person, channel: Channel.telegram, address: input.telegram });
        return { person: input.person, telegram: input.telegram, replaced: old.map((r) => r.address).filter((a) => a !== input.telegram) };
      }),
    ),
    /** PRV-8: everyone the app may ever message: the household's adults and the named sitters. */
    allowedRecipients: readProcedure.output(z.array(z.object({ channel: z.string(), address: z.string() }))).query(async () => [
      ...(await db.select({ channel: schema.identities.channel, address: schema.identities.address }).from(schema.identities)),
      ...(await db.select({ channel: schema.sitterIdentities.channel, address: schema.sitterIdentities.address }).from(schema.sitterIdentities)),
    ]),
    login: readProcedure.input(zLoginInput).output(z.string().nullable()).query(async ({ input }) => {
      const row = await db.query.logins.findFirst({ where: eq(schema.logins.username, input.username) });
      if (row === undefined || !checkPassword(input.password, row.passwordHash)) return null;
      return row.personId;
    }),

    personSettings: readProcedure.input(zPersonInput).output(zPersonSettings).query(async ({ input }) => {
      const row = await db.query.personSettings.findFirst({ where: eq(schema.personSettings.personId, input.person) });
      if (row === undefined) forbid(`no settings for ${input.person}`);
      return toSettings(row);
    }),
    /** PRO-7 / CH-7 / WB-6: each of us changes our own settings. */
    updateMySettings: personProcedure.input(zPersonSettingsPatch).output(zPersonSettings).mutation(async ({ ctx, input }) => {
      const [row] = await db.update(schema.personSettings).set(input).where(eq(schema.personSettings.personId, ctx.actor.person)).returning();
      if (row === undefined) forbid("no settings");
      ctx.publish("settings");
      return toSettings(row);
    }),

    /** MOM-1/3/4: one mode for the whole house; it ends at `endsAt` (midnight unless extended). */
    activeMode: readProcedure.output(zMode.nullable()).query(async ({ ctx }) => {
      const row = await db.query.modes.findFirst({ where: and(lte(schema.modes.startsAt, ctx.now), gt(schema.modes.endsAt, ctx.now)), orderBy: desc(schema.modes.setAt) });
      return row === undefined ? null : toMode(row);
    }),
    /** HOU-156: every mode in effect at some point in the range, including those set ahead. */
    modesBetween: readProcedure.input(zDateRangeInput).output(z.array(zMode)).query(async ({ input }) => {
      const rows = await db.select().from(schema.modes).where(and(lt(schema.modes.startsAt, new Date(input.to)), gt(schema.modes.endsAt, new Date(input.from)), gt(schema.modes.endsAt, schema.modes.startsAt)));
      return rows.map(toMode);
    }),
    /**
     * MOM-3/4, HOU-156: a mode starts now, or at a later `startsAt` ("we're away this weekend"). Set
     * now, it replaces whatever is on, as it always did. Set ahead, it replaces only its own span: a
     * mode on when it starts pauses and carries on after it. Either way, modes set ahead inside its
     * span start when it ends, or go if they end inside it. `normal` only clears the span.
     */
    setMode: actorProcedure.input(zSetModeRequest).output(zMode).mutation(async ({ ctx, input }) => {
      const by = actingPerson(ctx.actor);
      if (by === null) forbid("a mode is set by a person");
      const asked = input.startsAt === undefined ? null : new Date(input.startsAt);
      const ahead = asked !== null && asked > ctx.now;
      const start = ahead ? asked : ctx.now;
      const end = new Date(input.endsAt);
      if (input.mode !== ModeKind.normal && end <= start) forbid("a mode ends after it starts");
      const row = await db.transaction(async (tx) => {
        const m = schema.modes;
        const inEffect = and(lte(m.startsAt, start), gt(m.endsAt, start));
        // Set ahead, it replaces only the days it covers: what was on before it carries on after it.
        const resumes = ahead ? (await tx.select().from(m).where(and(inEffect, gt(m.endsAt, end)))).map((r) => ({ mode: r.mode, setBy: r.setBy, setAt: r.setAt, startsAt: end, endsAt: r.endsAt })) : [];
        await tx.update(m).set({ endsAt: start }).where(inEffect);
        if (resumes.length > 0) await tx.insert(m).values(resumes);
        if (end > start) {
          await tx.update(m).set({ endsAt: m.startsAt }).where(and(gt(m.startsAt, start), lt(m.startsAt, end), lte(m.endsAt, end)));
          await tx.update(m).set({ startsAt: end }).where(and(gt(m.startsAt, start), lt(m.startsAt, end), gt(m.endsAt, end)));
        }
        const [inserted] = await tx.insert(m).values({ mode: input.mode, setBy: by, setAt: ctx.now, startsAt: start, endsAt: input.mode === ModeKind.normal ? start : end }).returning();
        return inserted;
      });
      if (row === undefined) throw new Error("insert failed");
      ctx.publish("mode");
      return toMode(row);
    }),

    /** Rules are written by a person. A job can read them but never create, change or delete them (PRV-1). */
    rules: readProcedure.output(z.array(zRule)).query(async () => (await db.select().from(schema.rules)).map((r) => ({ ...r, createdAt: iso(r.createdAt) }))),
    createRule: personProcedure.input(zRuleCreateInput).output(zRule).mutation(async ({ ctx, input }) => {
      const [row] = await db.insert(schema.rules).values({ kind: input.spec.kind, spec: input.spec, createdBy: ctx.actor.person, createdAt: ctx.now }).returning();
      if (row === undefined) throw new Error("insert failed");
      ctx.publish("plan");
      return { ...row, createdAt: iso(row.createdAt) };
    }),
    updateRule: personProcedure.input(zRuleUpdateInput).output(zRule).mutation(async ({ ctx, input }) => {
      const [row] = await db.update(schema.rules).set({ spec: input.spec, kind: input.spec.kind }).where(eq(schema.rules.id, input.id)).returning();
      if (row === undefined) forbid("no such rule");
      ctx.publish("plan");
      return { ...row, createdAt: iso(row.createdAt) };
    }),
    deleteRule: personProcedure.input(zIdInput).mutation(async ({ ctx, input }) => {
      await db.delete(schema.rules).where(eq(schema.rules.id, input.id));
      ctx.publish("plan");
    }),

    nurseryTerms: readProcedure.output(z.array(zNurseryTerm)).query(async () => db.select().from(schema.nurseryTerms)),
    nurseryEvents: readProcedure.output(z.array(zNurseryEvent)).query(async () => db.select().from(schema.nurseryEvents)),
    addNurseryEvent: personProcedure.input(zNurseryEventInput).output(zNurseryEvent).mutation(async ({ ctx, input }) => {
      const [row] = await db.insert(schema.nurseryEvents).values(input).returning();
      if (row === undefined) throw new Error("insert failed");
      ctx.publish("plan");
      return row;
    }),

    sitters: readProcedure.output(z.array(zSitter)).query(async () => db.select().from(schema.sitters)),
    sitterAddress: readProcedure.input(z.object({ name: z.string(), channel: z.string() })).output(z.string().nullable()).query(async ({ input }) => {
      const rows = await db.query.sitters.findMany({ with: { identities: true } });
      const sitter = rows.find((r) => r.name.toLowerCase() === input.name.toLowerCase());
      return sitter?.identities.find((i) => i.channel === input.channel)?.address ?? null;
    }),
    sitterBookings: readProcedure.output(z.array(zSitterBooking)).query(async () =>
      (await db.query.sitterBookings.findMany({ with: { sitter: true } })).map((b) => ({ id: b.id, sitter: b.sitter.name, date: b.date, recordedBy: b.recordedBy })),
    ),
    /** PRO-2: "Hannah's doing Thursday" — recording a booking a person told us about. */
    recordSitterBooking: actorProcedure.input(zSitterBookingInput).output(zSitterBooking).mutation(async ({ ctx, input }) => {
      const by = actingPerson(ctx.actor);
      if (by === null) forbid("a booking is recorded for a person");
      const sitter = (await db.select().from(schema.sitters)).find((s) => s.name.toLowerCase() === input.sitter.toLowerCase());
      if (sitter === undefined) forbid(`${input.sitter} is not a named sitter`);
      const existing = await db.query.sitterBookings.findFirst({ where: and(eq(schema.sitterBookings.sitterId, sitter.id), eq(schema.sitterBookings.date, input.date)) });
      const row = existing ?? (await db.insert(schema.sitterBookings).values({ sitterId: sitter.id, date: input.date, recordedBy: by, createdAt: ctx.now }).returning())[0];
      if (row === undefined) throw new Error("insert failed");
      ctx.publish("plan");
      return { id: row.id, sitter: sitter.name, date: row.date, recordedBy: row.recordedBy };
    }),

    wellbeingIdeas: readProcedure.output(z.array(zWellbeingIdea)).query(async () => db.select().from(schema.wellbeingIdeas)),
    addWellbeingIdea: personProcedure.input(zWellbeingIdeaInput).output(zWellbeingIdea).mutation(async ({ ctx, input }) => {
      const [row] = await db.insert(schema.wellbeingIdeas).values({ text: input.text, createdBy: ctx.actor.person }).returning();
      if (row === undefined) throw new Error("insert failed");
      return row;
    }),
    removeWellbeingIdea: personProcedure.input(zIdInput).mutation(async ({ input }) => {
      await db.delete(schema.wellbeingIdeas).where(eq(schema.wellbeingIdeas.id, input.id));
    }),

    tagHints: readProcedure.output(z.array(z.object({ word: z.string(), tag: z.string() }))).query(async () => db.select({ word: schema.tagHints.word, tag: schema.tagHints.tag }).from(schema.tagHints)),

    exportPerson: systemProcedure.input(zPersonInput).query(async ({ input }) => ({
      person: await db.query.people.findFirst({ where: eq(schema.people.id, input.person) }),
      identities: await db.select().from(schema.identities).where(eq(schema.identities.personId, input.person)),
      settings: await db.query.personSettings.findFirst({ where: eq(schema.personSettings.personId, input.person) }),
      modes: (await db.select().from(schema.modes).where(eq(schema.modes.setBy, input.person))).map(toMode),
      rules: await db.select().from(schema.rules).where(eq(schema.rules.createdBy, input.person)),
      wellbeingIdeas: await db.select().from(schema.wellbeingIdeas).where(eq(schema.wellbeingIdeas.createdBy, input.person)),
    })),
    /** PRV-7: forget a person's own records; the person row itself stays so the house still works. */
    deletePerson: systemProcedure.input(zPersonInput).mutation(async ({ ctx, input }) => {
      if (ctx.actor.kind !== ActorKind.system) forbid("system only");
      await db.delete(schema.modes).where(eq(schema.modes.setBy, input.person));
      await db.delete(schema.wellbeingIdeas).where(eq(schema.wellbeingIdeas.createdBy, input.person));
      await db.delete(schema.sitterBookings).where(eq(schema.sitterBookings.recordedBy, input.person));
      const ruleIds = (await db.select({ id: schema.rules.id }).from(schema.rules).where(eq(schema.rules.createdBy, input.person))).map((r) => r.id);
      if (ruleIds.length > 0) await db.delete(schema.rules).where(inArray(schema.rules.id, ruleIds));
      await db.update(schema.nurseryEvents).set({ coveredBy: null }).where(eq(schema.nurseryEvents.coveredBy, input.person));
    }),
  });
}
