import { type LongStep, type LongStepReport, LongTool, ShoppingStatus } from "@household/contracts";
import type { HelperResult } from "../ports.ts";
import { shoppingQuestion } from "../rules/shopping.ts";
import { localDate } from "../time.ts";
import type { Runtime } from "../runtime.ts";
import { type Effects, emptyEffects } from "./scope.ts";

/** What a long step leaves behind: ordinary effects for the shared path, and what to report to its job. */
type LongStepResult = { effects: Effects; report: LongStepReport };

const STATUS = { added: ShoppingStatus.added, "needs-choice": ShoppingStatus.needsChoice, failed: ShoppingStatus.failed, "not-connected": ShoppingStatus.saved } as const satisfies Record<HelperResult["kind"], ShoppingStatus>;

/** PLT-10: the part of a child workflow's ID that tells two long steps of one job apart. */
export function longStepKey(step: LongStep): string {
  switch (step.tool) {
    case LongTool.shop:
      return `${step.requestId}:${step.sku ?? "item"}`;
  }
}

/**
 * PLT-10 / AUT-1: the `shop` tool's long step. The sealed helper (AUT-2) adds the item, the run's
 * timestamped log and screenshots are kept in object storage (AUT-6, PLT-7), and the AUT-3 question
 * and today's replan come back as effects for the job's shared path to apply.
 */
async function shop(rt: Runtime, step: Extract<LongStep, { tool: typeof LongTool.shop }>, person: string | null): Promise<LongStepResult> {
  const api = rt.system("shopping");
  const request = await api.shopping.get({ id: step.requestId });
  if (request === null) throw new Error(`no shopping request ${step.requestId}`);
  const result = step.sku === null ? await rt.ports.shopping.addItem(request.item) : await rt.ports.shopping.addProduct(step.sku);
  const keys: string[] = [];
  for (const [i, shot] of result.screenshots.entries()) {
    const key = `runs/${step.requestId}/${String(i).padStart(2, "0")}-${shot.name}.png`;
    await rt.ports.objects.put(key, shot.png, "image/png");
    keys.push(key);
  }
  const now = rt.ports.clock.now();
  const at = now.toISOString();
  const runId = await api.shopping.addRun({ requestId: step.requestId, log: result.log.map((line) => ({ at, line })), screenshots: keys });
  if (result.kind === "added") await api.shopping.recordAdd({ requestId: step.requestId, sku: result.product.sku, name: result.product.name });
  await api.shopping.update({
    id: step.requestId,
    status: STATUS[result.kind],
    chosen: result.kind === "added" ? result.product : null,
    options: result.kind === "needs-choice" ? result.options : [],
  });
  const effects = emptyEffects();
  const question = result.kind === "needs-choice" ? shoppingQuestion(request, result.options, person) : null;
  if (question !== null) effects.notify.push(question);
  // The home screen shows what was added, or the question (AUT-1).
  effects.replan.push(localDate(now, rt.timeZone));
  return { effects, report: { tool: LongTool.shop, key: longStepKey(step), outcome: result.kind, runId } };
}

/** Runs one tool's long step. Called inside a checkpointed step of the long-call child workflow. */
export async function runLongStep(rt: Runtime, step: LongStep, person: string | null): Promise<LongStepResult> {
  switch (step.tool) {
    case LongTool.shop:
      return shop(rt, step, person);
  }
}
