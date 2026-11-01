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
 * - A free/busy-only copy (no uid, no title) joins a full event on another calendar with exactly the
 *   same start and end, since that is the only way to tell it is the same event; otherwise it stands
 *   alone as "Busy" for its owner.
 * - The title, times and solo flag come from the shared calendar's copy if there is one, else from the
 *   first full copy; attendees and who is away are the union of every copy; it is work if any copy is.
 */
export function mergeCopies(copies: readonly StoredCopy[]): CalendarEvent[] {
  const groups = new Map<string, StoredCopy[]>();
  const loneBusy: StoredCopy[] = [];
  for (const c of [...copies].sort(byOwner)) {
    if (c.uid === null) {
      if (c.busy) loneBusy.push(c);
      else groups.set(`copy:${c.externalId}`, [c]);
      continue;
    }
    const group = groups.get(`uid:${c.uid}`);
    if (group === undefined) groups.set(`uid:${c.uid}`, [c]);
    else group.push(c);
  }
  for (const b of loneBusy) {
    const same = [...groups.values()].find((g) => g.some((c) => !c.busy && c.owner !== b.owner && c.start === b.start && c.end === b.end));
    if (same === undefined) groups.set(`copy:${b.externalId}`, [b]);
    else same.push(b);
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
