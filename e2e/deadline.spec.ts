import { TimerKind } from "@household/contracts";
import { evidence, expect, login, reset, say, test, timer } from "./fixtures.ts";

/** Cal's item (HOU-178), added on the practice Monday, 2 November: needed by Friday 6 November at 12:00. */
const FRIDGE = "Clean the garage fridge ready for collection by Friday lunchtime";

test.beforeEach(async ({ request, page }) => {
  await reset(request);
  await login(page);
  await say(page, FRIDGE);
  await page.goto("/backlog");
  await expect(page.getByText(FRIDGE)).toBeVisible();
});

test("[CAP-2][PRO-8] an item needed by Friday lunchtime is offered on Thursday's morning screen and could go soon on the Backlog (HOU-178)", async ({ page, request }) => {
  await timer(request, TimerKind.morningPlan, "2026-11-05T05:30:00.000Z");
  await page.goto("/");
  const card = page.locator(".ds-card").filter({ hasText: FRIDGE });
  await expect(card.getByRole("button", { name: "Pencil it in" })).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await evidence(page, "HOU-178-thursday-offered", { fullPage: false });
  await page.goto("/backlog");
  await expect(page.getByRole("region", { name: "Could go soon" }).getByText(FRIDGE)).toBeVisible();
});

test("[CAP-2][PRO-8] after its deadline it is never offered: not on Saturday's screen or Week, and it waits on the Backlog (HOU-178)", async ({ page, request }) => {
  await timer(request, TimerKind.morningPlan, "2026-11-07T05:30:00.000Z");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Pencil it in" }).first()).toBeVisible();
  await expect(page.locator(".ds-card").filter({ hasText: FRIDGE })).toHaveCount(0);
  await evidence(page, "HOU-178-saturday-not-offered", { fullPage: false });
  await page.goto("/week");
  await expect(page.getByRole("region", { name: "Saturday 7 November" })).toBeVisible();
  await expect(page.getByText(FRIDGE)).toHaveCount(0);
  await page.goto("/backlog");
  await expect(page.getByRole("region", { name: "Waiting for the right moment" }).getByText(FRIDGE)).toBeVisible();
  await expect(page.getByRole("region", { name: "Could go soon" }).getByText(FRIDGE)).toHaveCount(0);
  await evidence(page, "HOU-178-saturday-backlog");
});
