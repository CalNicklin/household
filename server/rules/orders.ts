import type { LocalDate } from "@household/contracts";
import { addLocalDays, weekdayOf } from "../time.ts";

/** PRV-3: does this look like an order confirmation? Anything else is never read further. */
export function looksLikeOrder(subject: string, body: string): boolean {
  const text = `${subject}\n${body}`.toLowerCase();
  return /\b(order (confirmation|confirmed|number|no\.?)|your order|thanks for your order|has been dispatched|out for delivery|delivery (date|slot)|arriving|will be delivered)\b/.test(text);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export type ParsedOrder = { shop: string; expectedDate: LocalDate; window: string | null; needsSomeoneIn: boolean };

/** The shop, the expected day, a time window, and whether someone must be in. Nothing else is kept. */
export function parseOrder(text: string, today: LocalDate): ParsedOrder | null {
  const from = /^from:\s*(?:"?([^"<\n]+?)"?\s*<|([^<\n@]+?)\s*$)/im.exec(text);
  const subjectShop = /your\s+([A-Z][\w&' ]{1,30}?)\s+order/i.exec(text);
  const shop = (from?.[1] ?? from?.[2] ?? subjectShop?.[1] ?? "").replace(/\b(orders?|no-?reply|customer services?)\b/gi, "").trim();
  if (shop === "") return null;
  const date = findDate(text, today);
  if (date === null) return null;
  const window = /\b(?:between\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|to|and)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i.exec(text);
  const by = /\bby\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i.exec(text);
  const windowText = window !== null ? `${window[1]?.replace(/\s/g, "")}–${window[2]?.replace(/\s/g, "")}` : by !== null ? `by ${by[1]?.replace(/\s/g, "")}` : null;
  const left = /\b(safe ?place|letterbox|leave (it|your parcel)|can be left|no signature)\b/i.test(text);
  const needs = /\b(signature (is )?required|sign for|someone (will )?(needs?|must) to be (in|home|available)|must be (in|home)|need to be (in|home)|hand it to you|in person)\b/i.test(text);
  return { shop, expectedDate: date, window: windowText, needsSomeoneIn: needs && !left };
}

function findDate(text: string, today: LocalDate): LocalDate | null {
  const lower = text.toLowerCase();
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(lower);
  if (iso !== null) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join("|")})\\b`).exec(lower);
  if (dm?.[1] !== undefined && dm[2] !== undefined) {
    const year = Number(today.slice(0, 4));
    const month = MONTHS.indexOf(dm[2]) + 1;
    const candidate = `${year}-${String(month).padStart(2, "0")}-${dm[1].padStart(2, "0")}`;
    return candidate < today ? `${year + 1}${candidate.slice(4)}` : candidate;
  }
  if (/\btomorrow\b/.test(lower)) return addLocalDays(today, 1);
  if (/\btoday\b/.test(lower)) return today;
  const day = new RegExp(`\\b(${DAYS.join("|")})\\b`).exec(lower);
  if (day?.[1] !== undefined) {
    for (let i = 0; i < 7; i++) {
      const d = addLocalDays(today, i);
      if (DAYS[["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(weekdayOf(d))] === day[1]) return d;
    }
  }
  return null;
}
