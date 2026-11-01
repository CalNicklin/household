import { ActionKind, type LocalDate, type Question } from "@household/contracts";
import { avoidedDayParts, offerTargets, questionFor } from "../learning/learn.ts";
import type { OneThing } from "../planner/compose.ts";
import { oneThingCandidates } from "../planner/gather.ts";
import type { HouseFacts } from "../rules/day.ts";
import type { Runtime } from "../runtime.ts";
import { heavyPeople } from "../wellbeing/run.ts";

export type Signals = {
  /** Refs someone closed for this date: done, not today, handed over, snoozed. */
  closed: string[];
  /** LRN-5: "subject|dayPart" pairs not to offer. */
  avoid: string[];
  /** LRN-6: subject → person. */
  offerTo: Record<string, string>;
  /** PRO-6: the item already offered today, if any (it stays the day's pick). */
  todayOffer: string | null;
  heavy: string[];
  oneThing: OneThing | null;
  question: Question | null;
};

const CLOSING: ReadonlySet<string> = new Set<string>([ActionKind.done, ActionKind.notToday, ActionKind.handOver, ActionKind.snooze, ActionKind.accept, ActionKind.answer, ActionKind.notHelpful]);

export async function planningSignals(rt: Runtime, date: LocalDate, now: Date, facts: HouseFacts): Promise<Signals> {
  const api = rt.system("signals");
  const responses = await api.plans.responsesOn({ date });
  const closed = [...new Set(responses.filter((r) => CLOSING.has(r.action)).map((r) => r.ref))];
  const avoid = [...(await avoidedDayParts(rt))];
  const todayOffer = (await api.plans.offers()).find((o) => o.date === date)?.itemId ?? null;
  const heavy = await heavyPeople(rt, date, facts);
  const mode = facts.mode;
  const oneThing = mode === null ? null : ((await oneThingCandidates(rt, facts, date, now, new Set(closed), mode.setBy))[0] ?? null);
  return { closed, avoid, offerTo: Object.fromEntries(await offerTargets(rt)), todayOffer, heavy, oneThing, question: await questionFor(rt, date) };
}
