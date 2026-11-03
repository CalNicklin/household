import { Limits } from "@household/contracts";
import type { Page } from "@playwright/test";
import { evidence, expect, login, reset, say, test } from "./fixtures.ts";

/**
 * HOU-179: the Backlog's "…" menu on an active item has Done (with Undo, as Delete) and Pencil it in
 * (HOU-178's path, from the Backlog), as Cal asked on Tuesday 3 November at 16:32.
 */
const FRIDGE = "Clean the fridge before Friday";
const TUESDAY_AFTERNOON = "2026-11-03T16:32:00.000Z";
const GROUPS = ["Could go soon", "Waiting for the right moment", "Just added"] as const;

test.beforeEach(async ({ request }) => reset(request, TUESDAY_AFTERNOON));

const group = (page: Page, name: (typeof GROUPS)[number]) => page.getByRole("region", { name, exact: true });
const rowIn = (page: Page, name: (typeof GROUPS)[number]) => group(page, name).getByRole("listitem").filter({ has: page.getByText(FRIDGE, { exact: true }) });
const onBacklog = (page: Page) => page.getByRole("region", { name: /^(Could go soon|Waiting for the right moment|Just added)$/ }).getByText(FRIDGE, { exact: true });
const toast = (page: Page) => page.getByRole("status", { name: "Done" });

async function choose(page: Page, name: (typeof GROUPS)[number], entry: string) {
  const menu = rowIn(page, name).getByRole("button", { name: `Actions for ${FRIDGE}` });
  const box = await menu.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await menu.click();
  await page.getByRole("menuitem", { name: entry, exact: true }).click();
}

async function added(page: Page) {
  await say(page, FRIDGE);
  await page.goto("/backlog");
  await expect(rowIn(page, "Just added")).toBeVisible();
}

test("[PRV-1][CAP-4] Done on a Just added item takes it off with Undo; left, it is done and on no screen (HOU-179)", async ({ page }) => {
  await page.clock.install();
  await login(page);
  await added(page);
  await rowIn(page, "Just added").scrollIntoViewIfNeeded();
  await evidence(page, "HOU-179-backlog-just-added");

  // Done, then Undo: nothing was sent, so it is still there after a reload.
  await choose(page, "Just added", "Done");
  await expect(onBacklog(page)).toHaveCount(0);
  await expect(toast(page)).toContainText(`Done: “${FRIDGE}”`);
  await evidence(page, "HOU-179-done-with-undo");
  const undo = toast(page).getByRole("button", { name: "Undo" });
  const box = await undo.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await undo.click();
  await expect(toast(page)).toHaveCount(0);
  await expect(rowIn(page, "Just added")).toBeVisible();
  await page.reload();
  await expect(rowIn(page, "Just added")).toBeVisible();

  // Done and left: once the Undo window passes, the house says it's off the list.
  await choose(page, "Just added", "Done");
  // limit: undoWindowMs
  await page.clock.fastForward(Limits.undoWindowMs.value);
  await expect(toast(page)).toHaveCount(0);
  await expect(page.getByRole("status", { name: "The house's answer" })).toContainText(`Nice. "${FRIDGE}" is off the list.`);
  await evidence(page, "HOU-179-done-off-the-list");
  await page.reload();
  await expect(group(page, "Just added")).toBeVisible();
  await expect(onBacklog(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Show parked" }).click();
  await expect(page.getByRole("region", { name: "Parked", exact: true }).getByText(FRIDGE, { exact: true })).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tuesday 3 November" })).toBeVisible();
  await expect(page.locator(".ds-card").filter({ hasText: FRIDGE })).toHaveCount(0);
  await page.goto("/week");
  await expect(page.getByRole("region", { name: "Tuesday 3 November" })).toBeVisible();
  await expect(page.getByRole("region", { name: / November$/ }).getByText(FRIDGE)).toHaveCount(0);
});

test("[PRO-8][PRO-6][CAP-4] Pencil it in from the Backlog gives the fridge a slot before Friday, says when and why, shows it on that day in Week and under Could go soon, and leaves Tuesday's own offer (HOU-179)", async ({ page }) => {
  await login(page);
  // Tuesday's own offer, made this morning before the fridge was added.
  const offer = page.locator(".ds-card").filter({ has: page.getByRole("button", { name: "Pencil it in" }) });
  await expect(offer.first()).toBeVisible();
  const offered = (await offer.first().locator(".ds-card__title").first().textContent())?.trim() ?? "";
  expect(offered).not.toBe("");
  await added(page);

  await choose(page, "Just added", "Pencil it in");
  const reply = page.getByText(new RegExp(`^Pencilled in for (this evening|tomorrow (morning|afternoon|evening)|Thursday (morning|afternoon|evening)): ${FRIDGE}\\. .+, and it's before Friday\\.$`));
  await expect(reply).toBeVisible();
  await evidence(page, "HOU-179-pencilled-from-backlog");
  const line = ((await reply.textContent()) ?? "").split(":")[0] ?? "";
  const when = line.replace("Pencilled in for ", "");
  const day = when.startsWith("this ") ? "Tuesday 3 November" : when.startsWith("tomorrow ") ? "Wednesday 4 November" : "Thursday 5 November";

  // Could go soon, with its pencilled line; its menu now says Move.
  await page.reload();
  await expect(rowIn(page, "Could go soon").getByText(line, { exact: true })).toBeVisible();
  await rowIn(page, "Could go soon").getByRole("button", { name: `Actions for ${FRIDGE}` }).click();
  await expect(page.getByRole("menuitem", { name: "Move", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Pencil it in", exact: true })).toHaveCount(0);
  await evidence(page, "HOU-179-could-go-soon-move");
  await page.keyboard.press("Escape");

  // On that day in Week.
  await page.goto("/week");
  const pencilled = page.getByRole("region", { name: day }).getByRole("button", { name: `${FRIDGE} · ${line}` });
  await expect(pencilled).toBeVisible();
  await pencilled.scrollIntoViewIfNeeded();
  await evidence(page, "HOU-179-week-pencilled", { fullPage: false });

  // PRO-6: Tuesday's own offer is still there, still to be pencilled in.
  await page.goto("/");
  await expect(page.locator(".ds-card").filter({ hasText: offered }).getByRole("button", { name: "Pencil it in" })).toBeVisible();
});
