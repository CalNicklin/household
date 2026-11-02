import { evidence, expect, login, reset, say, test } from "./fixtures.ts";

test.beforeEach(async ({ request }) => reset(request));

test("[PRO-6][HOME-5] Pencil it in on a later day's Week card closes the card, confirms, and shows it pencilled in on that day and the Backlog (HOU-173)", async ({ page }) => {
  await login(page);
  // A reminder for tomorrow re-plans tomorrow, which gets its own backlog pick (as Cal's Wednesday did).
  await say(page, "remind me to call the dentist tomorrow");
  await expect(page.getByRole("status")).toContainText("Call the dentist");
  await page.goto("/week");
  const tuesday = page.getByRole("region", { name: "Tuesday 3 November" });
  const pencil = tuesday.getByRole("button", { name: "Pencil it in" });
  await expect(pencil).toBeVisible();
  const card = tuesday.locator(".ds-card").filter({ has: page.getByRole("button", { name: "Pencil it in" }) }).last();
  // Said from today (Monday), not from Tuesday's plan.
  await expect(card).not.toContainText("This morning");
  const title = (await card.locator(".ds-card__title").first().textContent())?.trim() ?? "";
  expect(title).not.toBe("");
  await tuesday.scrollIntoViewIfNeeded();
  await evidence(page, "HOU-173-week-card-before", { fullPage: false });

  await pencil.click();
  // The confirmation, in today's conversation.
  const confirmation = page.getByText(new RegExp(`^Pencilled in for (tomorrow|\\w+day) (morning|afternoon|evening): ${title}\\.$`));
  await expect(confirmation).toBeVisible();
  const line = ((await confirmation.textContent()) ?? "").split(":")[0] ?? "";
  // The card is gone from Week, also after a reload (the server closed it, not just this screen).
  await page.reload();
  await expect(page.locator(".ds-card").filter({ hasText: title }).getByRole("button", { name: "Pencil it in" })).toHaveCount(0);
  // Pencilled in on the day it went to.
  const pencilled = page.getByRole("button", { name: `${title} · ${line}` });
  await expect(pencilled).toBeVisible();
  await pencilled.scrollIntoViewIfNeeded();
  await evidence(page, "HOU-173-week-pencilled-in", { fullPage: false });
  // Not on Today either.
  await page.goto("/");
  await expect(page.locator(".ds-card").filter({ hasText: title }).getByRole("button", { name: "Pencil it in" })).toHaveCount(0);
  // The Backlog row says so.
  await page.goto("/backlog");
  await expect(page.getByText(line, { exact: true })).toBeVisible();
  await evidence(page, "HOU-173-backlog-row");
});
