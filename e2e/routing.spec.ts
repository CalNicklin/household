import { Limits } from "@household/contracts";
import { evidence, expect, login, reset, say, test } from "./fixtures.ts";

const sentences = (s: string) => s.split(/(?<=[.!?])\s+/).filter((x) => x.trim() !== "").length;

test.beforeEach(async ({ request }) => reset(request));

const PRINTER = "get the canon printer working and connected to laptop so we can print loads of photos up to A3";

test("[CAP-1][MOM-2] a job that names a product is one Backlog item, never shop items; 'what should I prioritise today?' gets the one thing", async ({ page, browser }) => {
  await login(page);
  await say(page, PRINTER);
  await expect(page.getByRole("status")).toContainText("Added to the backlog");
  // Both of us see it on the Backlog.
  const tomCtx = await browser.newContext();
  const tom = await tomCtx.newPage();
  await login(tom, "tom");
  await tom.goto("/backlog");
  // limit: captureBudgetMs
  await expect(tom.getByText("Get the canon printer working and connected to laptop so we can print loads of photos up to A3")).toHaveCount(1, { timeout: Limits.captureBudgetMs.value });
  await tomCtx.close();
  await page.goto("/backlog");
  await expect(page.getByText("Get the canon printer working and connected to laptop so we can print loads of photos up to A3")).toHaveCount(1);
  await evidence(page, "HOU-148-printer-on-backlog");
  await page.goto("/shop");
  await expect(page.getByRole("heading", { name: "Asked for" })).toBeVisible();
  await expect(page.getByText(/canon printer/i)).toHaveCount(0);
  await expect(page.getByText(/connected to laptop/i)).toHaveCount(0);

  await page.goto("/");
  await say(page, "what should I prioritise today?");
  const reply = page.getByRole("status");
  await expect(reply).toContainText(/babysitter|Jess|Dinner/);
  const text = (await reply.textContent()) ?? "";
  expect(text).not.toContain("Added to the backlog");
  // One answer: not a list, not a question.
  expect(text).not.toContain("?");
  expect(text).not.toMatch(/^\s*(?:[-•*]|\d+[.)])\s/m);
  expect(sentences(text)).toBeLessThanOrEqual(3);
  await evidence(page, "HOU-148-prioritise-one-thing");
});

test("[HOME-4][PRO-9] a shopping request that went nowhere is dismissed from the Shop screen with one tap, and is gone from the home screen too", async ({ page }) => {
  await login(page);
  await say(page, "we're out of saffron");
  await page.goto("/shop");
  const row = page.getByRole("listitem").filter({ hasText: "saffron" });
  // limit: shoppingBudgetMs
  await expect(row.getByText("Couldn't find it; nothing was added")).toBeVisible({ timeout: Limits.shoppingBudgetMs.value });
  await evidence(page, "HOU-148-shop-before-dismiss");
  await page.goto("/");
  // limit: shoppingBudgetMs
  await expect(page.getByText("Couldn't find saffron")).toBeVisible({ timeout: Limits.shoppingBudgetMs.value });
  await page.goto("/shop");
  await page.getByRole("listitem").filter({ hasText: "saffron" }).getByRole("button", { name: "Dismiss saffron" }).click();
  // limit: liveUpdateBudgetMs
  await expect(page.getByRole("listitem").filter({ hasText: "saffron" })).toHaveCount(0, { timeout: Limits.liveUpdateBudgetMs.value });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Asked for" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "saffron" })).toHaveCount(0);
  await evidence(page, "HOU-148-shop-after-dismiss");
  await page.goto("/");
  // limit: liveUpdateBudgetMs
  await expect(page.getByText("Couldn't find saffron")).toHaveCount(0, { timeout: Limits.liveUpdateBudgetMs.value });
});
