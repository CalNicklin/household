import type { WeekView } from "@household/contracts";
import { compose } from "../planner/compose.ts";
import { gatherFacts, otherAdultOf } from "../planner/gather.ts";
import { allRules } from "../rules/nudges.ts";
import type { Runtime } from "../runtime.ts";
import { addLocalDays, localDate, longDate } from "../time.ts";
import { applyResponses } from "./screen.ts";

/** Week: each day's saved plan if there is one, else the rules' view of it (no agent, no picks). */
export async function weekView(rt: Runtime, _person: string): Promise<WeekView> {
  const now = rt.ports.clock.now();
  const today = localDate(now, rt.timeZone);
  const facts = await gatherFacts(rt, today, 8);
  const api = rt.system("views");
  const days: WeekView["days"] = [];
  for (let i = 0; i < 7; i++) {
    const date = addLocalDays(today, i);
    const saved = await api.plans.latest({ date });
    const closed = new Set((await api.plans.responsesOn({ date })).map((r) => r.ref));
    const blocks =
      saved?.blocks ??
      compose({ date, now, facts, rules: allRules(facts, date, now).items, closed, pick: null, oneThing: null, question: null, screenNotes: [], shopping: [], avoid: new Set(), otherAdult: otherAdultOf(facts) });
    days.push({ date, label: longDate(date), blocks: applyResponses(blocks, closed).filter((b) => b.type !== "composer" && b.type !== "context") });
  }
  return { days };
}
