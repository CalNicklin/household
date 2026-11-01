import { DBOS } from "@dbos-inc/dbos-sdk";
import type { JobTrace, RunView } from "@household/contracts";
import type { Runtime } from "../runtime.ts";

/** AUT-6: a shopping run's log and screenshots, openable from the message that started it. */
export async function runView(rt: Runtime, id: string): Promise<RunView | null> {
  const api = rt.system("views");
  const run = await api.shopping.run({ id });
  if (run === null) return null;
  const request = await api.shopping.get({ id: run.requestId });
  return {
    id: run.id,
    item: request?.item ?? "",
    status: request?.status ?? "",
    chosen: request?.chosen ?? null,
    log: run.log,
    screenshots: run.screenshots.map((key) => ({ name: key.split("/").at(-1) ?? key, url: `/api/objects/${encodeURIComponent(key)}` })),
  };
}

/** PLT-2 / QA-8: one place for a job's events, steps, tool calls, tokens, cost and time taken. */
export async function traceView(rt: Runtime, id: string): Promise<JobTrace | null> {
  const job = await rt.system("views").jobs.job({ id });
  if (job === null) return null;
  const steps = (await DBOS.listWorkflowSteps(id)) ?? [];
  return {
    job,
    steps: steps.map((s) => ({
      name: s.name,
      startedAt: s.startedAtEpochMs === undefined ? null : new Date(s.startedAtEpochMs).toISOString(),
      completedAt: s.completedAtEpochMs === undefined ? null : new Date(s.completedAtEpochMs).toISOString(),
      error: s.error === null || s.error === undefined ? null : String(s.error),
      childWorkflowId: s.childWorkflowID ?? null,
    })),
  };
}
