import type { Locator } from "@playwright/test";
import { evidence, expect, login, reset, test } from "./fixtures.ts";

test.beforeEach(async ({ request }) => reset(request));

/**
 * The card's text box, its button box, and how wide the buttons are side by side (each button plus
 * the gaps between them), so a column of buttons squeezed beside the text cannot pass for "narrow".
 */
async function boxes(card: Locator) {
  return card.evaluate((el) => {
    const rect = (q: string) => {
      const r = el.querySelector(q)?.getBoundingClientRect();
      return r === undefined ? null : { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const buttons = [...el.querySelectorAll(".ds-card__actions button")].map((b) => b.getBoundingClientRect().width);
    const actionsEl = el.querySelector(".ds-card__actions");
    const gap = actionsEl === null ? 0 : Number.parseFloat(getComputedStyle(actionsEl).columnGap) || 0;
    const buttonsWidth = buttons.reduce((a, b) => a + b, 0) + gap * Math.max(0, buttons.length - 1);
    return { text: rect(".ds-card__main"), actions: rect(".ds-card__actions"), buttonsWidth };
  });
}

test("[HOME-7][HOME-10] a suggestion in the narrow right-hand column keeps its text at least as wide as its buttons, or puts the buttons below (HOU-153)", async ({ page }) => {
  await login(page);
  const column = page.getByRole("region", { name: "Could fit this week" });
  await expect(column.locator(".ds-card--suggestion").first()).toBeVisible();
  const cards = column.locator(".ds-card--fluid");
  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    const { text, actions, buttonsWidth } = await boxes(card);
    expect(text).not.toBeNull();
    if (text === null || actions === null) continue;
    const below = actions.top >= text.bottom - 1;
    expect(below || text.width >= buttonsWidth, `card ${i}: text ${text.width}px wide beside buttons ${buttonsWidth}px wide`).toBe(true);
    // Nothing in the card spills out of it, on any side.
    const c = await card.boundingBox();
    expect(c).not.toBeNull();
    if (c === null) continue;
    for (const r of [text, actions]) {
      expect(r.left).toBeGreaterThanOrEqual(c.x - 1);
      expect(r.top).toBeGreaterThanOrEqual(c.y - 1);
      expect(r.right).toBeLessThanOrEqual(c.x + c.width + 1);
      expect(r.bottom).toBeLessThanOrEqual(c.y + c.height + 1);
    }
  }
  await evidence(page, "HOU-153-narrow-suggestion", { fullPage: false });
});

test("[HOME-7] an all-day item shows where it came from in the time column, not an empty gap (HOU-153)", async ({ page }) => {
  await login(page);
  const row = page.getByRole("listitem").filter({ hasText: "Ivy and Noah" }).first();
  await expect(row).toBeVisible();
  // The nursery day comes from the house's rules, so it must show that icon, not the calendar default.
  await expect(row.getByRole("img", { name: "No set time, from the house's rules" })).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("[HOME-10] every card's buttons sit below its text or beside text at least as wide; nothing is cut off and every button is tappable (HOU-153)", async ({ page }) => {
    await login(page);
    await expect(page.getByText("Hang the washing out")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const cards = page.locator(".ds-card--fluid");
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const { text, actions, buttonsWidth } = await boxes(card);
      if (text === null || actions === null) continue;
      expect(actions.top >= text.bottom - 1 || text.width >= buttonsWidth, `card ${i}: text ${text.width}px beside buttons ${buttonsWidth}px`).toBe(true);
      for (const b of await card.locator(".ds-card__actions button").all()) {
        const box = await b.boundingBox();
        expect(box !== null && box.width >= 44 && box.height >= 44).toBe(true);
      }
    }
    await evidence(page, "HOU-153-phone-cards", { fullPage: false });
  });
});

test("[HOME-7] on Week, only today has a Now or Later today label; a later day's blocks sit under its own heading (HOU-153)", async ({ page }) => {
  await login(page);
  await page.goto("/week");
  const today = page.getByRole("region", { name: "Monday 2 November" });
  await expect(today.getByRole("heading", { name: "Now" })).toBeVisible();
  const tuesday = page.getByRole("region", { name: "Tuesday 3 November" });
  await expect(tuesday.getByText(/Dinner at Sam's/).first()).toBeVisible();
  await expect(tuesday.getByRole("heading", { name: /^(Now|Later today)$/ })).toHaveCount(0);
  await evidence(page, "HOU-153-week", { fullPage: false });
});
