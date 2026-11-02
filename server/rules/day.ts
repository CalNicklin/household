/**
 * Facts about one day, worked out from inputs without a model: who is home when, daylight, dry
 * windows, and the one context line at the top of the screen (HOME-2).
 */
import type { Arrival, CalendarEvent, LocalDate, Mode, NurseryEvent, NurseryTerm, Person, Rule, Sitter, SitterBooking } from "@household/contracts";
import { ModeKind, PersonRole } from "@household/contracts";
import { getTimes } from "suncalc";
import type { HourlyForecast } from "../ports.ts";
import { addLocalDays, atLocal, hourWord, localDate, localHour, localTime, startOfLocalDay } from "../time.ts";

export const DAY_START_HOUR = 7;
export const DAY_END_HOUR = 22;
export const KIDS_BEDTIME_HOUR = 19;
const WET_PERCENT = 40;

export type HouseFacts = {
  timeZone: string;
  latitude: number;
  longitude: number;
  people: Person[];
  events: CalendarEvent[];
  rules: Rule[];
  nurseryTerms: NurseryTerm[];
  nurseryEvents: NurseryEvent[];
  sitters: Sitter[];
  sitterBookings: SitterBooking[];
  arrivals: Arrival[];
  /**
   * HOU-156: every mode in effect at some point in the window, including those set ahead. Read a
   * day's mode with `modeOn`. Plans save these facts, so readers of saved plans (scripts/record-day.ts)
   * read `modes` too; plans saved before HOU-156 have the old `mode` instead.
   */
  modes: Mode[];
  /** Hourly forecast per local date. */
  forecast: Record<LocalDate, HourlyForecast[]>;
};

/**
 * MOM-1/4, HOU-156: the slow, sick or away day this date is, if any: a mode that has started by the
 * date (set that day or ahead for it) and is still on at midday. The most recently set one wins.
 * Given `now`, today's mode must also be on now, so a mode ended early ("back to normal" at 13:00)
 * is gone from the rest of today, as it was when the screen read only the mode on now.
 */
export function modeOn(facts: Pick<HouseFacts, "modes" | "timeZone">, date: LocalDate, now?: Date): Mode | null {
  const midday = atLocal(date, 12, 0, facts.timeZone);
  const onNow = now !== undefined && localDate(now, facts.timeZone) === date ? now : null;
  const on = facts.modes.filter(
    (m) =>
      m.mode !== ModeKind.normal &&
      localDate(new Date(m.startsAt), facts.timeZone) <= date &&
      new Date(m.endsAt) > midday &&
      (onNow === null || (new Date(m.startsAt) <= onNow && new Date(m.endsAt) > onNow)),
  );
  return on.sort((a, b) => b.setAt.localeCompare(a.setAt))[0] ?? null;
}

export const adultsOf = (people: readonly Person[]) => people.filter((p) => p.role === PersonRole.adult);
export const kidsOf = (people: readonly Person[]) => people.filter((p) => p.role === PersonRole.child);
export const nameOf = (people: readonly Person[], id: string) => people.find((p) => p.id === id)?.name ?? id;

export function eventsOn(facts: HouseFacts, date: LocalDate): CalendarEvent[] {
  const start = startOfLocalDay(date, facts.timeZone).getTime();
  const end = startOfLocalDay(addLocalDays(date, 1), facts.timeZone).getTime();
  return facts.events.filter((e) => new Date(e.start).getTime() < end && new Date(e.end).getTime() > start).sort((a, b) => a.start.localeCompare(b.start));
}

/** Is this adult out of the house at `at`? */
export function isAway(facts: HouseFacts, person: string, at: Date): boolean {
  const t = at.getTime();
  return facts.events.some((e) => e.away.includes(person) && new Date(e.start).getTime() <= t && new Date(e.end).getTime() > t);
}

/** Is this adult busy (in any event they attend) at `at`? */
export function isBusy(facts: HouseFacts, person: string, at: Date): boolean {
  const t = at.getTime();
  return facts.events.some((e) => (e.attendees.includes(person) || e.away.includes(person)) && new Date(e.start).getTime() <= t && new Date(e.end).getTime() > t);
}

export function homeAt(facts: HouseFacts, at: Date): string[] {
  return adultsOf(facts.people)
    .filter((a) => !isAway(facts, a.id, at))
    .map((a) => a.id);
}

/** When everyone currently home stays home until: the next time one of them leaves today. */
function homeUntil(facts: HouseFacts, date: LocalDate, from: Date): { home: string[]; until: Date | null } {
  const home = homeAt(facts, from);
  const end = startOfLocalDay(addLocalDays(date, 1), facts.timeZone);
  let until: Date | null = null;
  for (const e of facts.events) {
    const s = new Date(e.start);
    if (s <= from || s >= end) continue;
    if (e.away.some((p) => home.includes(p)) && (until === null || s < until)) until = s;
  }
  return { home, until };
}

function sun(facts: HouseFacts, date: LocalDate): { sunrise: Date; sunset: Date } {
  const times = getTimes(atLocal(date, 12, 0, facts.timeZone), facts.latitude, facts.longitude);
  // Polar days have no sunrise; the house is in Britain, so fall back to the day's edges.
  return { sunrise: times.sunrise ?? atLocal(date, 6, 0, facts.timeZone), sunset: times.sunset ?? atLocal(date, 18, 0, facts.timeZone) };
}

export function isDaylight(facts: HouseFacts, at: Date): boolean {
  const s = sun(facts, localDate(at, facts.timeZone));
  return at >= s.sunrise && at < s.sunset;
}

function hourlyFor(facts: HouseFacts, date: LocalDate): HourlyForecast[] {
  return facts.forecast[date] ?? [];
}

export function isDryHour(facts: HouseFacts, date: LocalDate, hour: number): boolean {
  const h = hourlyFor(facts, date).find((f) => Number(f.hour.slice(11, 13)) === hour);
  return h !== undefined && h.precipitationProbability < WET_PERCENT;
}

/** The longest dry run of hours starting at or after `fromHour` (inclusive start, exclusive end). */
export function dryWindowFrom(facts: HouseFacts, date: LocalDate, fromHour: number): { start: number; end: number } | null {
  let h = fromHour;
  while (h <= DAY_END_HOUR && !isDryHour(facts, date, h)) h++;
  if (h > DAY_END_HOUR) return null;
  const start = h;
  while (h <= DAY_END_HOUR && isDryHour(facts, date, h)) h++;
  return { start, end: h };
}

function weatherPhrase(facts: HouseFacts, date: LocalDate, fromHour: number): string {
  const hours = hourlyFor(facts, date);
  const temp = hours.find((f) => Number(f.hour.slice(11, 13)) >= fromHour)?.temperatureC ?? hours[0]?.temperatureC;
  const t = temp === undefined ? "" : `, ${Math.round(temp)}°`;
  // HOU-170: no forecast means the weather service was down and none was kept for this date.
  if (hours.length === 0) return "Forecast not available";
  if (isDryHour(facts, date, fromHour)) {
    const w = dryWindowFrom(facts, date, fromHour);
    if (w !== null && w.end <= DAY_END_HOUR) return `Dry until ${hourWord(w.end)}${t}`;
    return `Dry all day${t}`;
  }
  const w = dryWindowFrom(facts, date, fromHour);
  if (w === null) return `Wet all day${t}`;
  return `Wet until ${hourWord(w.start)}${t}`;
}

/** HOME-2: "Dry until 2pm, 9° · dark by 16:35 · both home until 10". */
export function contextLine(facts: HouseFacts, date: LocalDate, now: Date): string {
  const today = localDate(now, facts.timeZone) === date;
  const from = today ? now : atLocal(date, DAY_START_HOUR, 0, facts.timeZone);
  const fromHour = today ? Math.max(localHour(now, facts.timeZone), DAY_START_HOUR) : DAY_START_HOUR;
  const dark = `dark by ${localTime(sun(facts, date).sunset, facts.timeZone)}`;
  return [weatherPhrase(facts, date, fromHour), dark, presencePhrase(facts, date, from)].join(" · ");
}

function presencePhrase(facts: HouseFacts, date: LocalDate, from: Date): string {
  const adults = adultsOf(facts.people);
  const { home, until } = homeUntil(facts, date, from);
  const untilText = until === null ? "all day" : `until ${shortClock(until, facts.timeZone)}`;
  if (home.length === 0) return "nobody home";
  if (home.length === adults.length && adults.length > 1) return `both home ${untilText}`;
  return `${home.map((h) => nameOf(facts.people, h)).join(" and ")} home ${untilText}`;
}

/** "10" for 10:00, "10:30" otherwise — the canvas style for "until 10". */
export function shortClock(at: Date, timeZone: string): string {
  const t = localTime(at, timeZone);
  return t.endsWith(":00") ? String(Number(t.slice(0, 2))) : t;
}
