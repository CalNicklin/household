import { ActionKind, type Block, BlockType, type LocalDate, type Reminder, type ScreenView, Section } from "@household/contracts";
import { plannerBuildId } from "../build.ts";
import type { Runtime } from "../runtime.ts";
import { pencilBlocks, type Pencilled, pencilledItems, pencilWindow } from "../planner/pencil.ts";
import { remindersFor } from "../planner/gather.ts";
import { reminderSection } from "../rules/remind.ts";
import { localDate } from "../time.ts";

const CLOSING: ReadonlySet<string> = new Set<string>([ActionKind.done, ActionKind.notToday, ActionKind.snooze, ActionKind.handOver, ActionKind.accept, ActionKind.answer, ActionKind.notHelpful]);

/** HOME-4/5: a tap hides the thing everywhere at once — responses are applied when the screen is read. */
export function applyResponses(blocks: readonly Block[], closed: ReadonlySet<string>): Block[] {
  return blocks
    .filter((b) => !closed.has(b.id) && !("ref" in b && closed.has(b.ref)))
    .map((b) => {
      if (b.type !== BlockType.mode || b.pick === null || !closed.has(b.pick.ref)) return b;
      return { ...b, pick: null };
    });
}

/**
 * HOU-177: a saved plan's reminder card shows only while its reminder is still open, at that time,
 * for that day: the screen never shows a reminder the house can't find (one already done, cancelled or
 * moved), whose "…" menu would then delete nothing.
 */
export function openReminderBlocks(blocks: readonly Block[], open: readonly Reminder[], date: LocalDate, now: Date, timeZone: string): Block[] {
  const byRef = new Map(open.map((r) => [`reminder:${r.id}`, r]));
  return blocks.filter((b) => {
    if (b.type !== BlockType.reminder) return true;
    const r = byRef.get(b.ref);
    return r !== undefined && r.time === b.time && reminderSection(r, date, now, timeZone) !== null;
  });
}

/** Sections that come after a day's own Now and Later. */
const AFTER_LATER: ReadonlySet<string> = new Set<string>([Section.tomorrow, Section.arriving, Section.fits, Section.focus, Section.footer]);

/** HOU-173: a day's pencilled-in items go at the end of its Later part, before Tomorrow and the rest. */
export function withPencils(blocks: readonly Block[], pencils: readonly Block[]): Block[] {
  const at = blocks.findIndex((b) => AFTER_LATER.has(b.section));
  return at === -1 ? [...blocks, ...pencils] : [...blocks.slice(0, at), ...pencils, ...blocks.slice(at)];
}

/** HOU-173: what has been pencilled in from the backlog for today or later, read back from the responses. */
export async function pencilledFrom(rt: Runtime, today: LocalDate): Promise<Pencilled[]> {
  const api = rt.system("views");
  return pencilledItems(await api.plans.responsesBetween(pencilWindow(today)), await api.backlog.list(), today);
}

/**
 * The home screen (HOME-7): the server's ordered blocks for today, as last planned, with responses
 * applied. No model call is needed to read it (Platform: "the morning screen never needs the AI").
 */
export async function screenView(rt: Runtime, _person: string, date: LocalDate, planToday?: (build: string | null) => Promise<unknown>): Promise<ScreenView> {
  const api = rt.system("views");
  const plan = await api.plans.latest({ date });
  const build = plannerBuildId();
  // HOU-149: no plan for today yet (a new house, a missed timer): start one through the normal job
  // path and show what there is. The plan publishes `plan` when it lands, so the screen refetches.
  // HOU-154: a plan made by an older build is redone the same way, once per build (`build` is passed
  // so the job can be deduplicated on it); until it lands, the older plan is what shows.
  if ((plan === null || plan.build !== build) && planToday !== undefined && date === localDate(rt.ports.clock.now(), rt.timeZone)) {
    await planToday(plan === null ? null : build).catch((e: unknown) => console.warn(JSON.stringify({ event: "catch-up-plan-failed", error: e instanceof Error ? e.message : String(e) })));
  }
  const closed = new Set((await api.plans.responsesOn({ date })).filter((r) => CLOSING.has(r.action)).map((r) => r.ref));
  const now = rt.ports.clock.now();
  const today = localDate(now, rt.timeZone);
  const shown = openReminderBlocks(plan?.blocks ?? [], await remindersFor(rt, date), date, now, rt.timeZone);
  const pencils = pencilBlocks(await pencilledFrom(rt, today), date, today, await api.household.people());
  return {
    date,
    version: plan?.version ?? 0,
    generatedAt: plan?.createdAt ?? now.toISOString(),
    blocks: withPencils(applyResponses(shown, closed), pencils),
  };
}
