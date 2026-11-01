import { ActorKind, ShoppingStatus } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { NoShoppingHelper } from "../integrations/shopping-helper.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { runLongStep } from "./long-steps.ts";
import { jobScope } from "./scope.ts";
import { houseTools } from "./tools.ts";

let h: TestHousehold;
beforeAll(async () => {
  h = await testHousehold({ jobs: false, ports: { shopping: new NoShoppingHelper() } });
});
afterAll(async () => h.close());

async function shop(items: string[]) {
  const scope = jobScope(h.rt, `job-saved-${items.join("-")}`, `msg-saved-${items.join("-")}`, "tom", "telegram");
  const execute = houseTools(scope).shop.execute;
  if (execute === undefined) throw new Error("shop has no execute");
  const output = await execute({ items }, {});
  for (const step of scope.effects.long) await runLongStep(h.rt, step, "tom");
  return { output, scope };
}

describe("HOU-148: with no shopping helper connected, a shop request is saved, never 'couldn't find it'", () => {
  test("[AUT-1] the shop tool says the request is saved for when shopping is connected, and the request is kept as saved", async () => {
    const { output, scope } = await shop(["oat milk", "bread"]);
    expect(output).toMatchObject({ added: false, saved: true, say: "Saved oat milk and bread for when shopping is connected." });
    expect(JSON.stringify(output)).not.toMatch(/couldn't find|next shop/i);
    for (const step of scope.effects.long) expect((await h.rt.system("t").shopping.get({ id: step.requestId }))?.status).toBe(ShoppingStatus.saved);
  });
});

describe("HOU-148: a person dismisses a shopping request that went nowhere; it is kept, not deleted", () => {
  test("[HOME-4][PRV-1] the person dismisses a saved request and it leaves the Shop list; the agent cannot, and nothing else can be dismissed", async () => {
    const { scope } = await shop(["saffron"]);
    const id = scope.effects.long[0]?.requestId ?? "";
    const agent = h.rt.as({ kind: ActorKind.agent, job: "job-x", onBehalfOf: "tom", message: "msg-x" });
    await expect(agent.shopping.dismiss({ id })).rejects.toThrow(/person/);
    const cal = h.rt.as({ kind: ActorKind.person, person: "tom" });
    expect((await cal.shopping.dismiss({ id })).status).toBe(ShoppingStatus.dismissed);
    expect((await h.rt.system("t").shopping.recent()).map((r) => r.id)).not.toContain(id);
    expect((await h.rt.system("t").shopping.get({ id }))?.status).toBe(ShoppingStatus.dismissed);
    const queued = await scope.api.shopping.request({ item: "pasta", sourceMessage: "msg-queued:pasta" });
    await expect(cal.shopping.dismiss({ id: queued.id })).rejects.toThrow(/went nowhere/);
  });
});
