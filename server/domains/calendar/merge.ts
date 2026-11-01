import { type CalendarCopy, type CalendarEvent, CalendarOwnerKind } from "@household/contracts";

export type StoredCopy = CalendarCopy & { id: string };

/** Shared calendar first (it carries the household's own wording), then people in name order. */
const ownerRank = (owner: string): string => (owner === CalendarOwnerKind.shared ? "" : owner);
const byOwner = (a: StoredCopy, b: StoredCopy): number => ownerRank(a.owner).localeCompare(ownerRank(b.owner)) || a.externalId.localeCompare(b.externalId);

const union = (lists: readonly (readonly string[])[]): string[] => {
  const out: string[] = [];
  for (const list of lists) for (const x of list) if (!out.includes(x)) out.push(x);
  return out;
};

/**
 * HOME-1: the house's calendar is the copies from every calendar it reads, read back as events.
 * - Copies with the same uid (Google's iCalUID and recurrence instance: an invite between Cal and
 *   Chloe, or a copy on the shared calendar) are one event, with every owner's people on it.
 * - Nothing else is matched: a free/busy-only copy (no uid, no title) stands alone as "Busy" for its
 *   owner, even at the same time as someone else's event, so "both going" is never guessed.
 * - The title, times and solo flag come from the shared calendar's copy if there is one, else from the
 *   first full copy; attendees and who is away are the union of every copy; it is work if any copy is.
 */
export function mergeCopies(copies: readonly StoredCopy[]): CalendarEvent[] {
  const groups = new Map<string, StoredCopy[]>();
  for (const c of [...copies].sort(byOwner)) {
    const key = c.uid === null ? `copy:${c.externalId}` : `uid:${c.uid}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [c]);
    else group.push(c);
  }
  const events: CalendarEvent[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(byOwner);
    const primary = sorted.find((c) => !c.busy) ?? sorted[0];
    if (primary === undefined) continue;
    const ordered = [primary, ...sorted.filter((c) => c !== primary)];
    events.push({
      id: primary.id,
      externalId: primary.uid ?? primary.externalId,
      title: primary.title,
      start: primary.start,
      end: primary.end,
      allDay: primary.allDay,
      attendees: union(ordered.map((c) => c.attendees)),
      away: union(ordered.map((c) => c.away)),
      work: group.some((c) => c.work),
      soloWithKids: ordered.find((c) => c.soloWithKids !== null)?.soloWithKids ?? null,
      calendars: union([sorted.map((c) => c.owner)]),
    });
  }
  return events.sort((a, b) => a.start.localeCompare(b.start) || a.externalId.localeCompare(b.externalId));
}
