/**
 * HOU-178 (PRO-8): "Pencil it in" picks its own time. Rules list the gaps that are allowed (free time
 * that suits the item's tags, before the deadline in its words); the model only chooses one of them,
 * and anything else it answers falls back to the first allowed gap.
 */
import type { BacklogItem, LocalDate } from "@household/contracts";
import { eventsOn, type HouseFacts } from "../rules/day.ts";
import type { Deadline } from "../rules/deadline.ts";
import { partOfDay, type Slot, waitingFor } from "../rules/fit.ts";
import { clock, dayPartWords, longDate } from "../time.ts";

/** The longest reason the model may give; a longer one is replaced by the rules' own (a few words, the issue says). */
const MAX_REASON_CHARS = 120;

const capital = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** The prompt: the card, then each allowed gap numbered, with what else is on its day. */
export function pencilPrompt(item: Pick<BacklogItem, "text" | "tags">, gaps: readonly Slot[], facts: HouseFacts, deadline: Deadline | null): string {
  const lines = [
    "Pencil: choose when this backlog job best fits, from these gaps only. Think about what the job is and what else is on that day.",
    "Reply with the gap's number, a colon, then why it suits in under fifteen plain words. No other text.",
    `Job: ${item.text}. ${waitingFor(item)}.${deadline === null ? "" : ` Needed ${deadline.words}.`}`,
    "Gaps:",
  ];
  for (const [i, gap] of gaps.entries()) {
    const busy = eventsOn(facts, gap.date).map((e) => `${clock(e.start, facts.timeZone)} ${e.title}`);
    const clear = gap.why.length === 0 ? "" : ` (${gap.why.join(", ")})`;
    lines.push(`${i + 1}. ${longDate(gap.date)} ${partOfDay(gap.startHour)}, ${gap.startHour}:00 to ${gap.endHour}:00${clear}. That day: ${busy.length === 0 ? "nothing else" : busy.join("; ")}.`);
  }
  return lines.join("\n");
}

/**
 * The gap the model chose and its reason in its words, if it answered with a listed gap's number.
 * Any other answer (a gap not on the list, a date, nothing) is the first allowed gap, with no reason
 * from the model: the rules say why instead.
 */
export function chosenGap(answer: string, gaps: readonly Slot[]): { gap: Slot; reason: string | null } {
  const first = gaps[0];
  if (first === undefined) throw new Error("chosenGap needs at least one allowed gap");
  const m = /^\s*(\d+)\s*[:.)-]?\s*(.*)$/s.exec(answer);
  const gap = m?.[1] === undefined ? undefined : gaps[Number(m[1]) - 1];
  if (gap === undefined) return { gap: first, reason: null };
  const said = (m?.[2] ?? "").trim();
  const words = said.replace(/\.+$/, "");
  // A few plain words on one line, with no exclamation marks (the house's voice), or the rules say why.
  const reason = words === "" || words.length > MAX_REASON_CHARS || /[\n!]/.test(said) ? null : `${capital(words)}.`;
  return { gap, reason };
}

/** The rules' reason for a gap: "Thursday evening is clear: both home, and it's before Friday lunchtime." */
export function gapReason(gap: Slot, deadline: Deadline | null, today: LocalDate): string {
  const when = capital(dayPartWords(gap.date, today, partOfDay(gap.startHour)));
  const clear = gap.why.length === 0 ? "is clear" : `is clear: ${gap.why.join(", ")}`;
  return `${when} ${clear}${deadline === null ? "" : `, and it's before ${deadline.day}`}.`;
}

/** What the house says when no gap is allowed: nothing is pencilled in. */
export function noGapSay(deadline: Deadline | null): string {
  const before = deadline === null ? "in the coming week" : `before ${deadline.day}`;
  return `There's no free time that suits it ${before}, so I haven't pencilled it in. You could ask for a reminder instead.`;
}
