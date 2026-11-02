import { Limits } from "@household/contracts";
import type { Page } from "@playwright/test";
import { evidence, expect, login, reset, say, test, underServiceWorker } from "./fixtures.ts";

test.beforeEach(async ({ request }) => reset(request));

const list = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
// limit: liveUpdateBudgetMs
const live = { timeout: Limits.liveUpdateBudgetMs.value };

test("[CAP-6] shopping and simple lists live in the app: tick, add, rename, delete and list changes show on the other phone straight away", async ({ page, browser }) => {
  // FB-2: Playwright's clock, so the Undo window (HOU-158) is skipped rather than waited out.
  await page.clock.install();
  await login(page);
  await page.goto("/lists");
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneCtx.newPage();
  await login(phone, "tom");
  await phone.goto("/lists");

  const shopping = list(page, "Shopping");
  const tomShopping = list(phone, "Shopping");
  await expect(tomShopping.getByRole("checkbox", { name: "Untick kitchen roll", exact: true })).toBeVisible();

  // Add with Enter; the other phone sees it.
  await shopping.getByRole("textbox", { name: "Add an item to Shopping" }).fill("Batteries");
  await shopping.getByRole("textbox", { name: "Add an item to Shopping" }).press("Enter");
  await expect(tomShopping.getByRole("button", { name: "Batteries", exact: true })).toBeVisible(live);

  // The same thing twice, ignoring case and spaces, is refused.
  await shopping.getByRole("textbox", { name: "Add an item to Shopping" }).fill("  BIN bags ");
  await shopping.getByRole("textbox", { name: "Add an item to Shopping" }).press("Enter");
  await expect(shopping.getByRole("alert")).toContainText("is already on this list");

  // Tick: it stays, struck through, on both screens. Untick from the phone.
  await shopping.getByRole("checkbox", { name: "Tick bin bags", exact: true }).click();
  await expect(tomShopping.getByRole("checkbox", { name: "Untick bin bags", exact: true })).toBeVisible(live);
  await expect(tomShopping.getByRole("button", { name: "bin bags", exact: true })).toHaveCSS("text-decoration-line", "line-through");
  await evidence(phone, "CAP-6-lists-ticked-on-the-other-phone");
  await tomShopping.getByRole("checkbox", { name: "Untick bin bags", exact: true }).click();
  await expect(shopping.getByRole("checkbox", { name: "Tick bin bags", exact: true })).toBeVisible(live);

  // Rename by tapping the words.
  await shopping.getByRole("button", { name: "Batteries", exact: true }).click();
  await shopping.getByRole("textbox", { name: "Rename Batteries" }).fill("AA batteries");
  await shopping.getByRole("textbox", { name: "Rename Batteries" }).press("Enter");
  await expect(tomShopping.getByRole("button", { name: "AA batteries", exact: true })).toBeVisible(live);

  // Delete: gone at once, with Undo for a few seconds (HOU-158); then the other phone sees it gone.
  await shopping.getByRole("button", { name: "Delete AA batteries" }).click();
  await expect(page.getByRole("status", { name: "Deleted" })).toContainText("AA batteries");
  // limit: undoWindowMs
  await page.clock.fastForward(Limits.undoWindowMs.value);
  await expect(tomShopping.getByRole("button", { name: "AA batteries", exact: true })).toHaveCount(0, live);

  // A new list, renamed with an emoji from its menu, then deleted.
  await page.getByRole("button", { name: "New list" }).click();
  await list(page, "New list").getByRole("button", { name: "Actions for New list" }).click();
  await page.getByRole("menuitem", { name: "Rename / emoji" }).click();
  await page.getByRole("textbox", { name: "List emoji" }).fill("⛺");
  await page.getByRole("textbox", { name: "List name" }).fill("Camping");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(list(phone, "Camping").getByRole("heading", { name: "Camping" })).toContainText("⛺", live);
  await list(page, "Camping").getByRole("textbox", { name: "Add an item to Camping" }).fill("Tent pegs");
  await list(page, "Camping").getByRole("textbox", { name: "Add an item to Camping" }).press("Enter");
  await expect(list(phone, "Camping").getByRole("button", { name: "Tent pegs", exact: true })).toBeVisible(live);
  await evidence(page, "CAP-6-lists");
  await list(page, "Camping").getByRole("button", { name: "Actions for Camping" }).click();
  await page.getByRole("menuitem", { name: "Delete list" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete list" }).click();
  // limit: undoWindowMs
  await page.clock.fastForward(Limits.undoWindowMs.value);
  await expect(list(phone, "Camping")).toHaveCount(0, live);
  await phoneCtx.close();
});

test("[CAP-6][PRV-1] anything said adds to a list, and it shows on the other screen straight away", async ({ page, browser }) => {
  await login(page);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneCtx.newPage();
  await login(phone, "tom");
  await phone.goto("/lists");
  await expect(list(phone, "Christmas presents").getByRole("button", { name: "Lego for Noah", exact: true })).toBeVisible();
  await say(page, "add wrapping paper to the christmas presents list");
  // limit: captureBudgetMs
  await expect(list(phone, "Christmas presents").getByRole("button", { name: "wrapping paper", exact: true })).toBeVisible({ timeout: Limits.captureBudgetMs.value });
  await say(page, "add batteries to the shopping list");
  // limit: captureBudgetMs
  await expect(list(phone, "Shopping").getByRole("button", { name: "batteries", exact: true })).toBeVisible({ timeout: Limits.captureBudgetMs.value });
  await evidence(phone, "CAP-6-said-on-the-ipad-seen-on-the-phone");
  await phoneCtx.close();
});

test("[CAP-6] on a slow connection a rename cannot be typed over while it saves, and words typed while an add saves are kept", async ({ page }) => {
  await login(page);
  await underServiceWorker(page);
  await page.goto("/lists");
  // A slow connection: every list write takes a moment to come back.
  await page.route(/\/api\/trpc\/(renameListItem|addListItem)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  const shopping = list(page, "Shopping");
  await shopping.getByRole("button", { name: "bin bags", exact: true }).click();
  const rename = shopping.getByRole("textbox", { name: "Rename bin bags" });
  await rename.fill("black bin bags");
  await rename.press("Enter");
  // While it saves the field cannot be typed into, so nothing typed then is lost.
  await expect(rename).not.toBeEditable();
  await expect(rename).toHaveValue("black bin bags");
  await expect(shopping.getByRole("button", { name: "black bin bags", exact: true })).toBeVisible();

  const add = shopping.getByRole("textbox", { name: "Add an item to Shopping" });
  await add.fill("Matches");
  await add.press("Enter");
  await add.fill("Candles");
  await expect(shopping.getByRole("button", { name: "Matches", exact: true })).toBeVisible();
  await expect(add).toHaveValue("Candles");
});

test("[CAP-6] tick then untick quickly on a slow connection: the last tap is what both screens keep", async ({ page, browser }) => {
  await login(page);
  await underServiceWorker(page);
  await page.goto("/lists");
  // The first write is slow and the second is quick, so they would land in the wrong order if both were sent at once.
  let calls = 0;
  await page.route(/\/api\/trpc\/setListItemChecked/, async (route) => {
    calls += 1;
    if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });
  let answered = 0;
  page.on("response", (r) => {
    if (r.url().includes("/api/trpc/setListItemChecked")) answered += 1;
  });
  const shopping = list(page, "Shopping");
  await shopping.getByRole("checkbox", { name: "Tick bin bags", exact: true }).click();
  await shopping.getByRole("checkbox", { name: "Untick bin bags", exact: true }).click();
  // Both writes have been answered before anyone looks.
  await expect.poll(() => answered).toBe(2);
  expect(calls).toBe(2);
  const phoneCtx = await browser.newContext();
  const phone = await phoneCtx.newPage();
  await login(phone, "tom");
  await phone.goto("/lists");
  await expect(list(phone, "Shopping").getByRole("checkbox", { name: "Tick bin bags", exact: true })).toBeVisible();
  await page.reload();
  await expect(shopping.getByRole("checkbox", { name: "Tick bin bags", exact: true })).toBeVisible();
  await phoneCtx.close();
});

test("[CAP-6] changing a list's emoji on one device keeps a rename made on the other meanwhile", async ({ page, browser }) => {
  await login(page);
  await page.goto("/lists");
  const phoneCtx = await browser.newContext();
  const phone = await phoneCtx.newPage();
  await login(phone, "tom");
  await phone.goto("/lists");

  // The iPad opens the editor first.
  await list(page, "Christmas presents").getByRole("button", { name: "Actions for Christmas presents" }).click();
  await page.getByRole("menuitem", { name: "Rename / emoji" }).click();
  // The phone renames the list while the iPad's editor is still open.
  await list(phone, "Christmas presents").getByRole("button", { name: "Actions for Christmas presents" }).click();
  await phone.getByRole("menuitem", { name: "Rename / emoji" }).click();
  await phone.getByRole("textbox", { name: "List name" }).fill("Presents");
  await phone.getByRole("button", { name: "Save" }).click();
  await expect(list(phone, "Presents")).toBeVisible(live);
  // The iPad changes only the emoji.
  await page.getByRole("textbox", { name: "List emoji" }).fill("🎄");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(list(phone, "Presents").getByRole("heading", { name: "Presents" })).toContainText("🎄", live);
  await expect(list(page, "Presents").getByRole("heading", { name: "Presents" })).toContainText("🎄", live);
  await phoneCtx.close();
});
