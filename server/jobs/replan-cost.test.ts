import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PracticeShoppingHelper } from "../../practice/fakes.ts";
import type { HelperResult, ShoppingHelper } from "../ports.ts";
import { eventually, testHousehold, type TestHousehold } from "../testing/household.ts";

/** The practice helper, held at the start of each add until the test lets it go. */
class HeldShoppingHelper implements ShoppingHelper {
  readonly connected = true;
  readonly #inner = new PracticeShoppingHelper();
  #release: (() => void) | null = null;
  #held = new Promise<void>((resolve) => {
    this.#release = resolve;
  });
  release(): void {
    this.#release?.();
  }
  async addItem(item: string): Promise<HelperResult> {
    await this.#held;
    return this.#inner.addItem(item);
  }
  async addProduct(sku: string): Promise<HelperResult> {
    await this.#held;
    return this.#inner.addProduct(sku);
  }
  basket(): ReturnType<ShoppingHelper["basket"]> {
    return this.#inner.basket();
  }
}

const helper = new HeldShoppingHelper();
let h: TestHousehold;
beforeAll(async () => {
  h = await testHousehold({ ports: { shopping: helper } });
});
afterAll(async () => h.close());

describe("a shopping run's replan is counted on the job that asked for it", () => {
  test("[QA-10][QA-8] the replan after a shopping run adds its tokens and cost to the job's totals, after the job has recorded its own", async () => {
    // The job finishes while its shopping run is still held at the helper (PLT-10: it never waits).
    const a = await h.sayAndWait("we're out of apples");
    const before = await h.rt.system("t").jobs.job({ id: a.jobId });
    if (before === null) throw new Error("no job");
    helper.release();
    // The run adds an item, re-plans today (one practice-model call: 40 in, 10 out), then reports back.
    await eventually(async () => ((await h.rt.system("t").jobs.job({ id: a.jobId }))?.inputTokens ?? 0) > before.inputTokens);
    const after = await h.rt.system("t").jobs.job({ id: a.jobId });
    expect(after).toMatchObject({ inputTokens: before.inputTokens + 40, outputTokens: before.outputTokens + 10, costMicros: before.costMicros, status: before.status, intent: before.intent });
  });
});
