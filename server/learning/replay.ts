/**
 * LRN-9: score the current learning logic against recorded days. Each day file holds what the
 * planner was given, what it produced and what we did with it (practice/days/README.md). For each
 * day, learning is replayed from the days before it only, then compared with what really happened.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ActionKind, zActionKind, zDayPart, zLocalDate, zModeKind, zWeekday } from "@household/contracts";
import { z } from "zod";
import { avoidPairs, type LearnEvent } from "./infer.ts";

export const zRecordedDay = z.object({
  date: zLocalDate,
  inputs: z.object({
    calendar: z.array(z.object({ title: z.string(), start: z.string(), end: z.string() })),
    weather: z.string(),
    mode: zModeKind,
  }),
  blocks: z.array(z.object({ id: z.string(), type: z.string(), title: z.string(), reason: z.string() })),
  responses: z.array(
    z.object({
      ref: z.string(),
      subject: z.string(),
      action: zActionKind,
      person: z.string(),
      at: z.string(),
      dayPart: zDayPart,
      weekday: zWeekday,
    }),
  ),
});
export type RecordedDay = z.infer<typeof zRecordedDay>;

export type ReplayScore = {
  days: number;
  /** Suggestions the learning would now hold back that were in fact dismissed. */
  correctlyAvoided: number;
  /** Suggestions it would now hold back that were in fact accepted or done. */
  wronglyAvoided: number;
  /** Dismissed suggestions it would still have offered. */
  missed: number;
};

const ACCEPTED: ReadonlySet<string> = new Set([ActionKind.accept, ActionKind.done]);

function toEvents(day: RecordedDay): LearnEvent[] {
  const out: LearnEvent[] = [];
  for (const r of day.responses) {
    const kind = r.action === ActionKind.accept ? ActionKind.accept : r.action === ActionKind.done ? ActionKind.done : r.action === ActionKind.notToday ? ActionKind.notToday : null;
    if (kind !== null) out.push({ kind, subject: r.subject, ref: r.ref, person: r.person, date: day.date, dayPart: r.dayPart, weekday: r.weekday, at: r.at });
  }
  return out;
}

function scoreDays(days: readonly RecordedDay[]): ReplayScore {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const score: ReplayScore = { days: sorted.length, correctlyAvoided: 0, wronglyAvoided: 0, missed: 0 };
  const history: LearnEvent[] = [];
  for (const day of sorted) {
    const avoided = new Set(avoidPairs(history, new Date(`${day.date}T00:00:00Z`)).map((p) => p.key));
    for (const r of day.responses) {
      const held = avoided.has(`${r.subject.toLowerCase()}|${r.dayPart}`);
      const dismissed = r.action === ActionKind.notToday;
      if (held && dismissed) score.correctlyAvoided += 1;
      else if (held && ACCEPTED.has(r.action)) score.wronglyAvoided += 1;
      else if (!held && dismissed) score.missed += 1;
    }
    history.push(...toEvents(day));
  }
  return score;
}

function readDays(dir: string): RecordedDay[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => zRecordedDay.parse(JSON.parse(readFileSync(path.join(dir, f), "utf8"))));
}

export function replayDays(dir: string): ReplayScore {
  return scoreDays(readDays(dir));
}
