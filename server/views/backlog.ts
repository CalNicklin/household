import { type BacklogScreen, BacklogStatus } from "@household/contracts";
import { gatherFacts } from "../planner/gather.ts";
import { nameOf } from "../rules/day.ts";
import { findSlot, partOfDay, waitingFor } from "../rules/fit.ts";
import type { Runtime } from "../runtime.ts";
import { localDate, shortWeekday } from "../time.ts";

const JUST_ADDED_MS = 48 * 3_600_000;

function when(createdAt: string, now: Date, timeZone: string): string {
  const created = new Date(createdAt);
  const days = Math.round((new Date(localDate(now, timeZone)).getTime() - new Date(localDate(created, timeZone)).getTime()) / 86_400_000);
  if (days <= 0) return partOfDay(Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(created))) === "morning" ? "this morning" : "today";
  if (days === 1) return "yesterday";
  return shortWeekday(localDate(created, timeZone));
}

/**
 * CAP-4: Could go soon (it found a slot and says when), Waiting for the right moment (it says what
 * for), Just added (guessed tags you can fix with one tap), and Parked (CAP-5).
 */
export async function backlogScreen(rt: Runtime): Promise<BacklogScreen> {
  const now = rt.ports.clock.now();
  const today = localDate(now, rt.timeZone);
  const items = await rt.system("views").backlog.list();
  const facts = await gatherFacts(rt, today, 7);
  const out: BacklogScreen = { count: 0, soon: [], waiting: [], justAdded: [], parked: [] };
  for (const item of items) {
    if (item.status === BacklogStatus.done) continue;
    if (item.status === BacklogStatus.parked) {
      out.parked.push(item);
      continue;
    }
    out.count += 1;
    if (!item.confirmedTags && now.getTime() - new Date(item.createdAt).getTime() < JUST_ADDED_MS) {
      out.justAdded.push({ item, byline: `${nameOf(facts.people, item.createdBy)} · ${when(item.createdAt, now, rt.timeZone)}` });
      continue;
    }
    const slot = findSlot(facts, item, now, today, 7);
    if (slot === null) out.waiting.push({ item, waitingFor: waitingFor(item) });
    else {
      const day = slot.date === today ? "Today" : slot.date === localDate(new Date(now.getTime() + 86_400_000), rt.timeZone) ? "Tomorrow" : shortWeekday(slot.date).slice(0, 3);
      const why = slot.why.length === 0 ? "" : ` · ${slot.why.join(", ")}`;
      out.soon.push({ item, slot: `${day} ${partOfDay(slot.startHour)}${why}` });
    }
  }
  return out;
}
