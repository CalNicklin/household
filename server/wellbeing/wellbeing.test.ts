import { ActionKind, ActorKind, Channel, type LocalDate, WellbeingFactor, WellbeingFactorLabel } from "@household/contracts";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, expectTypeOf, test } from "vitest";
import { respond } from "../agent/respond.ts";
import { jobScope } from "../agent/scope.ts";
import * as wellbeingSchema from "../domains/wellbeing/schema.ts";
import { learnedSentences } from "../learning/learn.ts";
import { gatherFacts } from "../planner/gather.ts";
import type { HouseFacts } from "../rules/day.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { addLocalDays } from "../time.ts";
import { heavyPeople, updateScores, wellbeingNudges } from "./run.ts";
import { scoreDay, type ScoreInput } from "./score.ts";

let h: TestHousehold;
beforeAll(async () => {
  h = await testHousehold({ jobs: false });
  const changes = await h.ports.calendar.changes({});
  await h.rt.system("t").calendar.applySync({ upserts: changes.upserts, deletedExternalIds: changes.deletedExternalIds, syncTokens: changes.nextSyncTokens, calendarIds: h.ports.calendar.calendars.map((c) => c.calendarId), complete: changes.complete });
});
afterAll(async () => h.close());

const HEALTH_WORDS = /\b(health|period|symptom|pain|sleep|mood|anxious|depress|tired|ill|sick)\b/i;
const person = (id: string) => h.rt.as({ kind: ActorKind.person, person: id });
const facts = (date: LocalDate): Promise<HouseFacts> => gatherFacts(h.rt, date, 2);
const heavyDay = (who: string, date: LocalDate) => h.rt.system("t").wellbeing.upsertScore({ person: who, date, score: 6, heavy: true, freeHours: 0, factors: [{ factor: WellbeingFactor.soloKidHours, value: 12, points: 6 }] });

describe("wellbeing", () => {
  test("[WB-1][WB-6] the score comes only from what the app knows, and says exactly what went into it", async () => {
    const wed = await facts("2026-11-04");
    const priya = scoreDay({ facts: wed, person: "priya", date: "2026-11-04", doneCount: 0, healthHeavy: null });
    const tom = scoreDay({ facts: wed, person: "tom", date: "2026-11-04", doneCount: 0, healthHeavy: null });
    expect(priya.factors.find((f) => f.factor === WellbeingFactor.soloKidHours)?.value).toBe(11);
    expect(priya.heavy).toBe(true);
    expect(tom.factors.find((f) => f.factor === WellbeingFactor.workEvents)?.value).toBe(1);
    expect(tom.factors.find((f) => f.factor === WellbeingFactor.earlyStarts)?.value).toBe(1);
    expect(priya.factors.map((f) => f.factor)).toEqual([WellbeingFactor.soloKidHours, WellbeingFactor.workEvents, WellbeingFactor.earlyStarts, WellbeingFactor.hardMode, WellbeingFactor.doneCount]);
    for (const f of priya.factors) expect(WellbeingFactorLabel[f.factor]).toBeTruthy();
    expect(priya.score).toBe(priya.factors.reduce((s, f) => s + f.points, 0));
    const sat = scoreDay({ facts: await facts("2026-11-07"), person: "priya", date: "2026-11-07", doneCount: 4, healthHeavy: null });
    expect(sat.heavy).toBe(false);
  });

  test("[WB-1] it never reads mood from how we write: the scorer takes no message text at all", () => {
    expectTypeOf<keyof ScoreInput>().toEqualTypeOf<"facts" | "person" | "date" | "doneCount" | "healthHeavy">();
    expectTypeOf<keyof HouseFacts>().not.toEqualTypeOf<"messages">();
    const factKeys: (keyof HouseFacts)[] = ["timeZone", "latitude", "longitude", "people", "events", "rules", "nurseryTerms", "nurseryEvents", "sitters", "sitterBookings", "arrivals", "mode", "forecast"];
    for (const k of factKeys) expect(k).not.toMatch(/message|text|reply/i);
  });

  test("[WB-6] each of us can switch it off: no score is kept for someone who has", async () => {
    await person("tom").household.updateMySettings({ wellbeingEnabled: false });
    await updateScores(h.rt, "2026-11-04", await facts("2026-11-04"));
    const api = h.rt.system("t");
    expect(await api.wellbeing.scores({ person: "tom", from: "2026-11-04", to: "2026-11-04" })).toEqual([]);
    const [mine] = await api.wellbeing.scores({ person: "priya", from: "2026-11-04", to: "2026-11-04" });
    expect(mine?.heavy).toBe(true);
    expect(mine?.factors.length).toBeGreaterThanOrEqual(5);
    await person("tom").household.updateMySettings({ wellbeingEnabled: true });
  });

  test("[WB-4] on a heavy day the app knows who it is, so a free hour stays free", async () => {
    expect(await heavyPeople(h.rt, "2026-11-04", await facts("2026-11-04"))).toContain("priya");
    expect(await heavyPeople(h.rt, "2026-11-07", await facts("2026-11-07"))).not.toContain("priya");
  });

  test("[WB-7][PRV-2] health tracking: only its owner adds to it, it is stored separately, and it counts only if she turns it on", async () => {
    await expect(person("tom").health.add({ date: "2026-11-04", heavy: true })).rejects.toThrow(/PRV-2/);
    await expect(person("tom").health.mine()).rejects.toThrow(/PRV-2/);
    await person("priya").health.add({ date: "2026-11-04", heavy: true });
    expect((await person("priya").health.mine()).length).toBe(1);
    // Its own database: the health table exists only in the health domain's database.
    const healthDb = await h.rt.dbs.health.$client.query("select count(*)::int as n from entries");
    expect(healthDb.rows[0]?.n).toBe(1);
    const elsewhere = await h.rt.dbs.wellbeing.$client.query("select to_regclass('entries') as t");
    expect(elsewhere.rows[0]?.t).toBeNull();

    const wed = await facts("2026-11-04");
    await updateScores(h.rt, "2026-11-04", wed);
    const [off] = await h.rt.system("t").wellbeing.scores({ person: "priya", from: "2026-11-04", to: "2026-11-04" });
    expect(off?.factors.some((f) => f.factor === WellbeingFactor.health)).toBe(false);
    await person("priya").household.updateMySettings({ healthInScore: true });
    await updateScores(h.rt, "2026-11-04", wed);
    const [on] = await h.rt.system("t").wellbeing.scores({ person: "priya", from: "2026-11-04", to: "2026-11-04" });
    expect(on?.factors.find((f) => f.factor === WellbeingFactor.health)?.points).toBeGreaterThan(0);
    await person("priya").household.updateMySettings({ healthInScore: false });
  });

  test("[WB-2][WB-3] after three heavy days in a row, the other person is asked first, and only then the person themself", async () => {
    for (const d of ["2026-10-30", "2026-10-31", "2026-11-01"]) await heavyDay("priya", d);
    const day1 = await wellbeingNudges(h.rt, "2026-11-02");
    expect(day1).toHaveLength(1);
    expect(day1[0]?.person).toBe("tom");
    expect(day1[0]?.message).toBe("Priya's had three heavy days. Could you take Saturday morning?");
    expect(day1[0]?.countsTowardsBudget).toBe(true);
    expect(day1[0]?.actions.map((a) => a.kind)).toContain(ActionKind.notHelpful);
    expect(await wellbeingNudges(h.rt, "2026-11-02")).toEqual([]);

    await heavyDay("priya", "2026-11-02");
    const day2 = await wellbeingNudges(h.rt, "2026-11-03");
    expect(day2).toHaveLength(1);
    expect(day2[0]?.person).toBe("priya");
    const ideas = (await h.rt.system("t").household.wellbeingIdeas()).map((i) => i.text.toLowerCase());
    expect(ideas.some((idea) => day2[0]?.message.includes(idea))).toBe(true);
    expect(await wellbeingNudges(h.rt, "2026-11-04")).toEqual([]);
    for (const n of [...day1, ...day2]) expect(n.message).not.toMatch(HEALTH_WORDS);
  });

  test("[WB-5] one tap on 'not helpful' stops them for a month; never more than twice a week", async () => {
    const api = h.rt.system("t");
    await respond(jobScope(h.rt, "job-wb5", "msg-wb5", "tom", Channel.telegram), "wellbeing:priya:2026-10-30:other", ActionKind.notHelpful, null);
    for (const d of ["2026-11-06", "2026-11-07", "2026-11-08"]) await heavyDay("priya", d);
    h.ports.clock.set("2026-11-09T08:00:00.000Z", true);
    const after = await wellbeingNudges(h.rt, "2026-11-09");
    expect(after.some((n) => n.person === "tom")).toBe(false);
    const until = await api.wellbeing.mutedUntil({ person: "tom" });
    expect(until).not.toBeNull();
    expect(new Date(until ?? 0).getTime() - new Date("2026-11-02T07:00:00Z").getTime()).toBeGreaterThanOrEqual(29 * 86_400_000);

    // Tom is muted, so Priya hears the next day — but she already had one this week, and two is the most.
    for (const d of ["2026-11-09", "2026-11-10"]) await heavyDay("priya", d);
    for (let i = 0; i < 4; i++) {
      const date = addLocalDays("2026-11-10", i);
      h.ports.clock.set(`${date}T08:00:00.000Z`, true);
      await wellbeingNudges(h.rt, date);
    }
    const toPriya = (await api.wellbeing.nudges()).filter((n) => n.to === "priya");
    for (const n of toPriya) expect(toPriya.filter((m) => m.date > addLocalDays(n.date, -7) && m.date <= n.date).length).toBeLessThanOrEqual(2);
    h.ports.clock.set("2026-11-02T07:00:00.000Z", true);
  });

  test("[WB-7] nothing the app says or has learned mentions health", async () => {
    for (const s of await learnedSentences(h.rt)) expect(s.text).not.toMatch(HEALTH_WORDS);
    for (const n of await h.rt.system("t").wellbeing.nudges()) expect(n.about).not.toMatch(HEALTH_WORDS);
  });

  test("[WB-8] the only things kept are the daily score and what it was made from — no mood, sleep or condition", () => {
    expect(Object.values(wellbeingSchema).filter((v) => is(v, PgTable))).toHaveLength(3);
    const tables = [wellbeingSchema.scores, wellbeingSchema.nudges, wellbeingSchema.mutes];
    const columns = Object.fromEntries(tables.map((t) => [getTableConfig(t).name, getTableConfig(t).columns.map((c) => c.name).sort()]));
    expect(columns).toEqual({
      scores: ["date", "factors", "free_hours", "heavy", "id", "person", "score"].sort(),
      nudges: ["about", "at", "date", "id", "to_person"].sort(),
      mutes: ["person", "until"].sort(),
    });
    for (const cols of Object.values(columns)) for (const c of cols) expect(c).not.toMatch(/mood|sleep|condition|diagnos|symptom|health/);
  });
});
