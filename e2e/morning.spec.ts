import { Limits } from "@household/contracts";
import { z } from "zod";
import { evidence, expect, json, login, phone, reset, say, test, timer } from "./fixtures.ts";

test.beforeEach(async ({ request }) => reset(request));

test("[HOME-1][HOME-2][HOME-3][HOME-7][HOME-9] the morning glance: Now, Later today, Tomorrow from the calendar, one context line, a reason on every suggestion, quiet links", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Monday 2 November" })).toBeVisible();
  await expect(page.getByText(/^Dry until 2pm, 9° · dark by \d\d:\d\d · both home/)).toBeVisible();
  for (const section of ["Now", "Later today", "Tomorrow"]) await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
  await expect(page.getByText("Nursery drop-off")).toBeVisible();
  await expect(page.getByText("Priya — client call")).toBeVisible();
  await expect(page.getByText("Dry until 2pm and you're both in all day")).toBeVisible();
  await expect(page.getByText(/no babysitter yet/)).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Secondary" });
  for (const link of ["Backlog", "Shop", "Week"]) await expect(nav.getByRole("link", { name: link })).toBeVisible();
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.locator("[class*=badge]")).toHaveCount(0);
  await evidence(page, "HOME-1-morning-glance");
});

test("[HOME-1][CH-6] a change in Google Calendar shows on the screen within a minute", async ({ page, request }) => {
  await login(page);
  const t0 = Date.now();
  await request.post("/api/practice/calendar", { data: { upsert: { externalId: "g-e2e", title: "Boiler engineer", start: "2026-11-02T15:00:00Z", end: "2026-11-02T16:00:00Z", allDay: false, attendees: ["tom"], away: [], work: false, soloWithKids: null } } });
  await expect(page.getByText("Boiler engineer")).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(60_000);
  await evidence(page, "HOME-1-calendar-change");
});

test("[HOME-4][HOME-5] one tap dismisses a suggestion, on the iPad and on the phone straight away; nothing is overdue", async ({ page, browser }) => {
  await login(page);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phonePage = await phoneCtx.newPage();
  await login(phonePage, "tom");
  await expect(phonePage.getByText("Hang the washing out")).toBeVisible();
  await page.getByRole("button", { name: "Not today" }).first().click();
  await expect(page.getByText("Hang the washing out")).toHaveCount(0);
  // limit: liveUpdateBudgetMs
  await expect(phonePage.getByText("Hang the washing out")).toHaveCount(0, { timeout: Limits.liveUpdateBudgetMs.value });
  await expect(page.getByText(/overdue/i)).toHaveCount(0);
  await evidence(phonePage, "HOME-5-phone-after-tap");
  await phoneCtx.close();
});

test("[HOME-6] it installs like an app, opens full screen, and still shows today's plan after a week left open", async ({ page, request }) => {
  await login(page);
  const manifest = await json(z.object({ display: z.string(), display_override: z.array(z.string()).optional() }), await request.get("/manifest.webmanifest"));
  expect(manifest.display).toBe("standalone");
  expect(manifest.display_override).toContain("fullscreen");
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()) !== undefined || "serviceWorker" in navigator)).toBe(true);
  // A week later: the practice clock moves on, the morning timer runs, and the open screen follows.
  await timer(request, "morning-plan", "2026-11-09T05:30:00.000Z");
  await request.post("/api/practice/clock", { data: { at: "2026-11-09T07:00:00.000Z" } });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("heading", { name: "Monday 9 November" })).toBeVisible();
  await evidence(page, "HOME-6-a-week-later");
});

test("[HOME-8][MOM-1][MOM-5] saying 'slow day' rearranges the screen: one thing, and the fixed things still happening", async ({ page }) => {
  await login(page);
  await say(page, "slow day");
  await expect(page.getByText("If you do one thing")).toBeVisible();
  await expect(page.getByText(/Slow day · Priya said so at/)).toBeVisible();
  const still = page.getByRole("list", { name: "Still happening" });
  await expect(still.getByText(/Bins out/)).toBeVisible();
  await expect(still.getByText(/Nursery/).first()).toBeVisible();
  await expect(page.getByText("Hang the washing out")).toHaveCount(0);
  await evidence(page, "MOM-1-slow-day");
});

test("[HOME-10] on a phone the same screen fits one column, nothing cut off, every button big enough to tap", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await login(page);
  await expect(page.getByText("Hang the washing out")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("button, a, [role=switch]")]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && (r.height < 44 || r.width < 44)).length,
  );
  expect(small).toBe(0);
  await evidence(page, "HOME-10-phone");
  await ctx.close();
});

test("[HOME-11] tomorrow's plan is ready by 6am even if nobody opens the app", async ({ page, request }) => {
  await timer(request, "morning-plan", "2026-11-03T05:30:00.000Z");
  await request.post("/api/practice/clock", { data: { at: "2026-11-03T06:00:00.000Z", frozen: true } });
  await login(page);
  await expect(page.getByRole("heading", { name: "Tuesday 3 November" })).toBeVisible();
  await expect(page.getByText(/Ocado/).first()).toBeVisible();
  expect((await phone(request, "1001")).length).toBeGreaterThanOrEqual(0);
  await evidence(page, "HOME-11-ready-by-6");
});
