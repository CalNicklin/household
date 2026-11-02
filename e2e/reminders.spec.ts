import { Limits } from "@household/contracts";
import { evidence, expect, login, phone, reset, say, test, timer } from "./fixtures.ts";

test.beforeEach(async ({ request }) => reset(request));

test("[CAP-10] 'remind us to discuss Wise Owls tonight' shows on Today under Later today, then under Now with a message at 8pm; Done takes it off (HOU-172)", async ({ page, request }) => {
  await login(page);
  await say(page, "remind us to discuss Wise Owls tonight");
  await expect(page.getByRole("status")).toContainText("I'll remind you and Tom at 20:00 today: Discuss Wise Owls.");
  const later = page.getByRole("region", { name: "Later today" }).filter({ hasText: "Discuss Wise Owls" });
  await expect(later.getByText("For Priya & Tom")).toBeVisible();
  await expect(later.getByText("20:00")).toBeVisible();
  await expect(later.getByRole("button", { name: "Not now" })).toBeVisible();
  await evidence(page, "HOU-172-later-today");

  await timer(request, "hourly-refresh", "2026-11-02T20:00:00.000Z");
  expect((await phone(request, "1002")).find((m) => m.text === "Reminder from Priya: Discuss Wise Owls")?.buttons.map((b) => b.label)).toEqual(["Done", "Later"]);
  await page.reload();
  const now = page.getByRole("region", { name: "Now" }).filter({ hasText: "Discuss Wise Owls" });
  await expect(now.getByText("For Priya & Tom")).toBeVisible();
  await evidence(page, "HOU-172-now-when-due");

  await now.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Discuss Wise Owls", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Monday 2 November" })).toBeVisible();
  await expect(page.getByText("Discuss Wise Owls", { exact: true })).toHaveCount(0);
  await evidence(page, "HOU-172-done");
});

/**
 * HOU-174: a reminder is changed or cancelled only because a person asks: "…" then Change time or
 * Delete (with Undo) on its card, or saying so to the house. Never a second reminder.
 */
test("[CAP-10][PRV-1] a reminder's '…' menu changes its time and deletes it with Undo; 'cancel the 9 o'clock BoyBoy reminder' cancels the duplicate (HOU-174)", async ({ page }) => {
  await login(page);
  await say(page, "remind me tonight to lock the shed");
  await expect(page.getByRole("status")).toContainText("I'll remind you at 20:00 today: Lock the shed.");
  const card = () => page.getByRole("region", { name: "Later today" }).locator(".ds-card").filter({ hasText: "Lock the shed" });
  await expect(card().getByText("20:00")).toBeVisible();

  // Change time: a small time choice under the card.
  await card().getByRole("button", { name: "Actions for Lock the shed" }).click();
  await page.getByRole("menuitem", { name: "Change time" }).click();
  await card().getByLabel("New time for Lock the shed").fill("21:15");
  await evidence(page, "HOU-174-change-time");
  await card().getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText("Moved: Lock the shed, now at 21:15 today.");
  await expect(card().getByText("21:15")).toBeVisible();
  await expect(card().getByText("20:00")).toHaveCount(0);
  await evidence(page, "HOU-174-changed");

  // Delete, with Undo (HOU-158): Undo puts it back with nothing sent; left alone, it is gone. FB-2: on
  // Playwright's clock from here, so the test skips the Undo window instead of waiting it out.
  await page.clock.install();
  await page.reload();
  const toast = page.getByRole("status", { name: "Deleted" });
  await card().getByRole("button", { name: "Actions for Lock the shed" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(toast).toContainText("Deleted “Lock the shed”");
  await expect(card()).toHaveCount(0);
  await evidence(page, "HOU-174-delete-undo");
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(card().getByText("21:15")).toBeVisible();
  await card().getByRole("button", { name: "Actions for Lock the shed" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  // limit: undoWindowMs
  await page.clock.fastForward(Limits.undoWindowMs.value);
  await expect(toast).toHaveCount(0);
  // HOU-177: once sent, the house's answer opens the conversation.
  await expect(page.getByRole("status")).toContainText("Cancelled the 21:15 reminder today: Lock the shed.");
  // Sent once the window ends: the reminder is cancelled, so a fresh load of Today leaves it out too.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Monday 2 November" })).toBeVisible();
    await expect(page.getByText("Lock the shed", { exact: true })).toHaveCount(0);
  }).toPass();

  // Cal's duplicate (2 Nov): two BoyBoy reminders on Wednesday; saying which one cancels just that one.
  await say(page, "remind me on Wednesday morning to check BoyBoy's lunchtime nap");
  await expect(page.getByRole("status")).toContainText("I'll remind you at 09:00 Wednesday 4 November");
  await say(page, "remind me on Wednesday at 7:30 to check BoyBoy's lunchtime nap");
  await expect(page.getByRole("status")).toContainText("I'll remind you at 07:30 Wednesday 4 November");
  await say(page, "make the BoyBoy reminder 7:15");
  await expect(page.getByRole("status")).toContainText("Which one?");
  await say(page, "cancel the 9 o'clock BoyBoy reminder");
  await expect(page.getByRole("status")).toContainText("Cancelled the 09:00 reminder Wednesday 4 November: Check BoyBoy's lunchtime nap.");
  await evidence(page, "HOU-174-cancel-by-phrase");
  await page.goto("/week");
  const wednesday = page.getByRole("region", { name: "Wednesday 4 November" });
  const boyBoy = wednesday.locator(".ds-card").filter({ hasText: "Check BoyBoy's lunchtime nap" });
  await expect(boyBoy).toHaveCount(1);
  await expect(boyBoy.getByText("07:30")).toBeVisible();
  await evidence(page, "HOU-174-week-one-left");
});

/**
 * HOU-177: Cal's case. Done on the 09:00 BoyBoy reminder from Tuesday's Tomorrow takes it off Tuesday
 * too, and "cancel the 9 o'clock BoyBoy reminder" then says it's done, never offering the 07:30 one.
 */
test("[CAP-10][PRV-1] a reminder done from Tomorrow leaves Week; 'cancel the 9 o'clock BoyBoy reminder' says it's already done and offers no other (HOU-177)", async ({ page }) => {
  await login(page);
  await say(page, "remind me on Wednesday at 9 to check their opinion on BoyBoy's lunchtime nap");
  await expect(page.getByRole("status")).toContainText("I'll remind you at 09:00 Wednesday 4 November");
  await say(page, "remind me on Wednesday at 7:30 to ask at dropoff about BoyBoy's lunchtime nap");
  await expect(page.getByRole("status")).toContainText("I'll remind you at 07:30 Wednesday 4 November");
  await page.goto("/week");
  const tuesday = page.getByRole("region", { name: "Tuesday 3 November" });
  const nine = () => tuesday.locator(".ds-card").filter({ hasText: "Check their opinion on BoyBoy's lunchtime nap" });
  const seven = () => tuesday.locator(".ds-card").filter({ hasText: "Ask at dropoff about BoyBoy's lunchtime nap" });
  await expect(nine().getByText("09:00")).toBeVisible();
  await expect(seven().getByText("07:30")).toBeVisible();
  await evidence(page, "HOU-177-week-both");

  await nine().getByRole("button", { name: "Done" }).click();
  await expect(nine()).toHaveCount(0);
  // Not just hidden on this screen: a fresh load of Week leaves it out of Tuesday as well.
  await expect(async () => {
    await page.reload();
    await expect(seven().getByText("07:30")).toBeVisible();
    await expect(nine()).toHaveCount(0);
  }).toPass();
  await evidence(page, "HOU-177-week-done");

  await say(page, "cancel the 9 o'clock BoyBoy reminder");
  await expect(page.getByRole("status")).toContainText("09:00 Wednesday 4 November: Check their opinion on BoyBoy's lunchtime nap. That's already done. Nothing was changed.");
  await expect(seven().getByText("07:30")).toBeVisible();
  await evidence(page, "HOU-177-already-done");
});
