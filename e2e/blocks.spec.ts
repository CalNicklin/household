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
  const card = column.locator(".ds-card--suggestion").first();
  await expect(card).toBeVisible();
  const { text, actions, buttonsWidth } = await boxes(card);
  expect(text).not.toBeNull();
  expect(actions).not.toBeNull();
  if (text === null || actions === null) return;
  const below = actions.top >= text.bottom - 1;
  expect(below || text.width >= buttonsWidth, `text ${text.width}px wide beside buttons ${buttonsWidth}px wide`).toBe(true);
  // Nothing in the card spills out of it.
  const cardBox = await card.boundingBox();
  expect(cardBox).not.toBeNull();
  if (cardBox !== null) expect(Math.max(text.right, actions.right)).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  await evidence(page, "HOU-153-narrow-suggestion", { fullPage: false });
});

test("[HOME-7] an all-day item shows where it came from in the time column, not an empty gap (HOU-153)", async ({ page }) => {
  await login(page);
  const row = page.getByRole("listitem").filter({ hasText: "Ivy and Noah" }).first();
  await expect(row).toBeVisible();
  await expect(row.locator(".ds-list-row__time svg")).toBeVisible();
});
