import { evidence, expect, login, phone, reset, telegram, test, timer } from "./fixtures.ts";

test.beforeEach(async ({ request }) => reset(request));

test("[PRO-1][PRO-8] both out with no sitter: a warning from a week before, and a reminder to message a named sitter five days before", async ({ page, request }) => {
  // Theatre on Thursday 12 November: a week before is Thursday 5th, five days before is Saturday 7th.
  await timer(request, "morning-plan", "2026-11-04T05:30:00.000Z");
  await request.post("/api/practice/clock", { data: { at: "2026-11-04T08:00:00.000Z" } });
  await login(page);
  await expect(page.getByText(/both out Thursday/)).toHaveCount(0);
  await timer(request, "morning-plan", "2026-11-05T05:30:00.000Z");
  await request.post("/api/practice/clock", { data: { at: "2026-11-05T08:00:00.000Z" } });
  await page.reload();
  const warning = page.getByText(/You're both out Thursday at 19:00 — no babysitter yet/);
  await expect(warning).toBeVisible();
  // PRO-8: it is a rule, so it is amber.
  const bg = await warning.locator("xpath=ancestor::*[contains(concat(' ', @class, ' '), ' ds-card--alert ')][1]").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(251, 241, 220)");
  await timer(request, "hourly-refresh", "2026-11-07T09:00:00.000Z");
  const msgs = [...(await phone(request, "1001")), ...(await phone(request, "1002"))].filter((m) => m.text.includes("12 November"));
  expect(msgs).toHaveLength(1);
  expect(msgs[0]?.text).toMatch(/Message (Jess|Marta)\?/);
  await evidence(page, "PRO-1-sitter-warning");
});

test("[PRO-2] replying 'Jess's doing Tuesday' makes the warning disappear everywhere", async ({ page, request }) => {
  await login(page);
  await expect(page.getByText(/no babysitter yet/)).toBeVisible();
  await telegram(request, { update_id: 9001, message: { chat: { id: 1002 }, from: { id: 1002 }, text: "Jess's doing Tuesday" } });
  await expect(page.getByText(/no babysitter yet/)).toHaveCount(0);
  await evidence(page, "PRO-2-sitter-booked");
});

test("[PRO-3] the right bins appear under Later today the evening before, and whoever is home gets a 7pm message", async ({ page, request }) => {
  await login(page);
  const later = page.getByRole("region", { name: "Later today" });
  await expect(later.getByText("Bins out")).toBeVisible();
  await expect(later.getByText(/recycling \+ food, collected Tuesday/)).toBeVisible();
  await timer(request, "bins-7pm", "2026-11-02T19:00:00.000Z");
  for (const address of ["1001", "1002"]) expect((await phone(request, address)).filter((m) => m.text.startsWith("Bins out tonight"))).toHaveLength(1);
  await evidence(page, "PRO-3-bins");
});

test("[PRO-4] a dry morning with someone home brings a washing suggestion on the screen, never a message", async ({ page, request }) => {
  await login(page);
  await expect(page.getByText("Hang the washing out")).toBeVisible();
  await expect(page.getByText("Dry until 2pm and you're both in all day")).toBeVisible();
  await timer(request, "hourly-refresh", "2026-11-02T09:00:00.000Z");
  for (const address of ["1001", "1002"]) expect((await phone(request, address)).some((m) => /wash/i.test(m.text))).toBe(false);
  await evidence(page, "PRO-4-washing");
});

test("[PRO-5] a delivery that needs someone in brings a message that morning; one that can be left does not", async ({ request }) => {
  await timer(request, "delivery-morning", "2026-11-02T07:30:00.000Z");
  expect([...(await phone(request, "1001")), ...(await phone(request, "1002"))].some((m) => m.text.includes("Screwfix"))).toBe(false);
  await timer(request, "delivery-morning", "2026-11-03T07:30:00.000Z");
  expect((await phone(request, "1001")).some((m) => m.text.startsWith("Ocado delivery today"))).toBe(true);
});

test("[PRO-6] at most one backlog item a day, and only once", async ({ page, request }) => {
  await login(page);
  const picks = page.getByRole("region", { name: "Could fit this week" }).getByRole("button", { name: "Pencil it in" });
  await expect(picks).toHaveCount(1);
  const first = await page.getByRole("region", { name: "Could fit this week" }).textContent();
  await timer(request, "hourly-refresh", "2026-11-02T10:00:00.000Z");
  await page.reload();
  expect(await page.getByRole("region", { name: "Could fit this week" }).textContent()).toBe(first);
  await timer(request, "morning-plan", "2026-11-03T05:30:00.000Z");
  await request.post("/api/practice/clock", { data: { at: "2026-11-03T07:00:00.000Z" } });
  await page.reload();
  const second = await page.getByRole("region", { name: "Could fit this week" }).textContent();
  expect(second).not.toBe(first);
  await evidence(page, "PRO-6-one-a-day");
});

test("[PRO-7] each of us sets a message limit and quiet hours; anything over waits for the morning screen", async ({ page, request }) => {
  await login(page);
  await page.goto("/settings");
  await expect(page.getByRole("group", { name: /messages a day/i })).toContainText("3");
  await expect(page.getByText(/21:00|9pm/).first()).toBeVisible();
  const less = page.getByRole("button", { name: "Less messages a day" });
  await less.click();
  await expect(page.getByRole("group", { name: /messages a day/i })).toContainText("2");
  await less.click();
  await expect(page.getByRole("group", { name: /messages a day/i })).toContainText("1");
  await evidence(page, "PRO-7-settings");
  // Two messages for Priya on Monday: the basket summary at 6pm uses her one, so the 7pm bins waits for the morning screen.
  await timer(request, "basket-summary", "2026-11-02T18:00:00.000Z");
  await timer(request, "bins-7pm", "2026-11-02T19:00:00.000Z");
  expect((await phone(request, "1001")).filter((m) => m.text.startsWith("Bins out tonight"))).toHaveLength(0);
  expect((await phone(request, "1002")).filter((m) => m.text.startsWith("Bins out tonight"))).toHaveLength(1);
  await timer(request, "morning-plan", "2026-11-03T05:30:00.000Z");
  await request.post("/api/practice/clock", { data: { at: "2026-11-03T07:00:00.000Z" } });
  await page.goto("/");
  await expect(page.getByText(/^For Priya:/).first()).toBeVisible();
});

test("[PRO-9] dismiss a message on your phone and it is dismissed everywhere; nothing is shown twice", async ({ page, request }) => {
  await timer(request, "bins-7pm", "2026-11-02T19:00:00.000Z");
  const msg = (await phone(request, "1001")).find((m) => m.text.startsWith("Bins out tonight"));
  const button = msg?.buttons[0];
  expect(button?.label).toBe("Done");
  await login(page);
  await expect(page.getByText("Bins out").first()).toBeVisible();
  await telegram(request, { update_id: 9101, callback_query: { id: "cq-e2e", from: { id: 1001 }, message: { chat: { id: 1001 } }, data: button?.data } });
  await expect(page.getByText("Bins out", { exact: true })).toHaveCount(0);
  await timer(request, "hourly-refresh", "2026-11-02T20:00:00.000Z");
  expect((await phone(request, "1001")).filter((m) => m.text.startsWith("Bins out tonight"))).toHaveLength(1);
  await evidence(page, "PRO-9-dismissed-everywhere");
});

test("[PRO-10] nursery inset days show under Tomorrow the day before, with a warning when nobody is covering", async ({ page, request }) => {
  await timer(request, "morning-plan", "2026-11-05T05:30:00.000Z");
  await request.post("/api/practice/clock", { data: { at: "2026-11-05T07:00:00.000Z" } });
  await login(page);
  await expect(page.getByRole("region", { name: "Tomorrow" }).getByText("Nursery inset day tomorrow — nobody is covering yet")).toBeVisible();
  await evidence(page, "PRO-10-inset-tomorrow");
});
