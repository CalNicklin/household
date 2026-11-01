import { type LocalDate, Weekday, WeekdayOrder } from "@household/contracts";
import { addLocalDays, isRealDate, weekdayOf } from "../time.ts";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"] as const;
const WEEKDAY_NAMES: Record<Weekday, readonly string[]> = {
  [Weekday.mon]: ["monday", "mon"],
  [Weekday.tue]: ["tuesday", "tues", "tue"],
  [Weekday.wed]: ["wednesday", "weds", "wed"],
  [Weekday.thu]: ["thursday", "thurs", "thur", "thu"],
  [Weekday.fri]: ["friday", "fri"],
  [Weekday.sat]: ["saturday", "sat"],
  [Weekday.sun]: ["sunday", "sun"],
};
// "nov" or "november"; "sep", "sept" or "september".
const MONTH = MONTHS.map((m) => `${m.slice(0, 3)}(?:${m.slice(3)})?${m === "september" ? "|sept" : ""}`).join("|");
const ORDINAL = "(?:st|nd|rd|th)?";

function monthNumber(word: string): number {
  return MONTHS.findIndex((m) => m.startsWith(word.slice(0, 3))) + 1;
}

/** The next time this day of the year comes round, today included. */
function nextOccurrence(month: number, day: number, today: LocalDate): LocalDate | null {
  if (month < 1 || day < 1 || day > 31) return null;
  const year = Number(today.slice(0, 4));
  const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = candidate < today ? `${year + 1}${candidate.slice(4)}` : candidate;
  return isRealDate(date) ? date : null;
}

function dateIn(text: string, today: LocalDate): LocalDate | null {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso !== null) {
    const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return isRealDate(date) ? date : null;
  }
  const dayMonth = new RegExp(`\\b(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?(${MONTH})\\b`).exec(text);
  if (dayMonth?.[1] !== undefined && dayMonth[2] !== undefined) return nextOccurrence(monthNumber(dayMonth[2]), Number(dayMonth[1]), today);
  const monthDay = new RegExp(`\\b(${MONTH})\\s+(\\d{1,2})${ORDINAL}\\b`).exec(text);
  if (monthDay?.[1] !== undefined && monthDay[2] !== undefined) return nextOccurrence(monthNumber(monthDay[1]), Number(monthDay[2]), today);
  return null;
}

function weekdayIn(text: string): Weekday | null {
  for (const weekday of WeekdayOrder) {
    if (new RegExp(`\\b(${WEEKDAY_NAMES[weekday].join("|")})\\b`).test(text)) return weekday;
  }
  return null;
}

/**
 * PRO-2: the day someone means when they say when something is: "today", "tonight", "tomorrow", a
 * weekday ("Tuesday", "tue"), a date ("3 November", "Nov 3rd", "2026-11-03"), or both ("Tuesday 3
 * November"). A weekday or a date without a year is the next one, today included. null when it names
 * no day, or the weekday and the date disagree: the caller asks rather than guesses.
 */
export function dayIn(phrase: string, today: LocalDate): LocalDate | null {
  const text = phrase.toLowerCase();
  const date = dateIn(text, today);
  const weekday = weekdayIn(text);
  if (date !== null) return weekday === null || weekdayOf(date) === weekday ? date : null;
  if (weekday !== null) {
    for (let n = 0; n < 7; n++) {
      const d = addLocalDays(today, n);
      if (weekdayOf(d) === weekday) return d;
    }
  }
  if (/\btomorrow\b/.test(text)) return addLocalDays(today, 1);
  if (/\b(today|tonight|this evening)\b/.test(text)) return today;
  return null;
}

/**
 * HOU-156: the days a phrase spans, for a mode set ahead. "this weekend", "the weekend" or "weekend"
 * is the coming Saturday and Sunday (only Sunday when today is Sunday); anything else is the one day
 * `dayIn` reads. null when it names no day.
 */
export function daysIn(phrase: string, today: LocalDate): { from: LocalDate; to: LocalDate } | null {
  if (/\bweekend\b/i.test(phrase) && !/\bnext\b/i.test(phrase)) {
    if (weekdayOf(today) === Weekday.sun) return { from: today, to: today };
    const saturday = dayIn("saturday", today);
    return saturday === null ? null : { from: saturday, to: addLocalDays(saturday, 1) };
  }
  const day = dayIn(phrase, today);
  return day === null ? null : { from: day, to: day };
}
