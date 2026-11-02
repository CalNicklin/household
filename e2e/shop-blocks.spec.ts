import { Limits } from "@household/contracts";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { api, evidence, expect, login, reset, say, test } from "./fixtures.ts";

/** The kitchen iPad and a phone. */
const SIZES = {
  ipad: { viewport: { width: 1180, height: 820 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} as const;

async function open(browser: Browser, size: keyof typeof SIZES, baseURL: string | undefined): Promise<Page> {
  const ctx = await browser.newContext({ ...SIZES[size], ...(baseURL === undefined ? {} : { baseURL }) });
  const page = await ctx.newPage();
  await login(page);
  return page;
}

/** HOU-157: run the practice household like the real house, with no shopping helper (reset puts it back). */
async function helperConnected(request: APIRequestContext, connected: boolean): Promise<void> {
  await api(request);
  expect((await request.post("/api/practice/shopping-helper", { data: { connected } })).ok()).toBe(true);
}

test.beforeEach(async ({ request }) => reset(request));
test.afterEach(async ({ request }) => helperConnected(request, true));

for (const size of ["ipad", "phone"] as const) {
  test(`[HOME-4][AUT-1] (HOU-157) with no shopping helper, a shop request is saved on the Shop screen and makes no home or Week card (${size})`, async ({ browser, request, baseURL }) => {
    await helperConnected(request, false);
    const page = await open(browser, size, baseURL);
    await say(page, "we're out of saffron");
    await expect(page.getByRole("status")).toContainText("Saved saffron for when shopping is connected.");
    await page.goto("/shop");
    const row = page.getByRole("listitem").filter({ hasText: "saffron" });
    await expect(row.getByText("Saved for when shopping is connected")).toBeVisible();
    await expect(row.getByRole("button", { name: "Dismiss saffron" })).toBeVisible();
    await evidence(page, `HOU-157-no-helper-shop-${size}`);
    // Something else replans today: still no shop card.
    await page.goto("/");
    await say(page, "need to ring the dentist");
    await expect(page.getByRole("status")).toContainText("Added to the backlog");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Monday 2 November" })).toBeVisible();
    await expect(page.getByText(/saffron|Couldn't find/)).toHaveCount(0);
    await evidence(page, `HOU-157-no-helper-home-${size}`);
    await page.goto("/week");
    await expect(page.getByText(/saffron|Couldn't find/)).toHaveCount(0);
    await page.context().close();
  });

  test(`[HOME-4][PRO-9] (HOU-157) a 'Couldn't find' card on the home screen has its own Dismiss, and one tap clears it everywhere (${size})`, async ({ browser, baseURL }) => {
    const page = await open(browser, size, baseURL);
    await say(page, "we're out of dragonfruit");
    // limit: shoppingBudgetMs
    await expect(page.getByText("Couldn't find dragonfruit")).toBeVisible({ timeout: Limits.shoppingBudgetMs.value });
    await evidence(page, `HOU-157-card-before-dismiss-${size}`);
    // The card's own no-guilt dismiss: the only "Dismiss" on the practice home screen.
    const dismiss = page.getByRole("button", { name: "Dismiss" });
    await expect(dismiss).toHaveCount(1);
    await dismiss.click();
    // limit: liveUpdateBudgetMs
    await expect(page.getByText("Couldn't find dragonfruit")).toHaveCount(0, { timeout: Limits.liveUpdateBudgetMs.value });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Monday 2 November" })).toBeVisible();
    await expect(page.getByText(/dragonfruit/)).toHaveCount(0);
    await evidence(page, `HOU-157-card-after-dismiss-${size}`);
    await page.goto("/week");
    await expect(page.getByText(/dragonfruit/)).toHaveCount(0);
    await page.goto("/shop");
    await expect(page.getByRole("heading", { name: "Asked for" })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "dragonfruit" })).toHaveCount(0);
    await page.context().close();
  });
}
