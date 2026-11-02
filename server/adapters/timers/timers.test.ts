import { TimerKind } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestHousehold } from "../../testing/household.ts";
import { householdWithApp, jobForKey, storedShape } from "../../testing/http.ts";
import { atLocal } from "../../time.ts";
import { waitForJob } from "../../jobs/launch.ts";
import { recordMissed, runMissedMorningPlan } from "./index.ts";
import { acceptTimer } from "../../coordinator/accept.ts";

let h: TestHousehold;

beforeAll(async () => {
  ({ h } = await householdWithApp());
});
afterAll(async () => h.close());

describe("timers adapter", () => {
  test("[CH-2][CH-1][CH-5] a timer is a message: it lands as one job on the queue like any other", async () => {
    const at = new Date("2026-11-02T08:00:00.000Z");
    const accepted = await acceptTimer(h.rt, TimerKind.hourlyRefresh, at);
    const { messageId, job } = await jobForKey(h.rt, `timer:${TimerKind.hourlyRefresh}:${at.toISOString()}`);
    expect(job.id).toBe(accepted.jobId);
    expect(job.status).toBe("succeeded");
    const shape = await storedShape(h.rt, messageId);
    expect(shape).toMatchObject({ person: null, channel: "timer", attachments: [{ kind: "timer", timer: "hourly-refresh" }] });
    const again = await acceptTimer(h.rt, TimerKind.hourlyRefresh, at);
    expect(again.duplicate).toBe(true);
  });

  test("[CH-5] a timer that should have fired but did not shows in the run log", async () => {
    const api = h.rt.system("test");
    await api.jobs.recordTimer({ timer: TimerKind.morningPlan, scheduledFor: "2026-11-01T05:30:00.000Z", missed: false });
    const missed = await recordMissed(h.rt, new Date("2026-11-02T07:00:00.000Z"));
    expect(missed).toBeGreaterThanOrEqual(1);
    const runs = await api.jobs.timerRuns();
    expect(runs).toContainEqual(expect.objectContaining({ timer: TimerKind.morningPlan, scheduledFor: "2026-11-02T05:30:00.000Z", missed: true }));
  });

  test("[CH-5] HOU-170: a morning plan the server was down for runs late on start, once, and the run log still says it was missed", async () => {
    const at = atLocal("2026-11-03", 5, 30, "Europe/London").toISOString();
    await h.rt.system("test").jobs.recordTimer({ timer: TimerKind.morningPlan, scheduledFor: at, missed: true });
    const jobId = await runMissedMorningPlan(h.rt, atLocal("2026-11-03", 9, 15, "Europe/London"));
    expect(jobId).not.toBeNull();
    await waitForJob(jobId ?? "");
    expect((await h.rt.system("test").jobs.job({ id: jobId ?? "" }))?.status).toBe("succeeded");
    const run = (await h.rt.system("test").jobs.timerRuns()).find((r) => r.timer === TimerKind.morningPlan && r.scheduledFor === at);
    expect(run?.missed).toBe(true);
    expect(run?.firedAt).not.toBeNull();
    expect(await runMissedMorningPlan(h.rt, atLocal("2026-11-03", 9, 20, "Europe/London"))).toBeNull();
  });
});
