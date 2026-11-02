import { TZDate } from "@date-fns/tz";
import { type LocalDate, type Weekday, WeekdayOrder } from "@household/contracts";
import { addDays, differenceInCalendarDays, format, getISOWeek, isValid, parseISO } from "date-fns";

/** Is this yyyy-MM-dd a day that exists (not 31 November, not 30 February)? */
export function isRealDate(date: string): boolean {
  const parsed = parseISO(date);
  return isValid(parsed) && format(parsed, "yyyy-MM-dd") === date;
}

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

/** HOU-173: a part of a day said from the real today: "this morning", "tomorrow evening", "Wednesday afternoon". */
export function dayPartWords(date: LocalDate, today: LocalDate, part: string): string {
  if (date === today) return `this ${part}`;
  if (date === addLocalDays(today, 1)) return `tomorrow ${part}`;
  return `${shortWeekday(date)} ${part}`;
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
