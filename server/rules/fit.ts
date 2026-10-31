/**
 * Gaps: windows in the week where a backlog item's tags all hold. This is constraint matching,
 * not judgement; the agent only chooses which fitting item to offer and words it.
 */
import { type BacklogItem, BacklogTag, BacklogTagLabel, DurationMinutes, DurationTag as Durations, type DurationTag, type LocalDate } from "@household/contracts";
import { addLocalDays, atLocal, weekdayOf } from "../time.ts";
import { adultsOf, DAY_END_HOUR, DAY_START_HOUR, type HouseFacts, isBusy, isDaylight, isDryHour, KIDS_BEDTIME_HOUR, kidsOf } from "./day.ts";
import { kidsAtNursery } from "./nudges.ts";

export type Slot = { date: LocalDate; startHour: number; endHour: number; who: string[]; why: string[] };

const DEFAULT_MINUTES = 30;
const WEEKEND: ReadonlySet<string> = new Set<string>(["sat", "sun"]);

function durationOf(item: Pick<BacklogItem, "tags">): number {
  const d = item.tags.find((t): t is DurationTag => Object.values(Durations).some((x) => x === t));
  return d === undefined ? DEFAULT_MINUTES : DurationMinutes[d];
}

function kidsElsewhere(facts: HouseFacts, date: LocalDate, hour: number): string | null {
  if (hour >= KIDS_BEDTIME_HOUR + 1) return "kids asleep";
  const at = atLocal(date, hour, 0, facts.timeZone);
  const kids = kidsOf(facts.people).map((k) => k.id);
  if (kids.length === 0) return "no kids";
  const away = facts.events.find((e) => kids.every((k) => e.attendees.includes(k)) && new Date(e.start) <= at && new Date(e.end) > at);
  if (away !== undefined) return away.title.replace(/^Kids at /, "kids at ");
  const nursery = kidsAtNursery(facts, date);
  if (hour >= 9 && hour < 15 && kids.every((k) => nursery.includes(k))) return "kids at nursery";
  return null;
}

/** For one hour: which tags hold, who is free, and the plain reasons. */
function hourFacts(facts: HouseFacts, date: LocalDate, hour: number) {
  const at = atLocal(date, hour, 0, facts.timeZone);
  const adults = adultsOf(facts.people).map((a) => a.id);
  const free = adults.filter((a) => !isBusy(facts, a, at) && !isBusy(facts, a, new Date(at.getTime() + 59 * 60_000)));
  const kidsAway = kidsElsewhere(facts, date, hour);
  const weekday = weekdayOf(date);
  const holds = new Set<BacklogTag>([BacklogTag.quick, BacklogTag.short, BacklogTag.halfDay]);
  if (isDaylight(facts, at) && isDaylight(facts, new Date(at.getTime() + 59 * 60_000))) holds.add(BacklogTag.daylight);
  if (isDryHour(facts, date, hour)) holds.add(BacklogTag.dry);
  if (free.length === adults.length && adults.length > 0) holds.add(BacklogTag.bothHome);
  if (kidsAway !== null) holds.add(BacklogTag.noKids);
  if (free.length > 0) holds.add(BacklogTag.phoneCall);
  if (!WEEKEND.has(weekday) && hour >= 9 && hour < 17) holds.add(BacklogTag.officeHours);
  if (free.length > 0 && hour >= 9 && hour < 18) holds.add(BacklogTag.tripOut);
  return { free, holds, kidsAway };
}

/** The earliest window in the next `days` days where every tag holds for long enough, with someone free. */
export function findSlot(facts: HouseFacts, item: Pick<BacklogItem, "tags">, from: Date, fromDate: LocalDate, days = 7): Slot | null {
  const needHours = Math.max(1, Math.ceil(durationOf(item) / 60));
  const needs = item.tags.filter((t) => !Object.values(Durations).some((d) => d === t));
  for (let d = 0; d < days; d++) {
    const date = addLocalDays(fromDate, d);
    let runStart: number | null = null;
    let who: string[] = [];
    let kidsNote: string | null = null;
    for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h++) {
      const at = atLocal(date, h, 0, facts.timeZone);
      const f = hourFacts(facts, date, h);
      const ok = at >= from && f.free.length > 0 && needs.every((t) => f.holds.has(t));
      if (!ok) {
        runStart = null;
        continue;
      }
      if (runStart === null) {
        runStart = h;
        who = f.free;
        kidsNote = f.kidsAway;
      } else {
        who = who.filter((w) => f.free.includes(w));
      }
      if (who.length === 0) {
        runStart = null;
        continue;
      }
      if (h - runStart + 1 >= needHours) {
        const why: string[] = [];
        if (needs.includes(BacklogTag.dry)) why.push("dry");
        if (needs.includes(BacklogTag.daylight)) why.push("light");
        if (needs.includes(BacklogTag.bothHome)) why.push("both home");
        if (needs.includes(BacklogTag.noKids) && kidsNote !== null) why.push(kidsNote);
        if (needs.includes(BacklogTag.officeHours)) why.push("office hours");
        return { date, startHour: runStart, endHour: runStart + needHours, who, why };
      }
    }
  }
  return null;
}

/** "Needs dry weather and both home" — what an item is waiting for (CAP-4). */
export function waitingFor(item: Pick<BacklogItem, "tags">): string {
  const needs = item.tags.filter((t) => !Object.values(Durations).some((d) => d === t)).map((t) => BacklogTagLabel[t].toLowerCase().replace(/^needs /, ""));
  const minutes = durationOf(item);
  const parts = [...needs, minutes >= 240 ? "a free half-day" : minutes >= 60 ? "a free hour" : "a free half-hour"];
  return `Needs ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`}`;
}

export function partOfDay(hour: number): string {
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}
