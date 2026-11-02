import { JobStatus, TimerKind } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { acceptTimer } from "../coordinator/accept.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { atLocal } from "../time.ts";
import { waitForJob } from "./launch.ts";

let h: TestHousehold;
beforeAll(async () => {
  h = await testHousehold();
});
afterAll(async () => h.close());

describe("two jobs planning the same day at once (HOU-162)", () => {
  test("[PLT-4] concurrent saves of one date all land, as consecutive versions, and none fails on plans_date_version", async () => {
    const api = h.rt.system("t");
    const date = "2026-12-01";
    const saves = Array.from({ length: 12 }, (_, i) => api.plans.save({ date, blocks: [], inputs: { i }, trigger: `race:${i}`, jobId: null }));
    const results = await Promise.allSettled(saves);
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const versions = (await api.plans.versions({ date })).map((v) => v.version);
    expect(versions).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  test("[PLT-4][HOME-11] the catch-up plan and the hourly refresh planning today at the same moment both succeed, each as its own version", async () => {
    const date = "2026-11-03";
    const at = atLocal(date, 9, 0, "Europe/London");
    const [catchUp, refresh] = await Promise.all([acceptTimer(h.rt, TimerKind.catchUpPlan, at), acceptTimer(h.rt, TimerKind.hourlyRefresh, at)]);
    await Promise.all([waitForJob(catchUp.jobId), waitForJob(refresh.jobId)]);
    const api = h.rt.system("t");
    for (const a of [catchUp, refresh]) expect((await api.jobs.job({ id: a.jobId }))?.status).toBe(JobStatus.succeeded);
    const plans = await api.plans.versions({ date });
    expect(plans.map((p) => p.trigger).sort()).toEqual([`timer:${TimerKind.catchUpPlan}`, `timer:${TimerKind.hourlyRefresh}`]);
    expect(plans.map((p) => p.version)).toEqual([1, 2]);
  });
});
