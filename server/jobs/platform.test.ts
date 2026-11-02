import { DBOS } from "@dbos-inc/dbos-sdk";
import { ActorKind, TimerKind } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { resetPractice } from "../../practice/seed.ts";
import { jobScope } from "../agent/scope.ts";
import { houseTools } from "../agent/tools.ts";
import { acceptTimer } from "../coordinator/accept.ts";
import { loadEnv } from "../env.ts";
import { eventually, testHousehold, type TestHousehold } from "../testing/household.ts";
import { atLocal } from "../time.ts";
import { traceView } from "../views/runs.ts";
import { launchJobs, stopJobs, waitForJob } from "./launch.ts";

let h: TestHousehold;
let stepOneRuns = 0;
const gate: { release: (() => void) | null } = { release: null };
const crashy = DBOS.registerWorkflow(
  async () => {
    await DBOS.runStep(async () => {
      stepOneRuns += 1;
    }, { name: "one" });
    await DBOS.runStep(() => new Promise<void>((resolve) => (gate.release = resolve)), { name: "two" });
    return "done";
  },
  { name: "crashyTestWorkflow" },
);

beforeAll(async () => {
  h = await testHousehold();
});
afterAll(async () => h.close());

describe("Platform", () => {
  test("[PLT-2] a job is a DBOS workflow: a worker that stops mid-job resumes from the last completed step", async () => {
    await DBOS.startWorkflow(crashy, { workflowID: "crash-1" })();
    await eventually(() => gate.release !== null);
    // The worker goes away mid-step two…
    await stopJobs();
    gate.release = null;
    // …and a new one picks the job up without repeating step one.
    await launchJobs(h.rt);
    await eventually(() => gate.release !== null);
    const resume: (() => void) | null = Reflect.get(gate, "release");
    resume?.();
    expect(await DBOS.retrieveWorkflow("crash-1").getResult()).toBe("done");
    expect(stepOneRuns).toBe(1);
  });

  test("[PLT-5] one agent with tools for the house database, calendar, lists app, weather and daylight, parcels and messages", () => {
    const scope = jobScope(h.rt, "j", "m", "priya", "app");
    expect(Object.keys(houseTools(scope)).sort()).toEqual(["add_to_list", "capture", "hand_over", "move_to_tomorrow", "record_arrival", "remind", "respond", "set_mode", "shop", "sitter_booked", "today", "what_now"]);
  });

  test("[PLT-10][QA-8] long tool calls are child workflows; a job's trace (steps, tool calls, tokens, cost, time) is in one place, and monthly spend is on a page", async () => {
    const a = await h.sayAndWait("we're out of apples");
    const trace = await traceView(h.rt, a.jobId);
    expect(trace?.steps.some((s) => s.childWorkflowId?.includes(":shop:") ?? false)).toBe(true);
    expect(trace?.job.toolCalls.map((c) => c.tool)).toContain("shop");
    expect(trace?.job.durationMs).toBeGreaterThan(0);
    expect(trace?.job).toHaveProperty("costMicros");
    const spend = await h.rt.as({ kind: ActorKind.person, person: "priya" }).jobs.spendByMonth();
    expect(spend[0]?.jobs).toBeGreaterThan(0);
  });

  test("[QA-10] once a week one message: what it suggested, what we accepted and dismissed, and what it cost", async () => {
    const a = await acceptTimer(h.rt, TimerKind.weekly, atLocal("2026-11-08", 18, 0, "Europe/London"));
    await waitForJob(a.jobId);
    const weekly = h.ports.messenger.sent.filter((m) => m.text.startsWith("This week I suggested"));
    expect(weekly.map((m) => m.address).sort()).toEqual(["1001", "1002"]);
    expect(weekly[0]?.text).toMatch(/^This week I suggested \d+ things\. You accepted \d+ and dismissed \d+\. It cost \$\d+\.\d\d\.$/);
  });

  test("[FB-6] seeding the practice household is one command and takes under ten seconds", async () => {
    const env = loadEnv({ DATABASE_URL: inject("databaseUrl"), DB_PREFIX: `seed${inject("runId")}` });
    const t0 = Date.now();
    await resetPractice(env);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const { dropDatabases } = await import("../db/index.ts");
    await dropDatabases(env.DATABASE_URL, env.DB_PREFIX);
  });
});
