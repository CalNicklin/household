/**
 * WB-1: how heavy a day was, worked out only from things the app already knows. The inputs are
 * calendar facts, the house mode, a count of things done and (WB-7, only when its owner opted in)
 * one health flag. There is no message text anywhere in the inputs: it never reads mood from words.
 */
import { type LocalDate, ModeKind, WellbeingFactor, type WellbeingScore } from "@household/contracts";
import { adultsOf, type HouseFacts, isAway, isBusy, kidsOf, modeOn } from "../rules/day.ts";
import { kidsAtNursery } from "../rules/nudges.ts";
import { atLocal, localDate, localHour, localTime } from "../time.ts";

/** A day at or above this many points is heavy. Chosen so a long solo day with the kids, or a work day with an early start and nothing done, counts. */
const HEAVY_SCORE = 4;
/** "No free time": fewer than this many waking hours with nothing on. */
export const FREE_TIME_HOURS = 1;

const WAKING_START = 7;
const WAKING_END = 21;
const KIDS_AWAKE_END = 19;
const EARLY_START = "07:30";
const NURSERY_START = 9;
const NURSERY_END = 15;

const POINTS = {
  soloKidHour: 0.5,
  workEvent: 1.5,
  earlyStart: 2,
  hardMode: 2,
  nothingDone: 1,
  plentyDone: -1,
  healthHeavy: 2,
} as const;
const PLENTY_DONE = 3;

export type ScoreInput = {
  facts: HouseFacts;
  person: string;
  date: LocalDate;
  /** Things this person marked Done that day. */
  doneCount: number;
  /** WB-7: null unless the health owner turned "health in score" on. */
  healthHeavy: boolean | null;
};

function kidsHomeAt(facts: HouseFacts, date: LocalDate, hour: number): boolean {
  const kids = kidsOf(facts.people).map((k) => k.id);
  if (kids.length === 0) return false;
  const atNursery = hour >= NURSERY_START && hour < NURSERY_END ? kidsAtNursery(facts, date) : [];
  const at = atLocal(date, hour, 0, facts.timeZone);
  const outWithEvent = new Set(facts.events.filter((e) => new Date(e.start) <= at && new Date(e.end) > at).flatMap((e) => e.attendees));
  return kids.some((k) => !atNursery.includes(k) && !outWithEvent.has(k));
}

function soloAt(facts: HouseFacts, person: string, date: LocalDate, hour: number): boolean {
  if (hour >= KIDS_AWAKE_END) return false;
  const at = atLocal(date, hour, 0, facts.timeZone);
  const t = at.getTime();
  const flagged = facts.events.some((e) => e.soloWithKids === person && new Date(e.start).getTime() <= t && new Date(e.end).getTime() > t);
  if (flagged) return true;
  const others = adultsOf(facts.people).filter((a) => a.id !== person);
  return others.length > 0 && others.every((o) => isAway(facts, o.id, at)) && !isAway(facts, person, at) && kidsHomeAt(facts, date, hour);
}

function hardModeOn(facts: HouseFacts, date: LocalDate): boolean {
  // A score is for the whole day, so a slow day ended in the afternoon still counts (no `now`).
  const m = modeOn(facts, date);
  return m !== null && (m.mode === ModeKind.slow || m.mode === ModeKind.sick);
}

export function scoreDay(input: ScoreInput): WellbeingScore {
  const { facts, person, date } = input;
  const tz = facts.timeZone;
  const mine = facts.events.filter((e) => (e.attendees.includes(person) || e.away.includes(person)) && localDate(new Date(e.start), tz) === date);
  let soloHours = 0;
  let freeHours = 0;
  for (let h = WAKING_START; h < WAKING_END; h++) {
    const solo = soloAt(facts, person, date, h);
    if (solo) soloHours += 1;
    const at = atLocal(date, h, 0, tz);
    if (!solo && !isBusy(facts, person, at) && !isBusy(facts, person, new Date(at.getTime() + 59 * 60_000))) freeHours += 1;
  }
  const work = mine.filter((e) => e.work).length;
  const early = mine.some((e) => !e.allDay && localTime(new Date(e.start), tz) < EARLY_START && localHour(new Date(e.start), tz) >= 4) ? 1 : 0;
  const hard = hardModeOn(facts, date) ? 1 : 0;
  const donePoints = input.doneCount === 0 ? POINTS.nothingDone : input.doneCount >= PLENTY_DONE ? POINTS.plentyDone : 0;
  const factors: WellbeingScore["factors"] = [
    { factor: WellbeingFactor.soloKidHours, value: soloHours, points: soloHours * POINTS.soloKidHour },
    { factor: WellbeingFactor.workEvents, value: work, points: work * POINTS.workEvent },
    { factor: WellbeingFactor.earlyStarts, value: early, points: early * POINTS.earlyStart },
    { factor: WellbeingFactor.hardMode, value: hard, points: hard * POINTS.hardMode },
    { factor: WellbeingFactor.doneCount, value: input.doneCount, points: donePoints },
  ];
  if (input.healthHeavy !== null) factors.push({ factor: WellbeingFactor.health, value: input.healthHeavy ? 1 : 0, points: input.healthHeavy ? POINTS.healthHeavy : 0 });
  const score = Math.max(0, factors.reduce((s, f) => s + f.points, 0));
  return { person, date, score, heavy: score >= HEAVY_SCORE, freeHours, factors };
}
