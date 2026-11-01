/**
 * The planner (HOME-7): an ordered list of typed blocks, each with a reason. Deterministic given
 * its inputs; the agent's only contribution is which backlog item fills a gap and its wording.
 */
import {
  ActionKind,
  type Block,
  BlockType,
  type LocalDate,
  type Mode,
  ModeKind,
  ModeLabel,
  type Notification,
  type NotifyAction,
  Placement,
  Provenance,
  type Question,
  Section,
  type ShoppingRequest,
  ShoppingStatus,
} from "@household/contracts";
import { addLocalDays, atLocal, clock, localDate, longDate } from "../time.ts";
import { contextLine, eventsOn, type HouseFacts, nameOf } from "../rules/day.ts";
import type { RuleItem } from "../rules/nudges.ts";
import { firstDayBlocks, type HouseFill } from "./first-day.ts";

export type BacklogPick = { itemId: string; title: string; why: string; person: string | null };
/** `fallback`: the thin-house answer (HOU-149), offered only when nothing else is, and not in quiet hours. */
export type OneThing = { ref: string; title: string; why: string; actions: NotifyAction[]; fallback?: true };

export type ComposeInput = {
  date: LocalDate;
  now: Date;
  facts: HouseFacts;
  rules: RuleItem[];
  /** Refs someone already marked done / not today / handed over today. */
  closed: ReadonlySet<string>;
  pick: BacklogPick | null;
  oneThing: OneThing | null;
  question: Question | null;
  screenNotes: Notification[];
  /** AUT-1/3: today's shopping requests — what was added and which product, or the one question. */
  shopping: ShoppingRequest[];
  /** Day parts in which a subject's suggestions are not offered (LRN-5). */
  avoid: ReadonlySet<string>;
  otherAdult: (person: string) => string | null;
  /** HOU-149: how much the house has in it, for the first-day blocks; null for Week's unsaved days (Week hides them anyway). */
  fill: HouseFill | null;
};

const placementOf: Record<(typeof Section)[keyof typeof Section], (typeof Placement)[keyof typeof Placement]> = {
  [Section.header]: Placement.header,
  [Section.now]: Placement.main,
  [Section.later]: Placement.main,
  [Section.tomorrow]: Placement.main,
  [Section.start]: Placement.main,
  [Section.arriving]: Placement.aside,
  [Section.fits]: Placement.aside,
  [Section.focus]: Placement.focus,
  [Section.footer]: Placement.footer,
};

const NOW_WINDOW_MS = 4 * 3_600_000;

function ruleBlock(r: RuleItem): Block {
  const base = { id: r.ref, section: r.section, placement: placementOf[r.section], reason: r.reason, provenance: r.provenance };
  switch (r.kind) {
    case "alert":
      return { ...base, type: BlockType.alert, title: r.title, ref: r.ref, action: r.actions[0] ?? null };
    case "suggestion":
      return { ...base, type: BlockType.suggestion, title: r.title, ref: r.ref, actions: r.actions };
    case "arrival":
      return { ...base, type: BlockType.arrival, shop: r.title, when: r.detail, ref: r.ref };
    case "event":
      return { ...base, type: BlockType.event, time: r.time, title: r.title, detail: r.detail, ref: r.ref };
  }
}

function calendarBlocks(input: ComposeInput): Block[] {
  const { facts, date, now } = input;
  const today = localDate(now, facts.timeZone) === date;
  const nowCut = today ? now.getTime() + NOW_WINDOW_MS : atLocal(date, 12, 0, facts.timeZone).getTime();
  return eventsOn(facts, date)
    .filter((e) => !today || new Date(e.end) > now)
    .map((e): Block => {
      const section = new Date(e.start).getTime() < nowCut ? Section.now : Section.later;
      const who = e.attendees
        .filter((a) => facts.people.some((p) => p.id === a))
        .map((a) => nameOf(facts.people, a))
        .filter((n) => !e.title.includes(n));
      const detailParts = [who.join(" & "), e.soloWithKids === null ? "" : `${nameOf(facts.people, e.soloWithKids)} has the kids`].filter((x) => x !== "");
      return {
        id: `event:${e.externalId}:${date}`,
        type: BlockType.event,
        section,
        placement: Placement.main,
        reason: "From the shared calendar",
        provenance: Provenance.calendar,
        time: e.allDay ? null : clock(e.start, facts.timeZone),
        title: e.title,
        detail: detailParts.join(" · "),
        ref: `event:${e.externalId}`,
      };
    });
}

function tomorrowEvents(input: ComposeInput): Block[] {
  const tomorrow = addLocalDays(input.date, 1);
  const first = eventsOn(input.facts, tomorrow).find((e) => !e.allDay);
  if (first === undefined) return [];
  return [
    {
      id: `event:${first.externalId}:${tomorrow}`,
      type: BlockType.event,
      section: Section.tomorrow,
      placement: Placement.main,
      reason: "First thing tomorrow, from the shared calendar",
      provenance: Provenance.calendar,
      time: clock(first.start, input.facts.timeZone),
      title: first.title,
      detail: first.attendees.map((a) => nameOf(input.facts.people, a)).join(" & "),
      ref: `event:${first.externalId}`,
    },
  ];
}

const sortKey = (b: Block): string => (b.type === BlockType.event ? (b.time ?? "00:00") : "");
const sectionOrder: readonly string[] = [Section.start, Section.now, Section.later, Section.tomorrow, Section.arriving, Section.fits];
const typeRank = (b: Block): number => (b.type === BlockType.alert ? 0 : b.type === BlockType.suggestion ? 1 : 2);

function modeHeading(mode: Mode, facts: HouseFacts): string {
  return `${ModeLabel[mode.mode]} · ${nameOf(facts.people, mode.setBy)} said so at ${clock(mode.setAt, facts.timeZone)}`;
}

/** MOM-1 / MOM-5: one suggested thing, and the fixed things still happening anyway. */
function composeMode(input: ComposeInput, mode: Mode, header: Block): Block[] {
  const fixed = [...calendarBlocks(input), ...input.rules.filter((r) => r.fixed).map(ruleBlock)].filter((b) => !input.closed.has(b.id));
  const pickRef = input.oneThing?.ref;
  const still = fixed.filter((b) => !("ref" in b) || b.ref !== pickRef).map((b) => ({ id: b.id, provenance: b.provenance, text: stillText(b) }));
  const pick = input.oneThing === null ? null : { ref: input.oneThing.ref, title: input.oneThing.title, why: input.oneThing.why, actions: input.oneThing.actions };
  const block: Block = {
    id: `mode:${input.date}`,
    type: BlockType.mode,
    section: Section.focus,
    placement: Placement.focus,
    reason: `${ModeLabel[mode.mode]} until ${clock(mode.endsAt, input.facts.timeZone)}; the app's own suggestions are hidden`,
    provenance: Provenance.planner,
    mode: mode.mode,
    heading: "If you do one thing",
    pick,
    stillHappening: still,
  };
  const context = header.type === BlockType.context ? { ...header, line: modeHeading(mode, input.facts) } : header;
  return [context, block, composer()];
}

function stillText(b: Block): string {
  switch (b.type) {
    case BlockType.event:
      return [b.time, b.title, b.detail].filter((x) => x !== null && x !== "").join(" · ");
    case BlockType.alert:
      return b.title;
    case BlockType.arrival:
      return `${b.shop} parcel ${b.when}`;
    case BlockType.suggestion:
    case BlockType.backlogPick:
      return b.title;
    case BlockType.context:
    case BlockType.mode:
    case BlockType.composer:
      return "";
  }
}

function composer(): Block {
  return {
    id: "composer",
    type: BlockType.composer,
    section: Section.footer,
    placement: Placement.footer,
    reason: "Always here: type or talk, same as WhatsApp",
    provenance: Provenance.planner,
    placeholder: "Tell me something, or ask — “we're out of oat milk”, “slow day, one thing?”",
  };
}

/** LRN-4: the question says which specific gap it is about. */
function questionReason(q: Question): string {
  switch (q.topic) {
    case "chore-rhythm":
      return `"${q.subject}" has been done but there is no rhythm for it yet; ignore this if you like`;
    case "job-length":
      return "It has no length tag (15 min, an hour or half a day), so it can't be fitted into a gap";
    case "sitter-days":
      return `No free days are known for ${q.subject} yet`;
  }
}

export function compose(input: ComposeInput): Block[] {
  const { facts, date, now } = input;
  const header: Block = {
    id: `context:${date}`,
    type: BlockType.context,
    section: Section.header,
    placement: Placement.header,
    reason: "Forecast, sunset and the shared calendar",
    provenance: Provenance.rule,
    title: longDate(date),
    line: contextLine(facts, date, now),
  };
  const mode = facts.mode;
  if (mode !== null && mode.mode !== ModeKind.normal && localDate(new Date(mode.setAt), facts.timeZone) <= date && new Date(mode.endsAt) > atLocal(date, 12, 0, facts.timeZone)) {
    return composeMode(input, mode, header);
  }

  const body: Block[] = [...(input.fill === null ? [] : firstDayBlocks(input.fill)), ...input.rules.map(ruleBlock), ...calendarBlocks(input), ...tomorrowEvents(input)];
  for (const n of input.screenNotes) {
    body.push({
      id: `note:${n.id}`,
      type: BlockType.alert,
      section: Section.now,
      placement: Placement.main,
      reason: `Held for the morning screen (${n.status === "deferred" ? "quiet hours or daily limit" : "your routing sends this here"})`,
      provenance: Provenance.rule,
      title: `For ${nameOf(facts.people, n.person)}: ${n.message}`,
      ref: n.key,
      action: n.actions[0] ?? { kind: ActionKind.done, label: "Done", ref: n.key },
    });
  }
  if (input.pick !== null)
    body.push({
      id: `backlog:${input.pick.itemId}`,
      type: BlockType.backlogPick,
      section: Section.fits,
      placement: Placement.aside,
      reason: input.pick.why,
      provenance: Provenance.planner,
      title: input.pick.title,
      ref: `backlog:${input.pick.itemId}`,
      actions: [
        { kind: ActionKind.accept, label: "Pencil it in", ref: `backlog:${input.pick.itemId}` },
        { kind: ActionKind.notToday, label: "Not now", ref: `backlog:${input.pick.itemId}` },
      ],
    });
  for (const r of input.shopping) {
    const ref = `shopping:${r.id}`;
    // HOU-157: every shop block is planner-made, so each has a no-guilt dismiss (HOME-4).
    if (r.status === ShoppingStatus.added && r.chosen !== null)
      body.push({
        id: `${ref}:added`,
        type: BlockType.suggestion,
        section: Section.now,
        placement: Placement.main,
        reason: `You said "${r.item}"; the shopping helper added the exact match, ${r.chosen.price}`,
        provenance: Provenance.planner,
        title: `Added to the shop: ${r.chosen.name}`,
        ref: `${ref}:added`,
        actions: [{ kind: ActionKind.notToday, label: "Dismiss", ref: `${ref}:added` }],
      });
    if (r.status === ShoppingStatus.needsChoice)
      body.push({
        id: ref,
        type: BlockType.suggestion,
        section: Section.now,
        placement: Placement.main,
        reason: `No exact match for "${r.item}", so nothing was added`,
        provenance: Provenance.planner,
        title: `Which ${r.item}?`,
        ref,
        actions: r.options.map((o) => ({ kind: ActionKind.answer, label: o.name, ref, value: o.sku })),
      });
    if (r.status === ShoppingStatus.failed)
      body.push({
        id: ref,
        type: BlockType.suggestion,
        section: Section.now,
        placement: Placement.main,
        reason: `The supermarket had nothing like "${r.item}", so nothing was added`,
        provenance: Provenance.planner,
        title: `Couldn't find ${r.item}`,
        ref,
        actions: [{ kind: ActionKind.notToday, label: "Dismiss", ref }],
      });
  }
  if (input.question !== null)
    body.push({
      id: `question:${input.question.id}`,
      type: BlockType.suggestion,
      section: Section.fits,
      placement: Placement.aside,
      reason: questionReason(input.question),
      provenance: Provenance.planner,
      title: input.question.text,
      ref: `question:${input.question.id}`,
      actions: input.question.options.map((o) => ({ kind: ActionKind.answer, label: o.label, ref: `question:${input.question?.id ?? ""}`, value: o.value })),
    });

  const visible = body.filter((b) => !input.closed.has(b.id) && !(b.type === BlockType.suggestion && input.avoid.has(b.id)));
  const seen = new Set<string>();
  const unique = visible.filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));
  unique.sort((a, b) => sectionOrder.indexOf(a.section) - sectionOrder.indexOf(b.section) || typeRank(a) - typeRank(b) || sortKey(a).localeCompare(sortKey(b)));
  return [header, ...unique, composer()];
}

/**
 * HOU-157: the shopping requests that may make a home block. With no shopping helper connected nothing
 * was ever looked for, so no request makes one (a request from before HOU-148 may still say failed);
 * the Shop screen shows them as saved instead.
 */
export function shoppingForPlan(requests: readonly ShoppingRequest[], helperConnected: boolean): ShoppingRequest[] {
  return helperConnected ? [...requests] : [];
}

/**
 * HOU-157: a "Couldn't find" or "Added to the shop" card is news about the shop, not something the house
 * suggests: its only action is Dismiss. The "Which one?" question (AUT-3) is a real suggestion.
 */
export function isShopNews(b: Block): boolean {
  return b.type === BlockType.suggestion && b.ref.startsWith("shopping:") && b.actions.every((a) => a.kind === ActionKind.notToday);
}
