import { DBOS } from "@dbos-inc/dbos-sdk";
import { type LocalDate, type LongStep, zLongStep, zLongStepReport } from "@household/contracts";
import { longStepKey, runLongStep } from "../agent/long-steps.ts";
import type { Effects } from "../agent/scope.ts";
import { messageSitter, notify } from "../notify/notify.ts";
import { longDate } from "../time.ts";
import { jobRuntime } from "./context.ts";
import { planDay } from "./plan-day.ts";

type Usage = { inputTokens: number; outputTokens: number; costMicros: number };

/**
 * Durable follow-through: re-plans, child workflows, messages. Each is its own checkpointed step.
 * The one path every tool's effects take, a long step's included, so their cost lands on `jobId`.
 */
export async function applyEffects(jobId: string, effects: Effects, person: string | null, trigger = `job:${jobId}`): Promise<Usage> {
  const rt = jobRuntime();
  const totals = { inputTokens: 0, outputTokens: 0, costMicros: 0 };
  for (const c of effects.closeRefs) await DBOS.runStep(async () => rt.system("PRO-9").jobs.closeNotificationsForRef(c), { name: `close:${c.ref}` });
  for (const n of effects.notify) await DBOS.runStep(async () => notify(rt, n, jobId), { name: `notify:${n.key}` });
  for (const s of effects.sitterAsk)
    await DBOS.runStep(
      async () => {
        const people = await rt.system("sitter").household.people();
        const from = people.find((p) => p.id === s.from)?.name ?? "We";
        await messageSitter(rt, s.sitter, `Hi ${s.sitter}, are you free to babysit on ${longDate(s.date)} in the evening? — ${from} (sent from our household app)`);
      },
      { name: `sitter:${s.sitter}:${s.date}` },
    );
  if (person !== null) for (const [i, m] of effects.remember.entries()) await DBOS.runStep(async () => rt.ports.memory.retain({ household: rt.env.HOUSEHOLD_ID, person }, m), { name: `remember:${i}` });
  const dates: LocalDate[] = [...new Set(effects.replan)];
  for (const date of dates) {
    const r = await planDay(date, trigger, jobId);
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.costMicros += r.costMicros;
  }
  // PLT-10: long tool calls are child workflows. They report back to this job; the coordinator never waits.
  for (const s of effects.long) await DBOS.startWorkflow(longToolCall, { workflowID: `${jobId}:${s.tool}:${longStepKey(s)}` })(s, jobId, person);
  return totals;
}

/**
 * PLT-10: one child workflow for every tool's long step. The step runs checkpointed, its effects go
 * through `applyEffects` on the job that asked, and it reports back to that job, which never waits.
 */
async function longToolCallImpl(step: LongStep, parentJob: string, person: string | null): Promise<void> {
  const rt = jobRuntime();
  // The step and its report cross DBOS's serialised boundary; both are checked against their contracts.
  const checked = zLongStep.parse(step);
  const { effects, report } = await DBOS.runStep(async () => {
    const r = await runLongStep(rt, checked, person);
    return { effects: r.effects, report: zLongStepReport.parse(r.report) };
  }, { name: checked.tool });
  const usage = await applyEffects(parentJob, effects, person, `${checked.tool}:${report.key}`);
  await DBOS.send(parentJob, report, checked.tool);
  if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.costMicros === 0) return;
  // QA-8 / QA-10: the parent writes its own totals when it finishes, so add ours after that. A job that
  // failed still recorded its totals, so its error is not this workflow's.
  try {
    await DBOS.retrieveWorkflow(parentJob).getResult();
  } catch {
    // The parent's error is on its own job row.
  }
  // Keyed by this workflow, so a usage step that re-runs after a crash adds nothing the second time.
  const source = DBOS.workflowID ?? `${parentJob}:${checked.tool}:${report.key}`;
  await DBOS.runStep(async () => rt.system("QA-8").jobs.addJobUsage({ id: parentJob, source, ...usage }), { name: "usage" });
}

const longToolCall = DBOS.registerWorkflow(longToolCallImpl, { name: "longToolCall" });
