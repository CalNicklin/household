import { Limits } from "@household/contracts";
import type { Browser, Locator, Page } from "@playwright/test";
import { evidence, expect, login, reset, say, test } from "./fixtures.ts";

/**
 * HOU-158: a person deletes backlog items, list items, whole lists and shop requests from the app.
 * The thing goes at once, Undo shows for a few seconds and puts it back with nothing sent; left
 * alone, the delete is sent and the other phone sees it gone. Each surface at iPad and phone size.
 */
test.beforeEach(async ({ request }) => reset(request));

/**
 * FB-2: each page runs on Playwright's clock, so a test skips the five-second Undo window instead of
 * waiting it out; time otherwise flows as normal.
 */
async function letUndoLapse(page: Page) {
  // limit: undoWindowMs
  await page.clock.fastForward(Limits.undoWindowMs.value);
  await expect(toast(page)).toHaveCount(0);
}
// limit: liveUpdateBudgetMs
const live = { timeout: Limits.liveUpdateBudgetMs.value };

async function phoneOf(browser: Browser, person = "priya"): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await ctx.newPage();
  await phone.clock.install();
  await login(phone, person);
  return phone;
}

const toast = (page: Page) => page.getByRole("status", { name: "Deleted" });
const row = (page: Page, text: string) => page.getByRole("listitem").filter({ has: page.getByText(text, { exact: true }) });

/** Undo is a full tap target (HOME-10), and taking it puts the thing back. */
async function undo(page: Page, message: string, back: Locator) {
  await expect(toast(page)).toContainText(message);
  const box = await toast(page).getByRole("button", { name: "Undo" }).boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toHaveCount(0);
  await expect(back).toBeVisible();
}

/** "…" then Delete on a backlog or shop row. */
async function deleteRow(page: Page, text: string) {
  const menu = row(page, text).getByRole("button", { name: `Actions for ${text}` });
  const box = await menu.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await menu.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
}

test("[PRV-1] a person deletes a backlog item anyone wrote, with Undo, on the iPad and the phone", async ({ page, browser }) => {
  await page.clock.install();
  await login(page);
  await page.goto("/backlog");
  const tom = await phoneOf(browser, "tom");
  await tom.goto("/backlog");

  // iPad: Tom's item, deleted by Priya, then undone: nothing was sent, so it is still there after a reload.
  await deleteRow(page, "Clear the gutters");
  await expect(row(page, "Clear the gutters")).toHaveCount(0);
  await evidence(page, "HOU-158-backlog-undo-ipad");
  await undo(page, "Deleted “Clear the gutters”", row(page, "Clear the gutters"));
  await page.reload();
  await expect(row(page, "Clear the gutters")).toBeVisible();

  // Deleted and left: gone for good, and from Tom's phone too.
  await deleteRow(page, "Clear the gutters");
  await letUndoLapse(page);
  await expect(row(tom, "Clear the gutters")).toHaveCount(0, live);
  await page.reload();
  await expect(page.getByText("Service the bike", { exact: true })).toBeVisible();
  await expect(row(page, "Clear the gutters")).toHaveCount(0);

  // Phone: the same, with touch.
  const phone = await phoneOf(browser);
  await phone.goto("/backlog");
  await deleteRow(phone, "Paint the shed door");
  await evidence(phone, "HOU-158-backlog-undo-phone", { fullPage: false });
  await undo(phone, "Deleted “Paint the shed door”", row(phone, "Paint the shed door"));
  await deleteRow(phone, "Paint the shed door");
  await letUndoLapse(phone);
  await expect(row(page, "Paint the shed door")).toHaveCount(0, live);
});

const list = (p: Page, name: string) => p.getByRole("region", { name, exact: true });
const item = (p: Page, text: string) => list(p, "Shopping").getByRole("button", { name: text, exact: true });

test("[PRV-1][CAP-6] a person deletes a list item, and a whole list after a confirm, with Undo, on the iPad and the phone", async ({ page, browser }) => {
  await page.clock.install();
  await login(page);
  await page.goto("/lists");
  const phone = await phoneOf(browser);
  await phone.goto("/lists");

  // iPad: an item, undone then deleted for good.
  await list(page, "Shopping").getByRole("button", { name: "Delete kitchen roll" }).click();
  await expect(item(page, "kitchen roll")).toHaveCount(0);
  await evidence(page, "HOU-158-list-item-undo-ipad");
  await undo(page, "Deleted “kitchen roll” from Shopping", item(page, "kitchen roll"));
  await page.reload();
  await expect(item(page, "kitchen roll")).toBeVisible();
  await list(page, "Shopping").getByRole("button", { name: "Delete kitchen roll" }).click();
  await letUndoLapse(page);
  await expect(item(phone, "kitchen roll")).toHaveCount(0, live);

  // Phone: an item, undone, then a whole list after a confirm, undone, then deleted for good.
  await list(phone, "Shopping").getByRole("button", { name: "Delete bin bags" }).click();
  await undo(phone, "Deleted “bin bags” from Shopping", item(phone, "bin bags"));
  await list(phone, "Christmas presents").getByRole("button", { name: "Actions for Christmas presents" }).click();
  await phone.getByRole("menuitem", { name: "Delete list" }).click();
  await phone.getByRole("alertdialog").getByRole("button", { name: "Delete list" }).click();
  await expect(list(phone, "Christmas presents")).toHaveCount(0);
  await evidence(phone, "HOU-158-list-undo-phone", { fullPage: false });
  await undo(phone, "Deleted the list “Christmas presents”", list(phone, "Christmas presents"));
  await list(phone, "Christmas presents").getByRole("button", { name: "Actions for Christmas presents" }).click();
  await phone.getByRole("menuitem", { name: "Delete list" }).click();
  await phone.getByRole("alertdialog").getByRole("button", { name: "Delete list" }).click();
  await letUndoLapse(phone);
  await expect(list(page, "Christmas presents")).toHaveCount(0, live);
  await expect(item(page, "bin bags")).toBeVisible();
});

test("[PRV-1][AUT-1] a person deletes a shop request that went nowhere, with Undo, on the iPad and the phone", async ({ page, browser }) => {
  await page.clock.install();
  await login(page);
  await say(page, "we're out of saffron");
  await page.goto("/shop");
  // limit: shoppingBudgetMs
  await expect(row(page, "saffron").getByText("Couldn't find it; nothing was added")).toBeVisible({ timeout: Limits.shoppingBudgetMs.value });
  await deleteRow(page, "saffron");
  await expect(row(page, "saffron")).toHaveCount(0);
  await evidence(page, "HOU-158-shop-undo-ipad");
  await undo(page, "Deleted “saffron”", row(page, "saffron"));
  await page.reload();
  await expect(row(page, "saffron")).toBeVisible();

  const phone = await phoneOf(browser);
  await phone.goto("/shop");
  await deleteRow(phone, "saffron");
  await evidence(phone, "HOU-158-shop-undo-phone", { fullPage: false });
  await letUndoLapse(phone);
  await expect(row(page, "saffron")).toHaveCount(0, live);
  await phone.reload();
  await expect(phone.getByRole("heading", { name: "Asked for" })).toBeVisible();
  await expect(row(phone, "saffron")).toHaveCount(0);
});

test("[PRV-1] a delete that does not go through comes back, and the screen says so", async ({ page }) => {
  await page.clock.install();
  await login(page);
  await page.goto("/lists");
  await page.route("**/api/trpc/removeListItem**", (route) => route.fulfill({ status: 500, body: "{}" }));
  await list(page, "Shopping").getByRole("button", { name: "Delete kitchen roll" }).click();
  await expect(item(page, "kitchen roll")).toHaveCount(0);
  // limit: undoWindowMs
  await page.clock.fastForward(Limits.undoWindowMs.value);
  await expect(toast(page)).toContainText("Couldn't delete that — it's back");
  await expect(toast(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(item(page, "kitchen roll")).toBeVisible();
});
