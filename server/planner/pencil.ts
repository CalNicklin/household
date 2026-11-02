/**
 * HOU-173: "Pencil it in" on a backlog pick. The house never writes to a calendar (PRV-1): the tap is
 * kept as an accept response carrying the pick's slot, and the screens read the pencilled-in items
 * back from those responses — a line on that day's plan, and on the item's Backlog row.
 */
import { ActionKind, type BacklogItem, BacklogStatus, type Block, BlockType, type LocalDate, type PencilSlot, type Person, Placement, Provenance, type Response, Section, zPencilSlot } from "@household/contracts";
import { nameOf } from "../rules/day.ts";
import { addLocalDays, dayPartWords } from "../time.ts";

export const PENCIL_PREFIX = "pencil:";

/** The slot as an action's value: "2026-11-04 morning". */
export function pencilValue(slot: PencilSlot): string {
  return `${slot.date} ${slot.dayPart}`;
}

/** The slot an accept's value names, or null for anything else (an older plan's card carried none). */
export function parsePencil(value: string | null): PencilSlot | null {
  const [date, dayPart, ...rest] = (value ?? "").split(" ");
  if (rest.length > 0) return null;
  const parsed = zPencilSlot.safeParse({ date, dayPart });
  return parsed.success ? parsed.data : null;
}

export type Pencilled = { item: BacklogItem; slot: PencilSlot; person: string };

/**
 * Backlog items pencilled in for today or later and still on the list. A pick is offered on a plan
 * at most a week before its slot, so the responses that can say so are within a week either side.
 */
export function pencilledItems(responses: readonly Response[], items: readonly BacklogItem[], today: LocalDate): Pencilled[] {
  const active = new Map(items.filter((i) => i.status === BacklogStatus.active).map((i) => [`backlog:${i.id}`, i]));
  const out = new Map<string, Pencilled>();
  for (const r of [...responses].sort((a, b) => a.at.localeCompare(b.at))) {
    const item = active.get(r.ref);
    const slot = r.action === ActionKind.accept ? parsePencil(r.value) : null;
    if (item === undefined || slot === null || slot.date < today) continue;
    out.set(item.id, { item, slot, person: r.person });
  }
  return [...out.values()];
}

/** The window of response dates `pencilledItems` needs, for `plans.responsesBetween`. */
export function pencilWindow(today: LocalDate): { from: LocalDate; to: LocalDate } {
  return { from: addLocalDays(today, -7), to: addLocalDays(today, 8) };
}

export function pencilledLine(slot: PencilSlot, today: LocalDate): string {
  return `Pencilled in for ${dayPartWords(slot.date, today, slot.dayPart)}`;
}

/** The pencilled-in items on one day's plan: a fact a person chose, not a suggestion, so no buttons. */
export function pencilBlocks(pencilled: readonly Pencilled[], date: LocalDate, today: LocalDate, people: readonly Person[]): Block[] {
  return pencilled
    .filter((p) => p.slot.date === date)
    .map((p) => ({
      id: `${PENCIL_PREFIX}${p.item.id}`,
      type: BlockType.event,
      section: Section.later,
      placement: Placement.main,
      reason: `${nameOf(people, p.person)} pencilled this in from the backlog; nothing was put on the calendar`,
      provenance: Provenance.person,
      time: null,
      title: p.item.text,
      detail: pencilledLine(p.slot, today),
      ref: `${PENCIL_PREFIX}${p.item.id}`,
    }));
}
