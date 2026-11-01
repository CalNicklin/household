import { ActionKind, LongTool, ShoppingStatus, Urgency } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { shoppingQuestion } from "../rules/shopping.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { localDate } from "../time.ts";
import { longStepKey, runLongStep } from "./long-steps.ts";
import { jobScope } from "./scope.ts";

let h: TestHousehold;
beforeAll(async () => {
  h = await testHousehold({ jobs: false });
});
afterAll(async () => h.close());

async function request(item: string): Promise<string> {
  const scope = jobScope(h.rt, `job-long-${item}`, `msg-long-${item}`, "priya", "app");
  return (await scope.api.shopping.request({ item, sourceMessage: `msg-long-${item}:${item}` })).id;
}

describe("AUT-3 is plain code: no exact match asks one question, never the model", () => {
  test("[AUT-3] no exact match is one urgent question to the person who asked, one tap per option, sent once", () => {
    const options = [
      { sku: "oat-1l", name: "Oat drink 1L", price: "£1.80" },
      { sku: "oat-semi-1l", name: "Oat drink semi 1L", price: "£1.90" },
    ];
    expect(shoppingQuestion({ id: "r1", item: "oat milk" }, options, "priya")).toEqual({
      person: "priya",
      message: 'No exact match for "oat milk". Which one?',
      urgency: Urgency.urgent,
      actions: [
        { kind: ActionKind.answer, label: "Oat drink 1L", ref: "shopping:r1", value: "oat-1l" },
        { kind: ActionKind.answer, label: "Oat drink semi 1L", ref: "shopping:r1", value: "oat-semi-1l" },
      ],
      key: "shopping:r1:question",
      countsTowardsBudget: true,
    });
    expect(shoppingQuestion({ id: "r1", item: "oat milk" }, options, null)).toBeNull();
  });
});

describe("PLT-10: the shop tool's long step returns ordinary effects for the job's shared path", () => {
  test("[AUT-3][AUT-6] no exact match: the step adds nothing, keeps its timestamped log, and returns the one question and today's replan as effects", async () => {
    const id = await request("oatly");
    const before = (await h.ports.shopping.basket()).items;
    const { effects, report } = await runLongStep(h.rt, { tool: LongTool.shop, requestId: id, sku: null }, "priya");
    expect((await h.ports.shopping.basket()).items).toEqual(before);
    expect((await h.rt.system("t").shopping.get({ id }))?.status).toBe(ShoppingStatus.needsChoice);
    expect(effects.notify).toHaveLength(1);
    expect(effects.notify[0]?.actions.map((a) => a.value).sort()).toEqual(["oat-1l", "oat-semi-1l"]);
    expect(effects.replan).toEqual([localDate(h.ports.clock.now(), h.rt.timeZone)]);
    expect(effects.long).toEqual([]);
    expect(report).toMatchObject({ tool: LongTool.shop, key: `${id}:item`, outcome: "needs-choice" });
    const run = await h.rt.system("t").shopping.run({ id: report.runId ?? "" });
    expect(run?.log[0]).toMatchObject({ at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), line: expect.stringContaining("oatly") });
  });

  test("[AUT-1] an exact match is added and asks nothing; answering the question adds the chosen product", async () => {
    const id = await request("bananas");
    const added = await runLongStep(h.rt, { tool: LongTool.shop, requestId: id, sku: null }, "priya");
    expect(added.report.outcome).toBe("added");
    expect(added.effects.notify).toEqual([]);
    const oatly = await request("oatly");
    const answered = await runLongStep(h.rt, { tool: LongTool.shop, requestId: oatly, sku: "oat-semi-1l" }, "priya");
    expect(answered.report.key).toBe(`${oatly}:oat-semi-1l`);
    expect((await h.rt.system("t").shopping.get({ id: oatly }))?.chosen?.sku).toBe("oat-semi-1l");
  });

  test("[PLT-10] each long step of a job has its own child workflow key", () => {
    expect(longStepKey({ tool: LongTool.shop, requestId: "r1", sku: null })).toBe("r1:item");
    expect(longStepKey({ tool: LongTool.shop, requestId: "r1", sku: "oat-1l" })).toBe("r1:oat-1l");
  });
});
