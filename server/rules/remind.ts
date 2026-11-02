import { type LocalDate, type Person, type Reminder, Section } from "@household/contracts";
import { addLocalDays, localDate, localTime } from "../time.ts";
import { adultsOf, nameOf } from "./day.ts";
import { dayIn } from "./when.ts";

/** CAP-10: when a reminder is for: a day, and a time of day or none ("later today"). */
export type ReminderWhen = { date: LocalDate; time: string | null };

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

/** Times of day said in words, with no clock time: what each one means. */
const PART_OF_DAY: readonly { words: RegExp; time: string }[] = [
  { words: /\btonight\b/, time: "20:00" },
  { words: /\bevening\b/, time: "19:00" },
  { words: /\bafternoon\b/, time: "14:00" },
  { words: /\bmorning\b/, time: "09:00" },
  { words: /\b(noon|midday|lunchtime)\b/, time: "12:00" },
];

/** A day named in a way `dayIn` could not settle ("Tuesday 4 November" when the 4th is a Wednesday). */
const NAMES_A_DAY = /\b(mon|tues?|wed(?:nes)?|thur?s?|fri|satur|sun)(day)?\b|\b\d{1,2}(st|nd|rd|th)?\s+(of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b20\d{2}-\d{2}-\d{2}\b/;

/**
 * A clock time in the phrase: "8pm", "at 8", "8:30", "20:00". An hour with no am or pm is read as
 * people say it: "tonight at 8" and "at 3" are afternoon or evening, "morning at 8" is morning, and
 * otherwise the next 7 to 12 o'clock still to come today (in the morning on a later day).
 */
function clockIn(text: string, evening: boolean, morning: boolean, nowTime: string | null): string | null {
  const explicit = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/.exec(text);
  const bare = explicit ?? /\bat\s+(\d{1,2})(?:[:.](\d{2}))?\b/.exec(text) ?? /\b(\d{1,2})[:.](\d{2})\b/.exec(text);
  if (bare === null) return null;
  let hour = Number(bare[1]);
  const minute = bare[2] === undefined ? 0 : Number(bare[2]);
  if (hour > 23 || minute > 59) return null;
  const meridiem = explicit?.[3];
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    return hhmm((hour % 12) + (meridiem === "pm" ? 12 : 0), minute);
  }
  if (hour >= 13 || hour === 0) return hhmm(hour, minute);
  if (evening) return hhmm(hour === 12 ? 12 : hour + 12, minute);
  if (morning) return hhmm(hour, minute);
  if (hour <= 6) return hhmm(hour + 12, minute);
  if (nowTime === null || hour === 12) return hhmm(hour, minute);
  const am = hhmm(hour, minute);
  return am > nowTime ? am : hhmm(hour + 12, minute);
}

/**
 * CAP-10: when a reminder is for, read with the same day rules as everything else (`dayIn`, PRO-2):
 * nothing, "later" or "today" is later today with no time; "tomorrow", a weekday or a date is that day;
 * "tonight", "at 8", "8:30pm", "tomorrow morning" or "in an hour" give a time too. null when it names
 * a day that cannot be settled: the caller asks rather than guesses.
 */
export function reminderWhen(phrase: string | null | undefined, now: Date, timeZone: string): ReminderWhen | null {
  const today = localDate(now, timeZone);
  const text = (phrase ?? "").toLowerCase().trim();
  const inSpan = /\bin\s+(an?|\d+)\s+(hour|hr|minute|min)s?\b|\bin\s+half\s+an\s+hour\b/.exec(text);
  if (inSpan !== null) {
    const count = inSpan[1] === undefined || inSpan[1] === "a" || inSpan[1] === "an" ? 1 : Number(inSpan[1]);
    const minutes = text.includes("half an hour") ? 30 : (inSpan[2] ?? "").startsWith("h") ? count * 60 : count;
    const at = new Date(now.getTime() + minutes * 60_000);
    return { date: localDate(at, timeZone), time: localTime(at, timeZone) };
  }
  const named = dayIn(text, today);
  if (named === null && NAMES_A_DAY.test(text)) return null;
  const date = named ?? today;
  const evening = /\b(tonight|evening|night|pm)\b/.test(text);
  const morning = /\bmorning\b/.test(text);
  const clockTime = clockIn(text, evening, morning, date === today ? localTime(now, timeZone) : null);
  if (clockTime !== null) return { date, time: clockTime };
  const part = PART_OF_DAY.find((p) => p.words.test(text));
  // "tonight" said at ten past nine is still tonight: later today, with no time.
  if (part === undefined || (date === today && part.time <= localTime(now, timeZone))) return { date, time: null };
  return { date, time: part.time };
}

/**
 * CAP-10: who a reminder is for. "me" is the person asking, "us" (or "we", "everyone", "both") is every
 * adult, and anyone else by name. Names that are not one of the house's adults come back in `unknown`
 * for the caller to ask about; it never guesses who someone is.
 */
export function reminderFor(who: readonly string[], asker: string | null, people: readonly Person[]): { ids: string[]; unknown: string[] } {
  const adults = adultsOf(people);
  const ids = new Set<string>();
  const unknown: string[] = [];
  for (const raw of who) {
    const word = raw.trim().toLowerCase();
    if (word === "") continue;
    if (["me", "i", "myself"].includes(word)) {
      if (asker === null) unknown.push(raw);
      else ids.add(asker);
      continue;
    }
    if (["us", "we", "both", "both of us", "everyone", "all of us"].includes(word)) {
      for (const a of adults) ids.add(a.id);
      continue;
    }
    const match = adults.find((a) => a.name.toLowerCase() === word || a.id === word);
    if (match === undefined) unknown.push(raw.trim());
    else ids.add(match.id);
  }
  if (ids.size === 0 && unknown.length === 0 && asker !== null) ids.add(asker);
  return { ids: [...ids], unknown };
}

/** "Priya", "Priya & Tom": who a reminder is for, in the order the house lists them. */
export function reminderPeople(r: Pick<Reminder, "for">, people: readonly Person[]): string {
  return people
    .filter((p) => r.for.includes(p.id))
    .map((p) => nameOf(people, p.id))
    .join(" & ");
}

/**
 * CAP-10: where a reminder sits on a day's screen. On its own day: Later today until its time, Now
 * from then on; with no time, Later today all day. On the day before it, Tomorrow. Not on any other day.
 */
export function reminderSection(r: Pick<Reminder, "date" | "time">, date: LocalDate, now: Date, timeZone: string): Section | null {
  if (r.date === addLocalDays(date, 1)) return Section.tomorrow;
  if (r.date !== date) return null;
  return isDue(r, now, timeZone) ? Section.now : Section.later;
}

/** CAP-10: a reminder with a time is due once that time has come on its day (or its day has passed). */
export function isDue(r: Pick<Reminder, "date" | "time">, now: Date, timeZone: string): boolean {
  if (r.time === null) return false;
  const today = localDate(now, timeZone);
  return r.date < today || (r.date === today && r.time <= localTime(now, timeZone));
}
