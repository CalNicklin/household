import { TimerKind } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestHousehold } from "../../testing/household.ts";
import { householdWithApp, jobForKey, storedShape } from "../../testing/http.ts";
import { recordMissed } from "./index.ts";
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
});
