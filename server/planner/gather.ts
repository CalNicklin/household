import { ActionKind, type BacklogItem, BacklogStatus, BlockType, type LocalDate, NotificationStatus, type NotifyAction } from "@household/contracts";
import { findSlot, partOfDay } from "../rules/fit.ts";
import { adultsOf, type HouseFacts, nameOf } from "../rules/day.ts";
import type { Runtime } from "../runtime.ts";
import { addLocalDays, atLocal, daysBetween, localDate, shortWeekday, startOfLocalDay } from "../time.ts";
import type { BacklogPick, OneThing } from "./compose.ts";

/** Everything the rules need, read through each domain's router (no cross-database reads, CODE-4). */
export async function gatherFacts(rt: Runtime, from: LocalDate, days: number): Promise<HouseFacts> {
  const api = rt.system("planner");
  const settings = await api.household.settings();
  const start = startOfLocalDay(addLocalDays(from, -1), rt.timeZone).toISOString();
  const end = startOfLocalDay(addLocalDays(from, days + 1), rt.timeZone).toISOString();
  const forecast: HouseFacts["forecast"] = {};
  for (let d = 0; d < days; d++) {
    const date = addLocalDays(from, d);
    forecast[date] = await rt.ports.weather.hourly(date, settings.latitude, settings.longitude, rt.timeZone);
  }
  return {
    timeZone: rt.timeZone,
    latitude: settings.latitude,
    longitude: settings.longitude,
    people: await api.household.people(),
    events: await api.calendar.between({ from: start, to: end }),
    rules: await api.household.rules(),
    nurseryTerms: await api.household.nurseryTerms(),
    nurseryEvents: await api.household.nurseryEvents(),
    sitters: await api.household.sitters(),
    sitterBookings: await api.household.sitterBookings(),
    arrivals: await api.parcels.between({ from: start, to: end }),
    mode: await api.household.activeMode(),
    forecast,
  };
}

export type PickCandidate = BacklogPick & { slotDate: LocalDate; dayPart: string; who: string[] };

/**
 * Backlog items with a slot this week that have never been offered (PRO-6), soonest first. A slot
 * today that only a heavy-day person could use is left free (WB-4).
 */
export async function pickCandidates(rt: Runtime, facts: HouseFacts, date: LocalDate, now: Date, signals: { avoid: readonly string[]; offerTo: Readonly<Record<string, string>>; heavy: readonly string[]; todayOffer: string | null }): Promise<PickCandidate[]> {
  const api = rt.system("planner");
  const items = (await api.backlog.list()).filter((i) => i.status === BacklogStatus.active);
  const offered = new Set((await api.plans.offers()).filter((o) => o.itemId !== signals.todayOffer).map((o) => o.itemId));
  const from = localDate(now, rt.timeZone) === date ? now : atLocal(date, 7, 0, rt.timeZone);
  const out: PickCandidate[] = [];
  for (const item of items) {
    if (offered.has(item.id)) continue;
    if (signals.todayOffer !== null && item.id !== signals.todayOffer) continue;
    const slot = findSlot(facts, item, from, date, 7);
    if (slot === null) continue;
    const dayPart = partOfDay(slot.startHour);
    if (signals.avoid.includes(`${item.text.toLowerCase()}|${dayPart}`)) continue;
    if (slot.date === date && slot.who.every((w) => signals.heavy.includes(w))) continue;
    const person = signals.offerTo[item.text.toLowerCase()] ?? null;
    const forWhom = person === null ? "" : ` ${nameOf(facts.people, person)} usually takes these.`;
    out.push({ itemId: item.id, title: item.text, why: `${pickReason(facts, item, slot.date, date, dayPart, slot.why)}${forWhom}`, person, slotDate: slot.date, dayPart, who: slot.who });
  }
  return out.sort((a, b) => a.slotDate.localeCompare(b.slotDate));
}

function pickReason(facts: HouseFacts, item: BacklogItem, slotDate: LocalDate, today: LocalDate, dayPart: string, why: string[]): string {
  const day = slotDate === today ? `This ${dayPart}` : `${shortWeekday(slotDate)} ${dayPart}`;
  const age = daysBetween(localDate(new Date(item.createdAt), facts.timeZone), today);
  const added = age <= 0 ? "added today" : age === 1 ? "added yesterday" : age < 14 ? `added ${age} days ago` : `added ${Math.round(age / 7)} weeks ago`;
  const conditions = why.length === 0 ? "is clear" : `is clear: ${why.join(", ")}`;
  return `${day} ${conditions}. From the backlog, ${added}.`;
}

/**
 * MOM-2: the single best thing to do now, with a reason. Ranked by rules: a rule alert with an
 * action, then a quick backlog job that fits right now, then the day's suggestion.
 */
export async function oneThingCandidates(rt: Runtime, facts: HouseFacts, date: LocalDate, now: Date, closed: ReadonlySet<string>, person: string | null): Promise<OneThing[]> {
  const api = rt.system("planner");
  const out: OneThing[] = [];
  const plan = await api.plans.latest({ date });
  const other = person === null ? null : (adultsOf(facts.people).find((a) => a.id !== person) ?? null);
  const withHandOver = (ref: string, actions: NotifyAction[]): NotifyAction[] =>
    other === null ? actions : [...actions, { kind: ActionKind.handOver, label: `${other.name} can do it`, ref, value: other.id }];
  for (const b of plan?.blocks ?? []) {
    if (closed.has(b.id)) continue;
    if (b.type === BlockType.alert && b.action !== null) out.push({ ref: b.ref, title: b.title, why: b.reason, actions: withHandOver(b.ref, [{ ...b.action }]) });
  }
  const items = (await api.backlog.list()).filter((i) => i.status === BacklogStatus.active && !closed.has(`backlog:${i.id}`));
  const quick = items.filter((i) => i.tags.includes("quick")).map((i) => ({ item: i, slot: findSlot(facts, i, now, date, 1) }));
  for (const { item, slot } of quick) {
    if (slot === null || slot.date !== date) continue;
    const ref = `backlog:${item.id}`;
    const when = slot.startHour <= Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: rt.timeZone }).format(now)) ? "now" : `from ${slot.startHour}:00`;
    out.push({
      ref,
      title: item.text,
      why: `It takes about fifteen minutes and it fits ${when}${slot.why.length > 0 ? ` (${slot.why.join(", ")})` : ""}.`,
      actions: withHandOver(ref, [
        { kind: ActionKind.done, label: "Done", ref },
        { kind: ActionKind.notToday, label: "Not today", ref },
      ]),
    });
  }
  for (const b of plan?.blocks ?? []) {
    if (closed.has(b.id)) continue;
    if (b.type === BlockType.suggestion) out.push({ ref: b.ref, title: b.title, why: b.reason, actions: withHandOver(b.ref, b.actions) });
  }
  return out;
}

/** Notifications waiting for the morning screen (PRO-7) or routed to it (CH-7). */
export async function screenNotes(rt: Runtime) {
  return rt.system("planner").jobs.notifications({ statuses: [NotificationStatus.deferred, NotificationStatus.onScreen] });
}

export function otherAdultOf(facts: HouseFacts) {
  return (person: string): string | null => {
    const other = adultsOf(facts.people).find((a) => a.id !== person);
    return other === undefined ? null : nameOf(facts.people, other.id);
  };
}
