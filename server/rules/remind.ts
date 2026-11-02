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

/** A date written out, whose digits are never a clock time. */
const WRITTEN_DATE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;

/**
 * A clock time as written: "8pm", "at 8", "8:30", "9 o'clock", or run together as people type it on a
 * phone ("730", "1915"; HOU-174). The hour, the minute, and am or pm if it was said.
 */
function clockWords(text: string): { hour: number; minute: number; meridiem: "am" | "pm" | undefined } | null {
  const explicit = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/.exec(text);
  const bare =
    explicit ??
    /\bat\s+(\d{1,2})(?:[:.](\d{2}))?\b/.exec(text) ??
    /\b(\d{1,2})[:.](\d{2})\b/.exec(text) ??
    /\b(\d{1,2})()\s*o'?clock\b/.exec(text) ??
    // "make it 730": three or four digits standing alone, never part of a date ("4 Nov 2026", "2026-11-04", "4/11/2026").
    (WRITTEN_DATE.test(text) ? null : /(?<![\d:./-])\b(\d{1,2})(\d{2})\b(?![:./-]?\d)/.exec(text));
  if (bare === null) return null;
  const hour = Number(bare[1]);
  const minute = bare[2] === undefined || bare[2] === "" ? 0 : Number(bare[2]);
  if (hour > 23 || minute > 59) return null;
  const said = explicit?.[3];
  return { hour, minute, meridiem: said === "am" || said === "pm" ? said : undefined };
}

/**
 * A clock time in the phrase: "8pm", "at 8", "8:30", "20:00". An hour with no am or pm is read as
 * people say it: "tonight at 8" and "at 3" are afternoon or evening, "morning at 8" is morning, and
 * otherwise the next 7 to 12 o'clock still to come today (in the morning on a later day).
 */
function clockIn(text: string, evening: boolean, morning: boolean, nowTime: string | null): string | null {
  const said = clockWords(text);
  if (said === null) return null;
  let hour = said.hour;
  const minute = said.minute;
  const meridiem = said.meridiem;
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
export function reminderWhen(phrase: string | null | undefined, now: Date, timeZone: string, onDate?: LocalDate): ReminderWhen | null {
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
  // HOU-174: a new time for a reminder with no day said ("make it 7:30") stays on the reminder's day.
  const date = named ?? onDate ?? today;
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

/**
 * HOU-174: a reminder's new day and time, from what the person said ("7:30", "make it 730", "Thursday",
 * "tomorrow at 8"). A day with no time keeps the reminder's time; a time with no day keeps its day.
 * null when it names a day that cannot be settled, or says nothing about when.
 */
export function retimeWhen(phrase: string, r: Pick<Reminder, "date" | "time">, now: Date, timeZone: string): ReminderWhen | null {
  const text = phrase.toLowerCase().trim();
  if (text === "") return null;
  const when = reminderWhen(text, now, timeZone, r.date);
  if (when === null) return null;
  if (when.time !== null) return when;
  // Nothing about the time: "later today" has none; a day alone ("move it to Thursday") keeps its time.
  if (/\b(later|no time|any ?time|sometime)\b/.test(text)) return { date: when.date, time: null };
  if (dayIn(text, localDate(now, timeZone)) !== null) return { date: when.date, time: r.time };
  return null;
}

/** Words that say which reminder, not what it is about. */
const NOT_ABOUT = new Set(
  "the a an my our your his her their this that these those one ones reminder reminders remind me us it for to on at in of and about please can you could set i we cancel delete remove scrap drop change move make push bring earlier later instead o'clock oclock clock am pm today tonight tomorrow morning afternoon evening night monday tuesday wednesday thursday friday saturday sunday".split(" "),
);

/**
 * HOU-174: which of the open reminders a person means ("the BoyBoy reminder", "the 9 o'clock one",
 * "Wednesday's reminder"). Every reminder that fits what they said: one is the one, none or several
 * means asking, never guessing. A day or clock time in what they said narrows it; so do the words.
 */
export function matchReminders<R extends Pick<Reminder, "text" | "date" | "time">>(open: readonly R[], which: string, today: LocalDate): R[] {
  const text = which.toLowerCase();
  let found = [...open];
  const day = NAMES_A_DAY.test(text) || /\b(today|tonight|tomorrow)\b/.test(text) ? dayIn(text, today) : null;
  if (day !== null) found = found.filter((r) => r.date === day);
  const clock = clockWords(text);
  if (clock !== null) {
    const hours = clock.meridiem === undefined ? [clock.hour % 24, (clock.hour + 12) % 24] : [(clock.hour % 12) + (clock.meridiem === "pm" ? 12 : 0)];
    found = found.filter((r) => r.time !== null && hours.some((h) => r.time === hhmm(h, clock.minute)));
  }
  const words = (text.match(/[a-z][a-z']+/g) ?? []).map((w) => w.replace(/'s$/, "")).filter((w) => w.length >= 3 && !NOT_ABOUT.has(w));
  if (words.length === 0) return found;
  const score = (r: R) => words.filter((w) => r.text.toLowerCase().includes(w)).length;
  const best = Math.max(0, ...found.map(score));
  return best === 0 ? [] : found.filter((r) => score(r) === best);
}
