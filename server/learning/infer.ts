/**
 * What the house's own behaviour says, worked out from the event log alone. Pure functions, so the
 * live learner and the replay over recorded days (LRN-9) use exactly the same logic.
 */
import { ActionKind, type DayPart, type LearningEvent, Limits, type Weekday, WeekdayOrder } from "@household/contracts";

/** Event shape the inference needs; recorded days (practice/days) carry exactly this. */
export type LearnEvent = Pick<LearningEvent, "kind" | "subject" | "ref" | "person" | "date" | "dayPart" | "weekday" | "at">;

/** Refs that are not unscheduled chores: one-off jobs, calendar facts and rule-driven things. */
const NOT_CHORES = ["backlog:", "event:", "arrival:", "sitter:", "question:", "shopping:", "nursery", "bins:", "chore:", "wellbeing:", "handover:", "note:", "mode:"];

/** LRN-2: a chore needs this many Dones before a rhythm is inferred; fewer is a gap worth a question (LRN-4). */
export const RHYTHM_MIN_DONES = 3;
/** LRN-2: a weekday is "usual" when at least half the Dones fell on it. */
const USUAL_WEEKDAY_SHARE = 0.5;

const ACCEPTS: ReadonlySet<string> = new Set([ActionKind.accept, ActionKind.done]);
const DISMISSES: ReadonlySet<string> = new Set([ActionKind.notToday]);

function isChore(e: Pick<LearnEvent, "ref">): boolean {
  return !NOT_CHORES.some((p) => e.ref.startsWith(p));
}

const daysApart = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const hi = s[mid] ?? 0;
  const lo = s[mid - 1] ?? hi;
  return s.length % 2 === 0 ? (lo + hi) / 2 : hi;
}

/** Chore subject → how many distinct days it was done on. */
export function choreDoneDays(events: readonly LearnEvent[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of events) {
    if (e.kind !== ActionKind.done || !isChore(e)) continue;
    const days = out.get(e.subject) ?? [];
    if (!days.includes(e.date)) days.push(e.date);
    out.set(e.subject, days);
  }
  for (const days of out.values()) days.sort();
  return out;
}

export type InferredRhythm = { subject: string; everyDays: number; usualWeekday: Weekday | null };

/** LRN-2: "about every 5 days, usually Sunday" — the median gap between Dones. */
export function inferRhythms(events: readonly LearnEvent[]): InferredRhythm[] {
  const out: InferredRhythm[] = [];
  for (const [subject, days] of choreDoneDays(events)) {
    if (days.length < RHYTHM_MIN_DONES) continue;
    const gaps = days.slice(1).map((d, i) => daysApart(days[i] ?? d, d));
    const everyDays = Math.max(1, Math.round(median(gaps)));
    const counts = new Map<Weekday, number>();
    for (const d of days) {
      const wd = WeekdayOrder[(new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7];
      if (wd !== undefined) counts.set(wd, (counts.get(wd) ?? 0) + 1);
    }
    const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const usualWeekday = top !== undefined && top[1] / days.length >= USUAL_WEEKDAY_SHARE ? top[0] : null;
    out.push({ subject, everyDays, usualWeekday });
  }
  return out;
}

export type AvoidPair = { key: string; subject: string; dayPart: DayPart; landsIn: DayPart | null };

/**
 * LRN-5: a subject's suggestions stop being offered in a day part once they have been dismissed
 * there enough times within the window and never accepted there.
 */
export function avoidPairs(events: readonly LearnEvent[], now: Date): AvoidPair[] {
  // limit: learningTimingWindowDays
  const since = now.getTime() - Limits.learningTimingWindowDays.value * 86_400_000;
  const recent = events.filter((e) => Date.parse(e.at) >= since && Date.parse(e.at) <= now.getTime());
  const stats = new Map<string, { subject: string; dayPart: DayPart; dismiss: number; accept: number }>();
  const acceptsBySubject = new Map<string, Map<DayPart, number>>();
  for (const e of recent) {
    const subject = e.subject.toLowerCase();
    const key = `${subject}|${e.dayPart}`;
    const s = stats.get(key) ?? { subject: e.subject, dayPart: e.dayPart, dismiss: 0, accept: 0 };
    if (DISMISSES.has(e.kind)) s.dismiss += 1;
    if (ACCEPTS.has(e.kind)) {
      s.accept += 1;
      const parts = acceptsBySubject.get(subject) ?? new Map<DayPart, number>();
      parts.set(e.dayPart, (parts.get(e.dayPart) ?? 0) + 1);
      acceptsBySubject.set(subject, parts);
    }
    stats.set(key, s);
  }
  const out: AvoidPair[] = [];
  for (const [key, s] of stats) {
    // limit: learningTimingMinSamples
    if (s.dismiss < Limits.learningTimingMinSamples.value || s.accept > 0) continue;
    const elsewhere = [...(acceptsBySubject.get(s.subject.toLowerCase()) ?? new Map<DayPart, number>()).entries()].filter(([p]) => p !== s.dayPart).sort((a, b) => b[1] - a[1]);
    out.push({ key, subject: s.subject, dayPart: s.dayPart, landsIn: elsewhere[0]?.[0] ?? null });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function avoidSentence(p: AvoidPair): string {
  return p.landsIn === null ? `"${p.subject}" isn't offered in the ${p.dayPart} any more` : `"${p.subject}" suggestions land in the ${p.landsIn}, not the ${p.dayPart}`;
}

/** LRN-6: one adult always says no, the other says yes — offer it to the one who takes it. */
const OFFER_MIN_DISMISSALS = 2;

export function offerTargetsFrom(events: readonly LearnEvent[]): Map<string, { subject: string; person: string }> {
  const bySubject = new Map<string, Map<string, { accept: number; dismiss: number }>>();
  for (const e of events) {
    if (!ACCEPTS.has(e.kind) && !DISMISSES.has(e.kind)) continue;
    const subject = e.subject.toLowerCase();
    const people = bySubject.get(subject) ?? new Map<string, { accept: number; dismiss: number }>();
    const p = people.get(e.person) ?? { accept: 0, dismiss: 0 };
    if (ACCEPTS.has(e.kind)) p.accept += 1;
    else p.dismiss += 1;
    people.set(e.person, p);
    bySubject.set(subject, people);
  }
  const out = new Map<string, { subject: string; person: string }>();
  for (const [subject, people] of bySubject) {
    const refuser = [...people.values()].some((p) => p.dismiss >= OFFER_MIN_DISMISSALS && p.accept === 0);
    const takers = [...people.entries()].filter(([, p]) => p.accept >= 1 && p.dismiss === 0);
    const [taker] = takers;
    if (refuser && takers.length === 1 && taker !== undefined) {
      const original = events.find((e) => e.subject.toLowerCase() === subject)?.subject ?? subject;
      out.set(subject, { subject: original, person: taker[0] });
    }
  }
  return out;
}
