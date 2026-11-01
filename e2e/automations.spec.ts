import { Limits } from "@household/contracts";
import type { APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { evidence, expect, json, login, phone, reset, say, test, timer } from "./fixtures.ts";

test.beforeEach(async ({ request }) => reset(request));

const shopState = async (request: APIRequestContext) =>
  json(z.object({ orders: z.array(z.unknown()), slotChanges: z.array(z.unknown()).optional() }).passthrough(), await request.get("http://localhost:3102/practice-api/basket"));

test("[AUT-1][AUT-6] mention a shopping item and it goes in the basket; the home screen shows the product, and the run's log and screenshots open from it", async ({ page }) => {
  await login(page);
  await say(page, "we're out of bananas");
  // limit: shoppingBudgetMs
  await expect(page.getByText("Added to the shop: Bananas x5")).toBeVisible({ timeout: Limits.shoppingBudgetMs.value });
  await evidence(page, "AUT-1-added");
  await page.goto("/shop");
  await page.getByRole("link", { name: "See what it did" }).first().click();
  await expect(page.getByText(/added Bananas x5|Bananas x5/).first()).toBeVisible();
  const images = page.getByRole("img");
  await expect(images.first()).toBeVisible();
  expect(await images.first().evaluate((img) => (img instanceof HTMLImageElement ? img.naturalWidth : 0))).toBeGreaterThan(0);
  // AUT-2: the helper's login (generated for this run by e2e/stack.ts) never reaches the page.
  const { password } = z.object({ password: z.string() }).parse(JSON.parse(readFileSync(".data/e2e/supermarket.json", "utf8")));
  await expect(page.getByText(password)).toHaveCount(0);
  expect(await page.content()).not.toContain(password);
  await evidence(page, "AUT-6-run-log");
});

test("[AUT-3][AUT-4] no exact match: nothing is added and it asks one question with options to tap; it can never check out or change the slot", async ({ page, request }) => {
  await login(page);
  const before = await shopState(request);
  await say(page, "we need some oat milk");
  // limit: shoppingBudgetMs
  await expect(page.getByText("Which oat milk?")).toBeVisible({ timeout: Limits.shoppingBudgetMs.value });
  const options = page.getByRole("button", { name: /Oatly/ });
  expect(await options.count()).toBeGreaterThanOrEqual(2);
  expect(await options.count()).toBeLessThanOrEqual(3);
  expect((await phone(request, "1001")).some((m) => m.text.includes('No exact match for "oat milk"'))).toBe(true);
  await evidence(page, "AUT-3-question");
  await options.first().click();
  // limit: shoppingBudgetMs
  await expect(page.getByText(/Added to the shop: Oatly/)).toBeVisible({ timeout: Limits.shoppingBudgetMs.value });
  const after = await shopState(request);
  expect(after.orders).toHaveLength(before.orders.length);
  expect(after.slotChanges ?? []).toHaveLength((before.slotChanges ?? []).length);
});

test("[AUT-2][AUT-7] the shopping helper runs sealed, with its own login; a second helper is just another folder", async ({ request }) => {
  const tasks = await request.get("http://localhost:3103/tasks", { headers: { Authorization: "Bearer e2e-helper-token" } });
  expect(tasks.ok()).toBe(true);
  expect(JSON.stringify(await tasks.json())).toContain("shopping");
  expect((await request.get("http://localhost:3103/tasks")).status()).toBe(401);
  const env = await request.get("/api/practice/now");
  expect(await env.text()).not.toContain("practice-shopper");
});

test("[AUT-5] the day before delivery, a summary of the basket and what was added since you last looked, with a link to change it", async ({ request }) => {
  await timer(request, "basket-summary", "2026-11-02T18:00:00.000Z");
  const summary = (await phone(request, "1001")).find((m) => m.text.startsWith("Tomorrow's shop"));
  expect(summary?.text).toMatch(/Bananas x5/);
  expect(summary?.text).toMatch(/Change it: http/);
});
