import { Limits } from "@household/contracts";
import { evidence, expect, login, reset, say, test } from "./fixtures.ts";

test.beforeEach(async ({ request }) => reset(request));

const PRINTER = "get the canon printer working and connected to laptop so we can print loads of photos up to A3";

test("[CAP-1][MOM-2] a job that names a product is one Backlog item, never shop items; 'what should I prioritise today?' gets the one thing", async ({ page }) => {
  await login(page);
  await say(page, PRINTER);
  await expect(page.getByRole("status")).toContainText("Added to the backlog");
  await page.goto("/backlog");
  // limit: captureBudgetMs
  await expect(page.getByText("Get the canon printer working and connected to laptop so we can print loads of photos up to A3")).toBeVisible({ timeout: Limits.captureBudgetMs.value });
  await evidence(page, "HOU-148-printer-on-backlog");
  await page.goto("/shop");
  await expect(page.getByRole("heading", { name: "Asked for" })).toBeVisible();
  await expect(page.getByText(/canon printer/i)).toHaveCount(0);
  await expect(page.getByText(/connected to laptop/i)).toHaveCount(0);

  await page.goto("/");
  await say(page, "what should I prioritise today?");
  const reply = page.getByRole("status");
  await expect(reply).toContainText(/babysitter|Jess|Dinner/);
  expect((await reply.textContent()) ?? "").not.toContain("Added to the backlog");
  await evidence(page, "HOU-148-prioritise-one-thing");
});

test("[HOME-4] a shopping request that went nowhere is dismissed from the Shop screen with one tap, and stays gone", async ({ page }) => {
  await login(page);
  await say(page, "we're out of saffron");
  await page.goto("/shop");
  const row = page.getByRole("listitem").filter({ hasText: "saffron" });
  // limit: shoppingBudgetMs
  await expect(row.getByText("Couldn't find it; nothing was added")).toBeVisible({ timeout: Limits.shoppingBudgetMs.value });
  await evidence(page, "HOU-148-shop-before-dismiss");
  await row.getByRole("button", { name: "Dismiss saffron" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "saffron" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Asked for" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "saffron" })).toHaveCount(0);
  await evidence(page, "HOU-148-shop-after-dismiss");
});
