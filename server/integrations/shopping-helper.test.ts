import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type HelperFixture, startHelperFixture, TEST_PASSWORD, TEST_TOKEN, TEST_USERNAME } from "../../helper/testing.ts";
import { HttpShoppingHelper } from "./shopping-helper.ts";

let fx: HelperFixture;
let helper: HttpShoppingHelper;

beforeAll(async () => {
  fx = await startHelperFixture();
  helper = new HttpShoppingHelper(fx.helperUrl, TEST_TOKEN);
});
afterAll(async () => fx.close());

describe("shopping helper over HTTP, against the practice supermarket", () => {
  test("[AUT-1][AUT-3] 'bananas' has exactly one match, so it is added and the product is named", async () => {
    const result = await helper.addItem("bananas");
    expect(result).toMatchObject({ kind: "added", product: { sku: "bananas", name: "Bananas x5", price: "£0.95" } });
    expect(fx.state.basket.get("bananas")).toBe(2);
  });

  test("[AUT-3] 'oat milk' has two close matches and no exact one: nothing is added, two options are offered", async () => {
    const before = new Map(fx.state.basket);
    const result = await helper.addItem("oat milk");
    const options = result.kind === "needs-choice" ? result.options : [];
    expect(result.kind).toBe("needs-choice");
    expect(options.map((o) => o.sku).sort()).toEqual(["oat-1l", "oat-semi-1l"]);
    expect(fx.state.basket).toEqual(before);
  });

  test("[AUT-3] 'nappies' asks which size, with two or three options", async () => {
    const result = await helper.addItem("nappies");
    const options = result.kind === "needs-choice" ? result.options : [];
    expect(result.kind).toBe("needs-choice");
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.length).toBeLessThanOrEqual(3);
    expect(options.map((o) => o.sku).sort()).toEqual(["nappies-4", "nappies-5"]);
  });

  test("[AUT-3] answering the question adds that product and remembers it for next time", async () => {
    await helper.addItem("oat milk");
    const chosen = await helper.addProduct("oat-1l");
    expect(chosen.kind).toBe("added");
    const again = await helper.addItem("oat milk");
    expect(again).toMatchObject({ kind: "added", product: { sku: "oat-1l" } });
  });

  test("[AUT-3] 'unicorn steaks' finds nothing and adds nothing", async () => {
    const result = await helper.addItem("unicorn steaks");
    expect(result.kind).toBe("failed");
  });

  test("[AUT-6] every run returns a timestamped log and screenshots of each step", async () => {
    const result = await helper.addItem("cheddar");
    expect(result.kind).toBe("added");
    expect(result.log.every((l) => /^\d{4}-\d{2}-\d{2}T/.test(l))).toBe(true);
    expect(result.screenshots.map((s) => s.name)).toEqual(["search-results", "product", "basket"]);
    for (const shot of result.screenshots) expect(Array.from(shot.png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("[AUT-5] the basket can be read back with its delivery date and a link to change it", async () => {
    const basket = await helper.basket();
    expect(basket.deliveryDate).toBe("2026-11-03");
    expect(basket.items.map((i) => i.sku)).toContain("bananas");
    expect(basket.changeUrl).toBe(`${fx.supermarketUrl}/basket`);
  });

  test("[AUT-4] no run ever checks out or changes the delivery slot", () => {
    expect(fx.state.orders).toEqual([]);
    expect(fx.state.slotChanges).toEqual([]);
  });

  test("[AUT-2] the supermarket login never appears in a log line or an API response", async () => {
    const res = await fetch(`${fx.helperUrl}/tasks/shopping/add-item`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ item: "eggs" }),
    });
    const body = await res.text();
    for (const secret of [TEST_PASSWORD, TEST_USERNAME]) {
      expect(body).not.toContain(secret);
      expect(fx.logs.join("")).not.toContain(secret);
    }
    expect(fx.logs.join("")).toContain("signed in to the supermarket");
  });

  test("[AUT-2] without the helper token nothing answers", async () => {
    const res = await fetch(`${fx.helperUrl}/tasks/shopping/basket`);
    expect(res.status).toBe(401);
    const wrong = await fetch(`${fx.helperUrl}/tasks/shopping/basket`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });
});
