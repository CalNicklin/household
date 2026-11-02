import { DBOS } from "@dbos-inc/dbos-sdk";
import { Channel, type LocalDate, type Plan } from "@household/contracts";
import { HouseAgent } from "../agent/agent.ts";
import { jobScope } from "../agent/scope.ts";
import { compose, shoppingForPlan } from "../planner/compose.ts";
import { gatherFacts, houseFill, otherAdultOf, pickCandidates, screenNotes } from "../planner/gather.ts";
import { plannerBuildId } from "../build.ts";
import { allRules } from "../rules/nudges.ts";
import { dayPartOf } from "../agent/respond.ts";
import { localDate, localHour } from "../time.ts";
import { jobRuntime } from "./context.ts";
import { planningSignals } from "./signals.ts";

type PlanResult = { plan: Plan; inputTokens: number; outputTokens: number; costMicros: number };

/**
 * PLT-4 / HOME-11: plan one day and keep the version with the inputs that made it. Rules are plain
 * code; the agent's only part is choosing which backlog item fills a gap (PRO-8).
 */
async function planDayImpl(date: LocalDate, trigger: string, parentJob: string | null): Promise<PlanResult> {
  const rt = jobRuntime();
  const gathered = await DBOS.runStep(
    async () => {
      const now = rt.ports.clock.now();
      const facts = await gatherFacts(rt, date, 7);
      const signals = await planningSignals(rt, date, now, facts);
      const candidates = await pickCandidates(rt, facts, date, now, signals);
      const fill = await houseFill(rt);
      return { now: now.toISOString(), facts, signals, candidates, fill };
    },
    { name: "gather" },
  );
  const choice = await DBOS.runStep(
    async () => {
      const agent = new HouseAgent(jobScope(rt, parentJob ?? DBOS.workflowID ?? "plan", `plan:${date}`, null, Channel.timer));
      return agent.chooseBacklog(gathered.candidates);
    },
    { name: "choose-backlog" },
  );
  const plan = await DBOS.runStep(
    async () => {
      const now = new Date(gathered.now);
      const { facts, signals } = gathered;
      const all = allRules(facts, date, now);
      const part = dayPartOf(localHour(now, rt.timeZone));
      // LRN-5: a planner suggestion whose day part keeps getting dismissed is not offered then.
      const rules = { ...all, items: all.items.filter((r) => r.kind !== "suggestion" || !signals.avoid.includes(`${r.title.toLowerCase()}|${part}`)) };
      const today = localDate(now, rt.timeZone) === date;
      const notes = today ? await screenNotes(rt) : [];
      const asked = today ? (await rt.system("planner").shopping.recent()).filter((r) => localDate(new Date(r.createdAt), rt.timeZone) === date) : [];
      const shopping = shoppingForPlan(asked, rt.ports.shopping.connected);
      const blocks = compose({
        date,
        now,
        facts,
        rules: rules.items,
        closed: new Set(signals.closed),
        pick: choice.pick,
        oneThing: signals.oneThing,
        question: signals.question,
        screenNotes: notes,
        shopping,
        avoid: new Set<string>(),
        otherAdult: otherAdultOf(facts),
        fill: gathered.fill,
      });
      const api = rt.system("planner");
      if (choice.pick !== null) await api.plans.recordOffer({ itemId: choice.pick.itemId, date, person: choice.pick.person });
      return api.plans.save({ date, blocks, inputs: { trigger, build: plannerBuildId(), facts, signals, candidates: gathered.candidates.map((c) => c.itemId), pick: choice.pick?.itemId ?? null }, trigger, jobId: parentJob });
    },
    { name: "compose-and-save" },
  );
  return { plan, inputTokens: choice.inputTokens, outputTokens: choice.outputTokens, costMicros: choice.costMicros };
}

export const planDay = DBOS.registerWorkflow(planDayImpl, { name: "planDay" });
