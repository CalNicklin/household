import { evidence, expect, login, reset, say, test, timer } from "./fixtures.ts";

test.beforeEach(async ({ request }) => reset(request));

test("[MOM-3][MOM-4] 'we're away this weekend' said on Monday: today stays normal, Saturday and Sunday show as away on Week (HOU-156)", async ({ page }) => {
  await login(page);
  await say(page, "we're away this weekend");
  await expect(page.getByRole("status")).toContainText("Saturday 7 November to Sunday 8 November");
  await expect(page.getByText("If you do one thing")).toHaveCount(0);
  await expect(page.getByText("Hang the washing out")).toBeVisible();
  await evidence(page, "HOU-156-today-still-normal");
  await page.goto("/week");
  const friday = page.getByRole("region", { name: "Friday 6 November" });
  await expect(friday.getByText("Away", { exact: true })).toHaveCount(0);
  for (const day of ["Saturday 7 November", "Sunday 8 November"]) {
    const region = page.getByRole("region", { name: day });
    await expect(region.getByText("Away", { exact: true })).toBeVisible();
    await expect(region.getByText(/the app's own suggestions are hidden/)).toBeVisible();
  }
  await expect(page.getByRole("region", { name: "Sunday 8 November" }).getByText("Away until midnight; the app's own suggestions are hidden")).toBeVisible();
  await page.getByRole("region", { name: "Saturday 7 November" }).scrollIntoViewIfNeeded();
  await evidence(page, "HOU-156-week-weekend-away", { fullPage: false });
});

test("[MOM-1][MOM-4] a slow day set ahead for Friday is a slow day when Friday comes, and Saturday is normal (HOU-156)", async ({ page, request }) => {
  await login(page);
  await say(page, "slow day on Friday");
  await expect(page.getByRole("status")).toContainText("Friday 6 November");
  await timer(request, "morning-plan", "2026-11-06T05:30:00.000Z");
  await request.post("/api/practice/clock", { data: { at: "2026-11-06T07:00:00.000Z" } });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Friday 6 November" })).toBeVisible();
  await expect(page.getByText("If you do one thing")).toBeVisible();
  await expect(page.getByText(/Slow day · Priya said so on Monday/)).toBeVisible();
  await evidence(page, "HOU-156-friday-slow-day");
  await timer(request, "morning-plan", "2026-11-07T05:30:00.000Z");
  await request.post("/api/practice/clock", { data: { at: "2026-11-07T07:00:00.000Z" } });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Saturday 7 November" })).toBeVisible();
  await expect(page.getByText("If you do one thing")).toHaveCount(0);
});
