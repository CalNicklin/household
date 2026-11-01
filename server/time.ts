import { TZDate } from "@date-fns/tz";
import { type LocalDate, type Weekday, WeekdayOrder } from "@household/contracts";
import { addDays, differenceInCalendarDays, format, getISOWeek, parseISO } from "date-fns";

/** The house's local calendar date for an instant. */
export function localDate(at: Date, timeZone: string): LocalDate {
  return format(new TZDate(at, timeZone), "yyyy-MM-dd");
}

export function localHour(at: Date, timeZone: string): number {
  return new TZDate(at, timeZone).getHours();
}

export function localTime(at: Date, timeZone: string): string {
  return format(new TZDate(at, timeZone), "HH:mm");
}

/** The instant a local date starts in the house's time zone. */
export function startOfLocalDay(date: LocalDate, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(new TZDate(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0, timeZone).getTime());
}

export function atLocal(date: LocalDate, hour: number, minute: number, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(new TZDate(y ?? 1970, (m ?? 1) - 1, d ?? 1, hour, minute, 0, timeZone).getTime());
}

/** MOM-4: midnight at the end of the local day that contains `at`. */
export function nextLocalMidnight(at: Date, timeZone: string): Date {
  return startOfLocalDay(addLocalDays(localDate(at, timeZone), 1), timeZone);
}

export function addLocalDays(date: LocalDate, days: number): LocalDate {
  return format(addDays(parseISO(date), days), "yyyy-MM-dd");
}

export function daysBetween(from: LocalDate, to: LocalDate): number {
  return differenceInCalendarDays(parseISO(to), parseISO(from));
}

export function weekdayOf(date: LocalDate): Weekday {
  const day = parseISO(date).getDay();
  const index = (day + 6) % 7;
  const weekday = WeekdayOrder[index];
  if (weekday === undefined) throw new Error(`bad date ${date}`);
  return weekday;
}

export function isoWeek(date: LocalDate): number {
  return getISOWeek(parseISO(date));
}

export function longDate(date: LocalDate): string {
  return format(parseISO(date), "EEEE d MMMM");
}

export function shortWeekday(date: LocalDate): string {
  return format(parseISO(date), "EEEE");
}

/** "13:00" style clock for an instant in the house time zone. */
export function clock(at: Date | string, timeZone: string): string {
  return localTime(typeof at === "string" ? new Date(at) : at, timeZone);
}

/** "2pm" style hour for reasons ("dry until 2pm"). */
export function hourWord(hour: number): string {
  if (hour === 0) return "midnight";
  if (hour === 12) return "midday";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}
