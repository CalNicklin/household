import { ActionKind, ShoppingStatus } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { NoShoppingHelper } from "../integrations/shopping-helper.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { localDate } from "../time.ts";
import { runLongStep } from "./long-steps.ts";
import { respond } from "./respond.ts";
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
  test("[HOME-4][PRO-9][PRV-1] a tap dismisses a saved request everywhere and replans today; only a request that went nowhere can be, and only for a person", async () => {
    const { scope } = await shop(["saffron"]);
    const id = scope.effects.long[0]?.requestId ?? "";
    await expect(h.rt.system("t").shopping.dismiss({ id })).rejects.toThrow(/person/);
    const tap = jobScope(h.rt, "job-dismiss", "msg-dismiss", "tom", "app");
    expect(await respond(tap, `shopping:${id}`, ActionKind.notToday, null)).toBe("Okay, dismissed.");
    expect(tap.effects.replan).toEqual([localDate(h.ports.clock.now(), h.rt.timeZone)]);
    expect(tap.effects.closeRefs).toEqual([{ ref: `shopping:${id}`, status: "dismissed" }]);
    expect((await h.rt.system("t").shopping.recent()).map((r) => r.id)).not.toContain(id);
    expect((await h.rt.system("t").shopping.get({ id }))?.status).toBe(ShoppingStatus.dismissed);
    expect((await h.rt.system("t").learning.events()).some((e) => e.ref === `shopping:${id}` && e.subject === "saffron")).toBe(true);
    const queued = await scope.api.shopping.request({ item: "pasta", sourceMessage: "msg-queued:pasta" });
    await expect(tap.api.shopping.dismiss({ id: queued.id })).rejects.toThrow(/went nowhere/);
    expect((await h.rt.system("t").shopping.get({ id: queued.id }))?.status).toBe(ShoppingStatus.queued);
  });

  test("[HOME-4][PRO-9] a second tap on a dismissed request says so and records nothing more; 'not today' on a request still in play is an ordinary not today", async () => {
    const { scope } = await shop(["sumac"]);
    const id = scope.effects.long[0]?.requestId ?? "";
    expect(await respond(jobScope(h.rt, "job-tap-1", "msg-tap-1", "tom", "app"), `shopping:${id}`, ActionKind.notToday, null)).toBe("Okay, dismissed.");
    const events = (await h.rt.system("t").learning.events()).length;
    const second = jobScope(h.rt, "job-tap-2", "msg-tap-2", "tom", "app");
    expect(await respond(second, `shopping:${id}`, ActionKind.notToday, null)).toBe("That's already dismissed.");
    expect((await h.rt.system("t").learning.events()).length).toBe(events);
    expect(second.effects.closeRefs).toEqual([]);
    const queued = await scope.api.shopping.request({ item: "rice", sourceMessage: "msg-still:rice" });
    expect(await respond(jobScope(h.rt, "job-tap-3", "msg-tap-3", "tom", "app"), `shopping:${queued.id}`, ActionKind.notToday, null)).toBe("Okay, not today.");
    expect((await h.rt.system("t").shopping.get({ id: queued.id }))?.status).toBe(ShoppingStatus.queued);
  });
});
