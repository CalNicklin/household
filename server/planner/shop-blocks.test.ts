import { ActionKind, type Block, BlockType, ShoppingStatus, type SuggestionBlock } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { NoShoppingHelper } from "../integrations/shopping-helper.ts";
import { eventually, testHousehold, type TestHousehold } from "../testing/household.ts";
import { localDate } from "../time.ts";
import { shoppingForPlan } from "./compose.ts";
import { gatherFacts, oneThingCandidates } from "./gather.ts";

const shopBlocks = (blocks: readonly Block[]) => blocks.filter((b) => "ref" in b && b.ref.startsWith("shopping:"));
const shopSuggestions = (blocks: readonly Block[]) => blocks.filter((b): b is SuggestionBlock => b.type === BlockType.suggestion && b.ref.startsWith("shopping:"));

describe("HOU-157: with no shopping helper connected, a shop request makes no home block", () => {
  let h: TestHousehold;
  beforeAll(async () => {
    h = await testHousehold({ ports: { shopping: new NoShoppingHelper() } });
  });
  afterAll(async () => h.close());

  test("[HOME-4][AUT-1] a new request is saved, an older one that says failed is too, and neither makes a block on today's plan", async () => {
    const date = localDate(h.ports.clock.now(), h.rt.timeZone);
    await h.sayAndWait("we're out of saffron");
    const api = h.rt.system("t");
    await eventually(async () => (await api.shopping.recent()).some((r) => r.item === "saffron" && r.status === ShoppingStatus.saved));
    // A request from before HOU-148, when the missing helper made it "failed" (Cal's printer rows).
    const tap = h.rt.as({ kind: "agent", job: "job-legacy", onBehalfOf: "priya", message: "msg-legacy" });
    const legacy = await tap.shopping.request({ item: "the canon printer working", sourceMessage: "msg-legacy:printer" });
    await api.shopping.update({ id: legacy.id, status: ShoppingStatus.failed, chosen: null, options: [] });
    await h.sayAndWait("slow day");
    const plan = await api.plans.latest({ date });
    expect(plan).not.toBeNull();
    expect(shopBlocks(plan?.blocks ?? [])).toEqual([]);
    expect(JSON.stringify(plan?.blocks)).not.toMatch(/Couldn't find|saffron|canon printer/);
  });
});

describe("HOU-157: a shop block that does show (a helper is connected) has a one-tap dismiss", () => {
  let h: TestHousehold;
  beforeAll(async () => {
    h = await testHousehold();
  });
  afterAll(async () => h.close());

  test("[HOME-4][PRO-9] 'Couldn't find' and 'Added to the shop' each carry Dismiss; tapping it closes the block and dismisses the request", async () => {
    const date = localDate(h.ports.clock.now(), h.rt.timeZone);
    const api = h.rt.system("t");
    await h.sayAndWait("we're out of dragonfruit");
    await h.sayAndWait("we're out of bananas");
    const blocks = async () => shopSuggestions((await api.plans.latest({ date }))?.blocks ?? []);
    await eventually(async () => (await blocks()).length === 2);
    const failed = (await blocks()).find((b) => b.title === "Couldn't find dragonfruit");
    const added = (await blocks()).find((b) => b.title.startsWith("Added to the shop: Bananas"));
    for (const b of [failed, added]) expect(b?.actions).toEqual([{ kind: ActionKind.notToday, label: "Dismiss", ref: b?.ref }]);
    const ref = failed?.ref ?? "";
    await h.wait(await h.tap(ref, ActionKind.notToday));
    expect((await api.shopping.get({ id: ref.slice("shopping:".length) }))?.status).toBe(ShoppingStatus.dismissed);
    expect((await api.plans.responsesOn({ date })).some((r) => r.ref === ref && r.action === ActionKind.notToday)).toBe(true);
    await eventually(async () => !(await blocks()).some((b) => b.ref === ref));
  });

  test("[MOM-2][HOME-4] a shop card is never the one thing to do now, and dismissing 'Added to the shop' closes it with nothing learned or remembered", async () => {
    const date = localDate(h.ports.clock.now(), h.rt.timeZone);
    const api = h.rt.system("t");
    const added = async () => shopSuggestions((await api.plans.latest({ date }))?.blocks ?? []).find((b) => b.title.startsWith("Added to the shop: Bananas"));
    await eventually(async () => (await added()) !== undefined);
    const facts = await gatherFacts(h.rt, date, 2);
    const candidates = await oneThingCandidates(h.rt, facts, date, h.ports.clock.now(), new Set(), "priya");
    expect(candidates.filter((c) => c.ref.startsWith("shopping:"))).toEqual([]);
    const ref = (await added())?.ref ?? "";
    const events = (await api.learning.events()).length;
    const accepted = await h.tap(ref, ActionKind.notToday);
    await h.wait(accepted);
    expect((await api.learning.events()).length).toBe(events);
    expect((await api.jobs.replies({ person: "priya" })).some((r) => r.text === "Okay, dismissed.")).toBe(true);
    await eventually(async () => (await added()) === undefined || (await api.plans.responsesOn({ date })).some((r) => r.ref === ref));
  });

  test("[HOME-4] shoppingForPlan keeps every request with a helper and none without", () => {
    const r = { id: "r", item: "x", person: "priya", status: ShoppingStatus.failed, chosen: null, options: [], runId: null, createdAt: "2026-11-02T07:00:00.000Z" };
    expect(shoppingForPlan([r], true)).toEqual([r]);
    expect(shoppingForPlan([r], false)).toEqual([]);
  });
});
