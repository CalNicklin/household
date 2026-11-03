import { ActionKind, type BacklogItem, BacklogStatus, BacklogTag, BlockType, type HourlyForecast, Limits, type LocalDate, NotificationStatus, type NotifyAction } from "@household/contracts";
import { deadlineOf, tooLate } from "../rules/deadline.ts";
import { pencilledItems, pencilWindow } from "./pencil.ts";
import { findSlot, partOfDay } from "../rules/fit.ts";
import { adultsOf, type HouseFacts, nameOf } from "../rules/day.ts";
import type { Runtime } from "../runtime.ts";
import { addLocalDays, atLocal, dayPartWords, daysBetween, localDate, startOfLocalDay } from "../time.ts";
import { type BacklogPick, isShopNews, type OneThing } from "./compose.ts";
import { type HouseFill, START_REF_PREFIX } from "./first-day.ts";

/** Everything the rules need, read through each domain's router (no cross-database reads, CODE-4). */
export async function gatherFacts(rt: Runtime, from: LocalDate, days: number): Promise<HouseFacts> {
  const api = rt.system("planner");
  const settings = await api.household.settings();
  const start = startOfLocalDay(addLocalDays(from, -1), rt.timeZone).toISOString();
  const end = startOfLocalDay(addLocalDays(from, days + 1), rt.timeZone).toISOString();
  const forecast = await forecasts(rt, Array.from({ length: days }, (_, d) => addLocalDays(from, d)), settings.latitude, settings.longitude);
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
    modes: await api.household.modesBetween({ from: start, to: end }),
    forecast,
  };
}

/** When each weather source last failed its retries (in-process; a restart simply tries afresh). */
const downAt = new WeakMap<object, number>();

/**
 * HOU-170: weather is an input, not a requirement. Each date's forecast is fetched and kept (PLT-3);
 * a transient failure gets a short bounded retry, then the last good forecast for that date stands
 * in, or none, which the rules read as "not known": nothing that needs dry weather fires and the
 * context line says the forecast isn't available. One warning per outage, never a failed plan.
 */
export async function forecasts(rt: Runtime, dates: readonly LocalDate[], latitude: number, longitude: number): Promise<Record<LocalDate, HourlyForecast[]>> {
  const api = rt.system("weather");
  const out: Record<LocalDate, HourlyForecast[]> = {};
  let down: { status: number | null; error: string } | null = null;
  for (const date of dates) {
    if (down === null) {
      let hours: HourlyForecast[] | null = null;
      try {
        // limit: weatherDownForMs
        const recentlyDown = Date.now() - (downAt.get(rt.ports.weather) ?? -Infinity) < Limits.weatherDownForMs.value;
        hours = await withRetry(() => rt.ports.weather.hourly(date, latitude, longitude, rt.timeZone), recentlyDown ? 1 : undefined);
        downAt.delete(rt.ports.weather);
      } catch (e) {
        downAt.set(rt.ports.weather, Date.now());
        down = { status: statusOf(e), error: e instanceof Error ? e.name : "unknown" };
        console.warn(JSON.stringify({ event: "weather-unavailable", status: down.status, error: down.error, date }));
      }
      // Outside the try: a database fault is not a weather outage, and fails the plan as it should.
      if (hours !== null) {
        await api.plans.saveForecast({ date, hours });
        out[date] = hours;
        continue;
      }
    }
    out[date] = (await api.plans.forecast({ date }))?.hours ?? [];
  }
  return out;
}

/** A 5xx, a 429 or a network failure or timeout is worth another try; anything else (a 4xx, a bad body) is not. */
function transient(e: unknown): boolean {
  const status = statusOf(e);
  if (status !== null) return status >= 500 || status === 429;
  return e instanceof TypeError || (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"));
}

/** The HTTP status an integration's error carries (`IntegrationError.status`), if any. */
function statusOf(e: unknown): number | null {
  return e instanceof Error && "status" in e && typeof e.status === "number" ? e.status : null;
}

// limit: weatherAttempts
async function withRetry<T>(call: () => Promise<T>, attempts: number = Limits.weatherAttempts.value): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (attempt >= attempts || !transient(e)) throw e;
      // limit: weatherRetryDelayMs
      await new Promise((r) => setTimeout(r, Limits.weatherRetryDelayMs.value * 2 ** (attempt - 1)));
    }
  }
}

/** HOU-178: `neededBy` is the deadline in the item's own words, read afresh each plan (never stored on the item). */
export type PickCandidate = BacklogPick & { who: string[]; neededBy: { at: string; words: string } | null };

/**
 * Backlog items with a slot this week that have never been offered (PRO-6), soonest first. A slot
 * today that only a heavy-day person could use is left free (WB-4). A slot is always before the
 * deadline in the item's own words, so an item past it is not offered at all (HOU-178).
 */
export async function pickCandidates(rt: Runtime, facts: HouseFacts, date: LocalDate, now: Date, signals: { avoid: readonly string[]; offerTo: Readonly<Record<string, string>>; heavy: readonly string[]; todayOffer: string | null }): Promise<PickCandidate[]> {
  const api = rt.system("planner");
  const items = (await api.backlog.list()).filter((i) => i.status === BacklogStatus.active);
  const offered = new Set((await api.plans.offers()).filter((o) => o.itemId !== signals.todayOffer).map((o) => o.itemId));
  // HOU-173: the reason is read from the real today, whichever day's plan it is on.
  const today = localDate(now, rt.timeZone);
  // HOU-179: an item a person pencilled in (from the Backlog's menu) already has its day, so it isn't offered;
  // it neither takes nor stops the day's own offer (PRO-6).
  const pencilled = new Set(pencilledItems(await api.plans.responsesBetween(pencilWindow(today)), items, today).map((p) => p.item.id));
  const from = today === date ? now : atLocal(date, 7, 0, rt.timeZone);
  const out: PickCandidate[] = [];
  for (const item of items) {
    if (offered.has(item.id) || (pencilled.has(item.id) && item.id !== signals.todayOffer)) continue;
    if (signals.todayOffer !== null && item.id !== signals.todayOffer) continue;
    // HOU-178: never a gap that starts at or after the deadline in the item's own words; past it, never offered.
    const deadline = deadlineOf(item, rt.timeZone);
    const slot = findSlot(facts, item, from, date, 7, deadline);
    if (slot === null) continue;
    const dayPart = partOfDay(slot.startHour);
    if (signals.avoid.includes(`${item.text.toLowerCase()}|${dayPart}`)) continue;
    if (slot.date === date && slot.who.every((w) => signals.heavy.includes(w))) continue;
    const person = signals.offerTo[item.text.toLowerCase()] ?? null;
    const forWhom = person === null ? "" : ` ${nameOf(facts.people, person)} usually takes these.`;
    out.push({ itemId: item.id, title: item.text, why: `${pickReason(facts, item, slot.date, today, dayPart, slot.why)}${forWhom}`, person, slotDate: slot.date, dayPart, who: slot.who, neededBy: deadline === null ? null : { at: deadline.at.toISOString(), words: deadline.words } });
  }
  // Soonest slot first; on the same day, one with a deadline before one without, the sooner first (HOU-178).
  return out.sort((a, b) => a.slotDate.localeCompare(b.slotDate) || neededFirst(a.neededBy, b.neededBy));
}

function neededFirst(a: PickCandidate["neededBy"], b: PickCandidate["neededBy"]): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a.at.localeCompare(b.at);
}

/** HOU-173: `today` is the real current date, never the plan's: the age and the day words are both said from it. */
export function pickReason(facts: HouseFacts, item: BacklogItem, slotDate: LocalDate, today: LocalDate, dayPart: string, why: string[]): string {
  const words = dayPartWords(slotDate, today, dayPart);
  const day = `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
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
  const quick = items.filter((i) => i.tags.includes("quick")).map((i) => ({ item: i, slot: findSlot(facts, i, now, date, 1, deadlineOf(i, rt.timeZone)) }));
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
    // HOU-157: shop news is never the one thing to do now.
    if (closed.has(b.id) || b.id.startsWith(START_REF_PREFIX) || isShopNews(b)) continue;
    if (b.type === BlockType.suggestion) out.push({ ref: b.ref, title: b.title, why: b.reason, actions: withHandOver(b.ref, b.actions) });
  }
  // HOU-149: a thin house still gets one answer — the oldest small job that needs nothing it can't check.
  // It is marked `fallback`, so what_now can hold it back in quiet hours (the plan is made at 5:30).
  const small = out.length === 0 ? oldestSmall(items.filter((i) => !tooLate(deadlineOf(i, rt.timeZone), now))) : undefined;
  if (small !== undefined) {
    const ref = `backlog:${small.id}`;
    const age = daysBetween(localDate(new Date(small.createdAt), rt.timeZone), localDate(now, rt.timeZone));
    out.push({
      ref,
      title: small.text,
      why: `Of the quick jobs that need no weather, daylight or anyone else, it's the oldest (${age <= 0 ? "added today" : age === 1 ? "added yesterday" : `added ${age} days ago`}). About fifteen minutes.`,
      actions: withHandOver(ref, [
        { kind: ActionKind.done, label: "Done", ref },
        { kind: ActionKind.notToday, label: "Not today", ref },
      ]),
      fallback: true,
    });
  }
  return out;
}

/** Tags a quick job may carry and still be suggested without a slot: nothing about weather, daylight or who is home. */
const SMALL_OK: ReadonlySet<string> = new Set<string>([BacklogTag.quick, BacklogTag.phoneCall]);

/** The oldest active quick job whose only needs are being quick (or a phone call). */
function oldestSmall(items: readonly BacklogItem[]): BacklogItem | undefined {
  return items
    .filter((i) => i.status === BacklogStatus.active && i.tags.includes(BacklogTag.quick) && i.tags.every((t) => SMALL_OK.has(t)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

/** HOU-149: whether the calendar has ever been read and how many jobs are on the backlog. */
export async function houseFill(rt: Runtime): Promise<HouseFill> {
  const api = rt.system("planner");
  const backlogItems = (await api.backlog.list()).filter((i) => i.status === BacklogStatus.active).length;
  return { calendarConnected: Object.keys(await api.calendar.syncTokens()).length > 0, backlogItems };
}

/** CAP-10: open reminders someone asked for, from `from` to the day after `to` (each day's screen shows tomorrow's too). */
export async function remindersFor(rt: Runtime, from: LocalDate, to: LocalDate = from) {
  return rt.system("planner").backlog.reminders({ from, to: addLocalDays(to, 1) });
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
