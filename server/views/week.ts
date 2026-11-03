import { BlockType, ModeLabel, Section, type WeekView } from "@household/contracts";
import { compose } from "../planner/compose.ts";
import { gatherFacts, otherAdultOf, remindersFor } from "../planner/gather.ts";
import { modeOn } from "../rules/day.ts";
import { allRules } from "../rules/nudges.ts";
import type { Runtime } from "../runtime.ts";
import { addLocalDays, localDate, longDate } from "../time.ts";
import { pencilBlocks } from "../planner/pencil.ts";
import { applyResponses, openReminderBlocks, pencilledFrom, withPencils } from "./screen.ts";

/** Week: each day's saved plan if there is one, else the rules' view of it (no agent, no picks). */
export async function weekView(rt: Runtime, _person: string): Promise<WeekView> {
  const now = rt.ports.clock.now();
  const today = localDate(now, rt.timeZone);
  const facts = await gatherFacts(rt, today, 8);
  const api = rt.system("views");
  const reminders = await remindersFor(rt, today, addLocalDays(today, 6));
  const pencilled = await pencilledFrom(rt, today);
  const days: WeekView["days"] = [];
  for (let i = 0; i < 7; i++) {
    const date = addLocalDays(today, i);
    const latest = await api.plans.latest({ date });
    // HOU-156: a day's saved plan made before a mode was set ahead for it (or cleared) is out of date.
    const savedMode = latest?.blocks.find((b) => b.type === BlockType.mode);
    const saved = (savedMode?.type === BlockType.mode ? savedMode.mode : null) === (modeOn(facts, date, now)?.mode ?? null) ? latest : null;
    const closed = new Set((await api.plans.responsesOn({ date })).map((r) => r.ref));
    // HOU-149: "Getting started" is about the home screen, not a day, so Week never shows it.
    // HOU-177: a saved plan's reminder cards only for reminders still open there.
    const blocks =
      (saved === null ? null : openReminderBlocks(saved.blocks, reminders, date, now, rt.timeZone)) ??
      compose({ date, now, facts, rules: allRules(facts, date, now).items, closed, pick: null, oneThing: null, question: null, screenNotes: [], shopping: [], avoid: new Set(), otherAdult: otherAdultOf(facts), fill: null, reminders });
    // HOU-156: Week leaves out the context line that names the mode, so a later day's mode card says it.
    const named = date === today ? blocks : blocks.map((b) => (b.type === BlockType.mode ? { ...b, heading: ModeLabel[b.mode] } : b));
    days.push({ date, label: longDate(date), today: date === today, blocks: withPencils(applyResponses(named, closed), pencilBlocks(pencilled, date, today, facts.people)).filter((b) => b.type !== "composer" && b.type !== "context" && b.section !== Section.start) });
  }
  return { days };
}
