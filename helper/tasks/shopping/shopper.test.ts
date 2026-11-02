import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startSupermarket, type SupermarketState } from "../../../practice/supermarket/app.ts";
import type { TaskDeps } from "../../registry.ts";
import { createRedactor, createRunLog } from "../../secrets.ts";
import { isExactMatch } from "./match.ts";
import { Shopper } from "./shopper.ts";

let browser: Browser;
let state: SupermarketState;
let close: () => Promise<void>;
let shopper: Shopper;

/** HOU-168: a fresh login every run, as helper/testing.ts makes. */
const password = randomBytes(12).toString("base64url");

beforeAll(async () => {
  const sm = await startSupermarket({ port: 0, username: "u", password });
  state = sm.state;
  close = sm.close;
  browser = await chromium.launch();
  const redact = createRedactor([password]);
  const deps: TaskDeps = {
    credentials: { url: sm.url, username: "u", password },
    dataDir: mkdtempSync(path.join(tmpdir(), "shopper-")),
    browser: async () => browser,
    newLog: () => createRunLog(redact, () => {}),
    redact,
  };
  shopper = new Shopper(deps);
});
afterAll(async () => {
  await browser.close();
  await close();
});

describe("exact match rule", () => {
  test("[AUT-3] every significant word of the request must be in the product name", () => {
    expect(isExactMatch("bananas", "Bananas x5")).toBe(true);
    expect(isExactMatch("some eggs", "Free Range Eggs x6")).toBe(true);
    expect(isExactMatch("oat milk", "Oatly Oat Drink Barista 1L")).toBe(false);
    expect(isExactMatch("nappies", "Pampers Baby-Dry Size 4 x44")).toBe(false);
  });
});

describe("permissions are enforced in the browser, not by instructions", () => {
  test("[AUT-4] navigating to checkout from the helper's browser is blocked", async () => {
    const s = await shopper.openGuarded();
    try {
      await expect(s.page.goto(s.url("/checkout"))).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
      await expect(s.page.goto(s.url("/slots"))).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
      expect(s.blocked.length).toBe(2);
    } finally {
      await s.close();
    }
  });

  test("[AUT-4] placing an order by posting the checkout form is blocked", async () => {
    const s = await shopper.openGuarded();
    try {
      const status = await s.page.evaluate(async () => {
        try {
          return (await fetch("/checkout", { method: "POST" })).status;
        } catch {
          return -1;
        }
      });
      expect(status).toBe(-1);
      expect(state.orders).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("[AUT-4] removing something the helper did not add is blocked; removing its own is allowed", async () => {
    expect(state.basket.has("pasta")).toBe(true);
    const s = await shopper.openGuarded();
    try {
      await s.page.goto(s.url("/basket"));
      await s.page.locator('.basket-item[data-sku="pasta"] button.remove').click();
      await s.page.waitForTimeout(200);
      expect(state.basket.has("pasta")).toBe(true);
      expect(s.blocked.some((b) => b.includes("pasta"))).toBe(true);
    } finally {
      await s.close();
    }
    const added = await shopper.addItem("apples");
    expect(added.kind).toBe("added");
    const own = await shopper.openGuarded();
    try {
      await own.page.goto(own.url("/basket"));
      await Promise.all([own.page.waitForURL((u) => u.pathname === "/basket"), own.page.locator('.basket-item[data-sku="apples"] button.remove').click()]);
      expect(state.basket.has("apples")).toBe(false);
    } finally {
      await own.close();
    }
  });

  test("[AUT-4] after all of that, no order was ever placed and the slot never changed", () => {
    expect(state.orders).toEqual([]);
    expect(state.slotChanges).toEqual([]);
    expect(state.deliveryDate).toBe("2026-11-03");
  });
});
