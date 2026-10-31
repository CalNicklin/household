import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionKind, ActorKind, Channel, type LearningEventKind, Limits, type LocalDate, zBacklogItem } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { respond } from "../agent/respond.ts";
import { jobScope } from "../agent/scope.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { addLocalDays, atLocal, weekdayOf } from "../time.ts";
import { avoidedDayParts, learnedSentences, offerTargets, questionFor, updateLearning } from "./learn.ts";
import { type RecordedDay, replayDays } from "./replay.ts";

let h: TestHousehold;
beforeAll(async () => {
  h = await testHousehold({ jobs: false });
});
afterAll(async () => h.close());

const TZ = "Europe/London";
const person = (id: string) => h.rt.as({ kind: ActorKind.person, person: id });

async function ev(kind: LearningEventKind, subject: string, ref: string, who: string, date: LocalDate, hour: number) {
  await person(who).learning.record({
    kind,
    subject,
    ref,
    person: who,
    date,
    dayPart: hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening",
    weekday: weekdayOf(date),
    hour,
    weather: "dry 10°",
    dayMode: "normal",
    at: atLocal(date, hour, 0, TZ).toISOString(),
  });
}

const day = (date: LocalDate, responses: RecordedDay["responses"]): RecordedDay => ({
  date,
  inputs: { calendar: [{ title: "Nursery drop-off", start: `${date}T08:45:00Z`, end: `${date}T09:00:00Z` }], weather: "dry until 2pm", mode: "normal" },
  blocks: [{ id: `washing:${date}`, type: "suggestion", title: "Hang the washing out", reason: "Dry until 2pm" }],
  responses,
});
const response = (date: LocalDate, action: "done" | "not-today", hour: number) => ({
  ref: `washing:${date}:${hour}`,
  subject: "Hang the washing out",
  action,
  person: "priya",
  at: atLocal(date, hour, 0, TZ).toISOString(),
  dayPart: hour < 12 ? ("morning" as const) : ("evening" as const),
  weekday: weekdayOf(date),
});

describe("learning", () => {
  test("[LRN-1] a Done is remembered with the day, time, weather, mood of the day and who did it", async () => {
    await respond(jobScope(h.rt, "job-lrn1", "msg-lrn1", "priya", Channel.app), "washing:2026-11-02", ActionKind.done, null);
    const e = (await h.rt.system("t").learning.events()).find((x) => x.ref === "washing:2026-11-02");
    expect(e).toMatchObject({ kind: "done", person: "priya", date: "2026-11-02", weekday: "mon", dayPart: "morning", hour: 7, dayMode: "normal" });
    expect(e?.weather).toMatch(/^(dry|wet) \d+°$/);
  });

  test("[LRN-2] how often a chore happens is worked out from when we mark it done, shown as a number", async () => {
    for (const d of ["2026-10-08", "2026-10-13", "2026-10-18", "2026-10-23", "2026-10-28"]) await ev("done", "Dark wash", "chore-log:dark-wash", "priya", d, 9);
    for (const d of ["2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25"]) await ev("done", "Towels", "chore-log:towels", "tom", d, 10);
    await updateLearning(h.rt, "2026-11-02");
    const sentences = (await learnedSentences(h.rt)).map((s) => s.text);
    expect(sentences).toContain("Dark wash: about every 5 days");
    expect(sentences).toContain("Towels: about every week, usually Sunday");
  });

  test("[LRN-2] a number you changed is never overwritten by what was learned", async () => {
    const rhythm = (await h.rt.system("t").learning.rhythms()).find((r) => r.subject === "Dark wash");
    if (rhythm === undefined) throw new Error("no rhythm");
    await person("priya").learning.editRhythm({ id: rhythm.id, everyDays: 4 });
    await updateLearning(h.rt, "2026-11-02");
    const after = (await h.rt.system("t").learning.rhythms()).find((r) => r.subject === "Dark wash");
    expect(after?.everyDays).toBe(4);
    expect(after?.source).toBe("edited");
  });

  test("[LRN-3][LRN-4] one one-tap question a day, about a specific gap, never the same twice", async () => {
    await ev("done", "Hoovering", "chore-log:hoovering", "tom", "2026-10-30", 18);
    const day1 = await questionFor(h.rt, "2026-11-02");
    expect(day1?.topic).toBe("chore-rhythm");
    expect(day1?.text).toBe("How often do you do the hoovering?");
    expect(day1?.options.map((o) => o.label)).toEqual(["3 days", "5 days", "Weekly"]);
    // Asked again the same day (another re-plan): the same question, not a new one.
    expect((await questionFor(h.rt, "2026-11-02"))?.id).toBe(day1?.id);
    if (day1 === null) throw new Error("no question");
    await respond(jobScope(h.rt, "job-q1", "msg-q1", "tom", Channel.app), `question:${day1.id}`, ActionKind.answer, "7");
    expect(await questionFor(h.rt, "2026-11-02")).toBeNull();

    const asked = [day1];
    for (let i = 1; i <= 4; i++) {
      const q = await questionFor(h.rt, addLocalDays("2026-11-02", i));
      if (q !== null) asked.push(q);
    }
    const subjects = asked.map((q) => `${q.topic}|${q.subject}`);
    expect(new Set(subjects).size).toBe(subjects.length);
    for (const q of asked) {
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      // limit: shoppingMaxOptions
      expect(q.options.length).toBeLessThanOrEqual(Limits.shoppingMaxOptions.value);
      expect(["chore-rhythm", "job-length", "sitter-days"]).toContain(q.topic);
    }
    expect(asked.some((q) => q.topic === "job-length" && q.text.includes("Find a plumber for the bathroom tap"))).toBe(true);
    expect(asked.some((q) => q.topic === "sitter-days" && q.subject === "Marta")).toBe(true);
    expect((await h.rt.system("t").learning.rhythms()).find((r) => r.subject === "Hoovering")?.everyDays).toBe(7);
  });

  test("[LRN-4] answering how long a job takes gives it that rough length", async () => {
    const q = (await h.rt.system("t").learning.questions()).find((x) => x.topic === "job-length");
    if (q === undefined) throw new Error("no job-length question");
    await respond(jobScope(h.rt, "job-q2", "msg-q2", "priya", Channel.app), `question:${q.id}`, ActionKind.answer, "short");
    await updateLearning(h.rt, q.askedOn);
    const item = await h.rt.system("t").backlog.get({ id: q.subject });
    expect(item?.tags).toContain("short");
    expect(item?.confirmedTags).toBe(true);
  });

  test("[LRN-5] evening washing suggestions stop within two weeks when they are always dismissed", async () => {
    const start = "2026-10-19";
    let avoidedOnDay: number | null = null;
    for (let d = 0; d < 14; d++) {
      const date = addLocalDays(start, d);
      await ev("done", "Hang the washing out", `washing:${date}`, "priya", date, 8);
      await ev("not-today", "Hang the washing out", `washing:${date}:pm`, "priya", date, 18);
      h.ports.clock.set(atLocal(date, 23, 0, TZ), true);
      if (avoidedOnDay === null && (await avoidedDayParts(h.rt)).has("hang the washing out|evening")) avoidedOnDay = d + 1;
    }
    h.ports.clock.set("2026-11-02T07:00:00.000Z", true);
    expect(avoidedOnDay).not.toBeNull();
    // limit: learningTimingWindowDays
    expect(avoidedOnDay ?? 99).toBeLessThanOrEqual(Limits.learningTimingWindowDays.value);
    const avoided = await avoidedDayParts(h.rt);
    expect(avoided.has("hang the washing out|evening")).toBe(true);
    expect(avoided.has("hang the washing out|morning")).toBe(false);
    await updateLearning(h.rt, "2026-11-02");
    expect((await learnedSentences(h.rt)).map((s) => s.text)).toContain('"Hang the washing out" suggestions land in the morning, not the evening');
  });

  test("[LRN-6] a job one of us always dismisses and the other accepts is offered to the one who takes it", async () => {
    await ev("not-today", "Bins out", "bins:2026-10-26", "tom", "2026-10-26", 19);
    await ev("not-today", "Bins out", "bins:2026-10-19", "tom", "2026-10-19", 19);
    await ev("done", "Bins out", "bins:2026-10-19", "priya", "2026-10-19", 19);
    expect((await offerTargets(h.rt)).get("bins out")).toBe("priya");
    await updateLearning(h.rt, "2026-11-02");
    expect((await learnedSentences(h.rt)).map((s) => s.text)).toContain('Priya usually takes "Bins out"');
  });

  test("[LRN-7] everything learned is a plain sentence; delete one and it forgets for good", async () => {
    const sentences = await learnedSentences(h.rt);
    const towels = sentences.find((s) => s.text.startsWith("Towels:"));
    const avoid = sentences.find((s) => s.kind === "avoid-daypart");
    if (towels === undefined || avoid === undefined) throw new Error("missing sentences");
    await person("tom").learning.forgetRhythm({ id: towels.id });
    await person("priya").learning.forgetPreference({ id: avoid.id });
    for (const d of ["2026-10-26", "2026-10-29", "2026-11-01"]) await ev("done", "Towels", "chore-log:towels", "tom", d, 10);
    await updateLearning(h.rt, "2026-11-02");
    const after = (await learnedSentences(h.rt)).map((s) => s.text);
    expect(after.some((t) => t.startsWith("Towels:"))).toBe(false);
    expect(after.some((t) => t.includes("suggestions land"))).toBe(false);
    expect((await avoidedDayParts(h.rt)).has("hang the washing out|evening")).toBe(false);
  });

  test("[LRN-8] what it learns never turns into a deadline: no due dates exist, and learning writes no calendar, rule or backlog item", async () => {
    const keys = Object.keys(zBacklogItem.shape);
    for (const banned of ["due", "dueDate", "deadline", "priority", "overdue"]) expect(keys).not.toContain(banned);
    const api = h.rt.system("t");
    const snapshot = async () => ({
      rules: JSON.stringify(await api.household.rules()),
      calendar: JSON.stringify(await api.calendar.between({ from: "2026-01-01T00:00:00Z", to: "2027-12-31T00:00:00Z" })),
      backlog: JSON.stringify((await api.backlog.list()).map((i) => [i.id, i.text, i.status])),
      plans: JSON.stringify(await api.plans.plannedDates()),
    });
    const before = await snapshot();
    await updateLearning(h.rt, "2026-11-03");
    expect(await snapshot()).toEqual(before);
    const source = readFileSync(path.join(import.meta.dirname, "learn.ts"), "utf8");
    for (const write of ["createRule", "updateRule", "deleteRule", "applySync", "backlog.create", "backlog.remove", "plans.save", "notify("]) expect(source).not.toContain(write);
  });

  test("[LRN-9] recorded days can be replayed to check learning against what actually happened", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "days-"));
    const days = [day("2026-10-01", [response("2026-10-01", "not-today", 18), response("2026-10-01", "not-today", 19)]), day("2026-10-02", [response("2026-10-02", "done", 8), response("2026-10-02", "not-today", 18)]), day("2026-10-03", [response("2026-10-03", "done", 8), response("2026-10-03", "not-today", 18)])];
    for (const d of days) writeFileSync(path.join(dir, `${d.date}.json`), JSON.stringify(d));
    expect(replayDays(dir)).toEqual({ days: 3, correctlyAvoided: 1, wronglyAvoided: 0, missed: 3 });
  });
});
