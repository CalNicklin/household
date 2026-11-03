/**
 * HOU-178 (CAP-2): the deadline in a backlog item's own words ("by Friday lunchtime", "before the
 * 12th", "ahead of the weekend"). Read by rules from the words each time, never stored as a due date,
 * and read from the day the item was added, not from today: "by Friday" said on a Monday is that Friday.
 */
import type { BacklogItem, LocalDate } from "@household/contracts";
import { addLocalDays, atLocal, isRealDate, localDate, startOfLocalDay } from "../time.ts";
import { clockIn, PART_OF_DAY } from "./remind.ts";
import { dayIn, daysIn } from "./when.ts";

/**
 * The instant it is needed by. `words` are the item's own ("by Friday lunchtime", "ahead of the
 * weekend"), and `day` the day part of them ("Friday lunchtime", "the weekend"), for saying why.
 */
export type Deadline = { at: Date; words: string; day: string };

/** "by", "before" or "ahead of", then the words up to the next punctuation. */
const KEYWORD = /\b(by|before|ahead of)\s+([^,.;:!?()]+)/gi;
/** The words after the keyword name a day: a weekday, today, tomorrow, the weekend, a date, "the 12th". */
const NAMES_A_DAY = /^(?:(?:the|this|next)\s+)?(?:mon|tue|wed|thu|fri|sat|sun|today|tonight|tomorrow|weekend|\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/;
/** Where a deadline phrase stops: "by Friday so they can collect it" is about Friday. */
const PHRASE_END = /\s+(?:and|or|so|because|when|if|then|for|to|ready|in case)\b.*$/i;
/** "the 12th": a day of the month, with no month named. */
const DAY_OF_MONTH = /^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** "the 12th" from the day added: this month's if it is still to come (that day included), else next month's. */
function dayOfMonth(day: number, added: LocalDate): LocalDate | null {
  const [year, month] = [Number(added.slice(0, 4)), Number(added.slice(5, 7))];
  const thisMonth = `${year}-${pad(month)}-${pad(day)}`;
  const date = thisMonth >= added ? thisMonth : month === 12 ? `${year + 1}-01-${pad(day)}` : `${year}-${pad(month + 1)}-${pad(day)}`;
  return isRealDate(date) ? date : null;
}

/** The instant one phrase after its keyword names, or null when it names no day or one that can't be settled. */
function deadlineAt(keyword: string, phrase: string, added: LocalDate, timeZone: string): Date | null {
  // "next Friday" could be this week's or the one after: not settled, so no deadline.
  if (/^next\b/.test(phrase)) return null;
  // The weekend is needed by when it starts, whichever word comes before it.
  if (/\bweekend\b/.test(phrase)) {
    const weekend = daysIn(phrase, added);
    return weekend === null ? null : startOfLocalDay(weekend.from, timeZone);
  }
  const ordinal = DAY_OF_MONTH.exec(phrase);
  const day = ordinal?.[1] === undefined ? dayIn(phrase, added) : dayOfMonth(Number(ordinal[1]), added);
  if (day === null) return null;
  const evening = /\b(tonight|evening|night|pm)\b/.test(phrase);
  const time = clockIn(phrase, evening, /\bmorning\b/.test(phrase), null) ?? PART_OF_DAY.find((p) => p.words.test(phrase))?.time ?? null;
  if (time !== null) return atLocal(day, Number(time.slice(0, 2)), Number(time.slice(3, 5)), timeZone);
  // "by Friday" is all of Friday; "before Friday" and "ahead of Friday" are up to its start.
  return startOfLocalDay(keyword === "by" ? addLocalDays(day, 1) : day, timeZone);
}

/**
 * The deadline an item's words state, or null when they state none or name a day that can't be
 * settled ("by Wednesday 3 November" when the 3rd is a Tuesday, "by next Friday"). With more than
 * one, the earliest.
 */
export function deadlineOf(item: Pick<BacklogItem, "text" | "createdAt">, timeZone: string): Deadline | null {
  const added = localDate(new Date(item.createdAt), timeZone);
  let found: Deadline | null = null;
  for (const match of item.text.matchAll(KEYWORD)) {
    const keyword = (match[1] ?? "").toLowerCase();
    const said = (match[2] ?? "").replace(PHRASE_END, "").trim();
    const phrase = said.toLowerCase();
    if (!NAMES_A_DAY.test(phrase)) continue;
    const at = deadlineAt(keyword, phrase, added, timeZone);
    if (at !== null && (found === null || at < found.at)) found = { at, words: `${keyword} ${said}`, day: said };
  }
  return found;
}

/** Whether a gap starting at `start` is too late for the item: at or after its deadline. */
export function tooLate(deadline: Deadline | null, start: Date): boolean {
  return deadline !== null && start.getTime() >= deadline.at.getTime();
}
