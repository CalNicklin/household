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
  await expect(page.getByRole("status")).toContainText("Done: Discuss Wise Owls.");
  await expect(page.getByText("Discuss Wise Owls", { exact: true })).toHaveCount(0);
  await evidence(page, "HOU-172-done");
});
