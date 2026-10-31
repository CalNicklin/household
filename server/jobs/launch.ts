import { DBOS } from "@dbos-inc/dbos-sdk";
import { databaseUrl } from "../db/index.ts";
import type { Runtime } from "../runtime.ts";
import { setJobRuntime } from "./context.ts";
import "./handle-message.ts";

/** PLT-2: jobs are DBOS workflows checkpointed in Postgres; a restarted worker resumes from the last step. */
export async function launchJobs(rt: Runtime): Promise<void> {
  setJobRuntime(rt);
  DBOS.setConfig({ name: `household-${rt.env.HOUSEHOLD_ID}`, systemDatabaseUrl: databaseUrl(rt.env.DATABASE_URL, `${rt.env.DB_PREFIX}_dbos`), logLevel: "warn" });
  await DBOS.launch();
}

export async function stopJobs(): Promise<void> {
  await DBOS.shutdown();
  setJobRuntime(null);
}

/** PLT-2: a job's full history by its ID — DBOS's checkpointed steps plus our job row. */
export async function jobSteps(jobId: string) {
  return (await DBOS.listWorkflowSteps(jobId)) ?? [];
}

export async function waitForJob(jobId: string): Promise<void> {
  await DBOS.retrieveWorkflow(jobId).getResult();
}
