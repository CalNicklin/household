import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { testHousehold, type TestHousehold } from "../testing/household.ts";

let h: TestHousehold;
beforeAll(async () => {
  h = await testHousehold();
});
afterAll(async () => h.close());

describe("a child workflow's usage lands on its job once", () => {
  test("[QA-8][QA-10] usage a child adds after the job finished adds its tokens and its cost, and a re-run of the same child adds nothing more", async () => {
    const a = await h.sayAndWait("what's on today?");
    const api = h.rt.system("t").jobs;
    const before = await api.job({ id: a.jobId });
    if (before === null) throw new Error("no job");
    const source = `${a.jobId}:shop:r1:item`;
    await api.addJobUsage({ id: a.jobId, source, inputTokens: 40, outputTokens: 10, costMicros: 1775 });
    // The same child's usage step re-running after a crash (DBOS steps are at-least-once).
    await api.addJobUsage({ id: a.jobId, source, inputTokens: 40, outputTokens: 10, costMicros: 1775 });
    // A different child of the same job is counted too.
    await api.addJobUsage({ id: a.jobId, source: `${a.jobId}:shop:r2:item`, inputTokens: 1, outputTokens: 2, costMicros: 3 });
    expect(await api.job({ id: a.jobId })).toMatchObject({
      inputTokens: before.inputTokens + 41,
      outputTokens: before.outputTokens + 12,
      costMicros: before.costMicros + 1778,
      status: before.status,
      intent: before.intent,
    });
  });

  test("[QA-8][PRV-5] usage for a job that was purged with its message adds nothing and does not fail the child", async () => {
    await expect(h.rt.system("t").jobs.addJobUsage({ id: "job-purged", source: "job-purged:shop:r1:item", inputTokens: 40, outputTokens: 10, costMicros: 0 })).resolves.toBeUndefined();
  });
});
