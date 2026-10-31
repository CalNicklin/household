/**
 * PRO-8: every reminder is a fixed rule with a test, never an AI guess. Each rule returns what the
 * screen should show (with a reason you could check yourself, HOME-3) and any message to send.
 */
import {
  ActionKind,
  type Arrival,
  type CalendarEvent,
  Limits,
  type LocalDate,
  type NotifyAction,
  NurseryEventKind,
  NurseryEventLabel,
  Provenance,
  Section,
  Urgency,
  WeekdayLabel,
} from "@household/contracts";
import { addLocalDays, atLocal, clock, daysBetween, hourWord, isoWeek, localDate, localHour, longDate, shortWeekday, weekdayOf } from "../time.ts";
import { adultsOf, dryWindowFrom, homeAt, type HouseFacts, isAway, kidsOf, nameOf, shortClock } from "./day.ts";

export type RuleItem = {
  kind: "alert" | "event" | "suggestion" | "arrival";
  ref: string;
  section: (typeof Section)[keyof typeof Section];
  title: string;
  detail: string;
  reason: string;
  time: string | null;
  provenance: (typeof Provenance)[keyof typeof Provenance];
  actions: NotifyAction[];
  /** Fixed things still show on a slow day (MOM-5); planner-made ones do not. */
  fixed: boolean;
};

export type RuleNudge = {
  key: string;
  /** A person, or everyone home at `at`. */
  to: { person: string } | { homeAt: string };
  message: string;
  urgency: (typeof Urgency)[keyof typeof Urgency];
  actions: NotifyAction[];
  /** When it should go: never before this instant. */
  at: string;
};

export type RuleOutput = { items: RuleItem[]; nudges: RuleNudge[] };

const empty = (): RuleOutput => ({ items: [], nudges: [] });
const join = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`);

// ── bins (PRO-3, CAP-7) ──────────────────────────────────────────────────────

export function binsFor(facts: HouseFacts, date: LocalDate): RuleOutput {
  const out = empty();
  const tomorrow = addLocalDays(date, 1);
  for (const rule of facts.rules) {
    if (rule.spec.kind !== "bins") continue;
    if (weekdayOf(tomorrow) !== rule.spec.collectionDay) continue;
    const bins = isoWeek(tomorrow) % 2 === 0 ? rule.spec.evenWeeks : rule.spec.oddWeeks;
    const what = bins.join(" + ");
    const ref = `bins:${tomorrow}`;
    const collected = WeekdayLabel[rule.spec.collectionDay];
    out.items.push({
      kind: "event",
      ref,
      section: Section.later,
      title: "Bins out",
      detail: `${what}, collected ${collected}`,
      reason: `Collection is ${collected}; ${what} this week`,
      time: "19:00",
      provenance: Provenance.rule,
      actions: [],
      fixed: true,
    });
    out.nudges.push({
      key: ref,
      to: { homeAt: atLocal(date, 19, 0, facts.timeZone).toISOString() },
      message: `Bins out tonight: ${what}. Collected ${collected} morning.`,
      urgency: Urgency.urgent,
      actions: [{ kind: ActionKind.done, label: "Done", ref }],
      at: atLocal(date, 19, 0, facts.timeZone).toISOString(),
    });
  }
  return out;
}

// ── babysitter (PRO-1, PRO-2) ────────────────────────────────────────────────

/** Evening events every adult is going to. */
function bothOutEvenings(facts: HouseFacts): CalendarEvent[] {
  const adults = adultsOf(facts.people).map((a) => a.id);
  return facts.events.filter((e) => localHour(new Date(e.start), facts.timeZone) >= 18 && adults.length > 0 && adults.every((a) => e.away.includes(a)));
}

function sitterFor(facts: HouseFacts, date: LocalDate): string | null {
  const weekday = weekdayOf(date);
  return (facts.sitters.find((s) => s.knownFreeDays.includes(weekday)) ?? facts.sitters[0])?.name ?? null;
}

export function babysitterFor(facts: HouseFacts, date: LocalDate): RuleOutput {
  const out = empty();
  const adults = adultsOf(facts.people);
  for (const e of bothOutEvenings(facts)) {
    const day = localDate(new Date(e.start), facts.timeZone);
    const until = daysBetween(date, day);
    // limit: sitterWarnDays
    if (until < 0 || until > Limits.sitterWarnDays.value) continue;
    if (facts.sitterBookings.some((b) => b.date === day)) continue;
    const sitter = sitterFor(facts, day);
    const ref = `sitter:${day}`;
    const when = until === 0 ? "tonight" : until === 1 ? "tomorrow" : shortWeekday(day);
    const at = clock(e.start, facts.timeZone);
    const action: NotifyAction[] = sitter === null ? [] : [{ kind: ActionKind.accept, label: `Ask ${sitter}`, ref, value: sitter }];
    out.items.push({
      kind: "alert",
      ref,
      section: until === 1 ? Section.tomorrow : Section.now,
      title: `You're both out ${when} at ${at} — no babysitter yet`,
      detail: sitter === null ? "No named sitter yet" : `Tap to ask ${sitter}`,
      reason: `${e.title}: ${join(adults.map((a) => a.name))} are both going, and no sitter is booked for ${longDate(day)}`,
      time: null,
      provenance: Provenance.rule,
      actions: action,
      fixed: true,
    });
    // limit: sitterRemindDays
    if (until === Limits.sitterRemindDays.value && sitter !== null) {
      const to = adults[daysBetween("2026-01-01", day) % Math.max(adults.length, 1)]?.id ?? adults[0]?.id;
      if (to !== undefined)
        out.nudges.push({
          key: `${ref}:remind`,
          to: { person: to },
          message: `You're both out on ${longDate(day)} at ${at} (${e.title}) and nobody's babysitting yet. Message ${sitter}?`,
          urgency: Urgency.urgent,
          actions: [{ kind: ActionKind.accept, label: `Ask ${sitter}`, ref, value: sitter }],
          at: atLocal(date, 9, 0, facts.timeZone).toISOString(),
        });
    }
  }
  return out;
}

// ── nursery (CAP-8, PRO-10) ──────────────────────────────────────────────────

function inTerm(facts: HouseFacts, date: LocalDate): boolean {
  return facts.nurseryTerms.some((t) => t.start <= date && date <= t.end);
}

function nurseryClosed(facts: HouseFacts, date: LocalDate): boolean {
  return facts.nurseryEvents.some((e) => e.date === date && (e.kind === NurseryEventKind.closure || e.kind === NurseryEventKind.inset));
}

/** Kids at nursery on a date: their session days, in term, unless it is closed. */
export function kidsAtNursery(facts: HouseFacts, date: LocalDate): string[] {
  if (!inTerm(facts, date) || nurseryClosed(facts, date)) return [];
  const weekday = weekdayOf(date);
  return kidsOf(facts.people)
    .filter((k) => k.nurseryDays.includes(weekday))
    .map((k) => k.id);
}

export function nurseryFor(facts: HouseFacts, date: LocalDate): RuleOutput {
  const out = empty();
  const at = kidsAtNursery(facts, date);
  if (at.length > 0)
    out.items.push({
      kind: "event",
      ref: `nursery:${date}`,
      section: Section.now,
      title: "Nursery",
      detail: join(at.map((k) => nameOf(facts.people, k))),
      reason: `${WeekdayLabel[weekdayOf(date)]} is a session day in term`,
      time: null,
      provenance: Provenance.rule,
      actions: [],
      fixed: true,
    });
  for (const t of facts.nurseryTerms) {
    if (t.start === date) out.items.push(nurseryRow(`nursery-term:${date}`, Section.now, "Nursery term starts today", `Term runs to ${longDate(t.end)}`));
    if (t.end === date) out.items.push(nurseryRow(`nursery-term:${date}`, Section.now, "Last day of nursery term", `Next term from the household's term dates`));
  }
  for (const e of facts.nurseryEvents) {
    if (e.date === date && e.kind !== NurseryEventKind.party) out.items.push(nurseryRow(`nursery-event:${e.id}`, Section.now, e.title, NurseryEventLabel[e.kind]));
    const tomorrow = addLocalDays(date, 1);
    if (e.date !== tomorrow) continue;
    const ref = `nursery-event:${e.id}`;
    if (e.coveredBy !== null) {
      out.items.push({ ...nurseryRow(ref, Section.tomorrow, e.title, `${nameOf(facts.people, e.coveredBy)} is covering`), reason: `${NurseryEventLabel[e.kind]} tomorrow; ${nameOf(facts.people, e.coveredBy)} said they would cover` });
    } else {
      out.items.push({
        kind: "alert",
        ref,
        section: Section.tomorrow,
        title: `${e.title} tomorrow — nobody is covering yet`,
        detail: "Decide who has the kids",
        reason: `${NurseryEventLabel[e.kind]} on ${longDate(e.date)} and nobody is down to cover`,
        time: null,
        provenance: Provenance.rule,
        actions: [],
        fixed: true,
      });
    }
  }
  return out;
}

function nurseryRow(ref: string, section: RuleItem["section"], title: string, detail: string): RuleItem {
  return { kind: "event", ref, section, title, detail, reason: detail, time: null, provenance: Provenance.rule, actions: [], fixed: true };
}

// ── washing (PRO-4) ──────────────────────────────────────────────────────────

/** A dry window of three hours or more, someone home at the start: a suggestion that morning. Never a message. */
export function washingFor(facts: HouseFacts, date: LocalDate, now: Date): RuleOutput {
  const out = empty();
  const today = localDate(now, facts.timeZone) === date;
  const fromHour = today ? Math.max(localHour(now, facts.timeZone), 7) : 7;
  if (fromHour >= 12) return out;
  const w = dryWindowFrom(facts, date, fromHour);
  // limit: washingDryHours
  if (w === null || w.start >= 12 || w.end - w.start < Limits.washingDryHours.value) return out;
  const start = atLocal(date, w.start, 0, facts.timeZone);
  const home = homeAt(facts, start);
  if (home.length === 0) return out;
  const adults = adultsOf(facts.people);
  const leaves = facts.events
    .filter((e) => e.away.some((p) => home.includes(p)) && new Date(e.start) > start && localDate(new Date(e.start), facts.timeZone) === date)
    .map((e) => new Date(e.start))
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const who = home.length === adults.length && adults.length > 1 ? "you're both in" : `${join(home.map((h) => nameOf(facts.people, h)))} is in`;
  const presence = leaves === undefined ? `${who} all day` : `${who} till ${shortClock(leaves, facts.timeZone)}`;
  const dry = w.end > 21 ? "Dry all day" : `Dry until ${hourWord(w.end)}`;
  const ref = `washing:${date}`;
  out.items.push({
    kind: "suggestion",
    ref,
    section: Section.now,
    title: "Hang the washing out",
    detail: `${dry} and ${presence}`,
    reason: `${dry} and ${presence}`,
    time: null,
    provenance: Provenance.planner,
    actions: [
      { kind: ActionKind.done, label: "Doing it", ref },
      { kind: ActionKind.notToday, label: "Not today", ref },
    ],
    fixed: false,
  });
  return out;
}

// ── deliveries (PRO-5, CAP-9) ────────────────────────────────────────────────

export function arrivalsFor(facts: HouseFacts, date: LocalDate): RuleOutput {
  const out = empty();
  const tomorrow = addLocalDays(date, 1);
  const relevant = facts.arrivals.filter((a) => a.expectedDate === date || a.expectedDate === tomorrow).sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
  for (const a of relevant) {
    out.items.push(arrivalItem(a, date));
    if (a.expectedDate !== date || !a.needsSomeoneIn) continue;
    const ref = `arrival:${a.id}`;
    const recipients = a.person === null ? adultsOf(facts.people).map((p) => p.id) : [a.person];
    for (const person of recipients)
      out.nudges.push({
        key: `${ref}:morning`,
        to: { person },
        message: `${a.shop} delivery today${a.window === null ? "" : `, ${a.window}`}. Someone needs to be in.`,
        urgency: Urgency.urgent,
        actions: [{ kind: ActionKind.done, label: "Got it", ref }],
        at: atLocal(date, 7, 30, facts.timeZone).toISOString(),
      });
  }
  return out;
}

function arrivalItem(a: Arrival, date: LocalDate): RuleItem {
  const day = a.expectedDate === date ? "today" : "tomorrow";
  const when = a.window === null ? day : `${day}, ${a.window}`;
  return {
    kind: "arrival",
    ref: `arrival:${a.id}`,
    section: Section.arriving,
    title: a.shop,
    detail: when,
    reason: `Order confirmation from ${a.shop}: expected ${when}${a.needsSomeoneIn ? "; someone needs to be in" : "; can be left"}`,
    time: null,
    provenance: Provenance.email,
    actions: [],
    fixed: true,
  };
}

// ── chores (CAP-7) ───────────────────────────────────────────────────────────

export function choresFor(facts: HouseFacts, date: LocalDate): RuleOutput {
  const out = empty();
  for (const rule of facts.rules) {
    if (rule.spec.kind !== "chore") continue;
    const since = daysBetween(rule.spec.anchorDate, date);
    if (since < 0 || since % rule.spec.everyDays !== 0) continue;
    out.items.push({
      kind: "event",
      ref: `chore:${rule.id}:${date}`,
      section: Section.later,
      title: rule.spec.title,
      detail: `every ${rule.spec.everyDays} days`,
      reason: `Your rule: ${rule.spec.title.toLowerCase()} every ${rule.spec.everyDays} days`,
      time: null,
      provenance: Provenance.rule,
      actions: [],
      fixed: true,
    });
  }
  return out;
}

/** Everyone home at an instant who could receive "whoever is home" nudges (PRO-3). */
export function recipientsHomeAt(facts: HouseFacts, at: Date): string[] {
  const home = homeAt(facts, at);
  return home.length > 0 ? home : adultsOf(facts.people).filter((a) => !isAway(facts, a.id, at)).map((a) => a.id);
}

export function allRules(facts: HouseFacts, date: LocalDate, now: Date): RuleOutput {
  const parts = [binsFor(facts, date), babysitterFor(facts, date), nurseryFor(facts, date), washingFor(facts, date, now), arrivalsFor(facts, date), choresFor(facts, date)];
  return { items: parts.flatMap((p) => p.items), nudges: parts.flatMap((p) => p.nudges) };
}
