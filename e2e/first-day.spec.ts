import type { Browser, Page } from "@playwright/test";
import { evidence, expect, login, loginWithForm, reset, resetEmpty, say, test } from "./fixtures.ts";

/** HOU-149: the kitchen iPad and a phone, the two sizes the home screen has to work at. */
const SIZES = {
  ipad: { viewport: { width: 1180, height: 820 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} as const;

async function open(browser: Browser, size: keyof typeof SIZES, baseURL: string | undefined): Promise<Page> {
  const ctx = await browser.newContext({ ...SIZES[size], ...(baseURL === undefined ? {} : { baseURL }) });
  const page = await ctx.newPage();
  await loginWithForm(page);
  return page;
}

/** The answer sits next to the composer and is wholly on screen, with the page not scrolled. */
async function answerInView(page: Page, title: RegExp | string): Promise<void> {
  const answer = page.getByRole("status", { name: "The house's answer" });
  await expect(answer.getByText("The one thing")).toBeVisible();
  await expect(answer).toContainText(title);
  await expect(answer).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("textbox", { name: /tell the house/i })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const text = (await answer.textContent()) ?? "";
  expect(text).not.toContain("?");
}

for (const size of ["ipad", "phone"] as const) {
  test(`[HOME-1][HOME-3][HOME-4] (HOU-149) a fresh, empty house is never blank: today's plan is made when you look, and it shows how to start (${size})`, async ({ browser, request, baseURL }) => {
    await resetEmpty(request);
    const page = await open(browser, size, baseURL);
    await expect(page.getByRole("heading", { name: "Monday 2 November" })).toBeVisible();
    // No timer has run: the screen asked, a catch-up plan job made today's plan, and it arrived live.
    const start = page.getByRole("region", { name: "Getting started" });
    await expect(start.getByText("Say a few jobs into the box below")).toBeVisible();
    await expect(start.getByText("Calendars aren't connected yet")).toBeVisible();
    await expect(start.getByText("Ask “if I do one thing, what should it be?”")).toBeVisible();
    await expect(start.getByText(/The backlog is empty/)).toBeVisible();
    await expect(start.getByRole("button", { name: "Not now" })).toHaveCount(3);
    await expect(page.getByText(/plan together now/)).toHaveCount(0);
    await evidence(page, `HOU-149-empty-house-home-${size}`);
    await page.context().close();
  });

  test(`[MOM-2][MOM-9] (HOU-149) on an empty house, 'what should I prioritise today?' shows one answer next to the composer without scrolling (${size})`, async ({ browser, request, baseURL }) => {
    await resetEmpty(request);
    const page = await open(browser, size, baseURL);
    await expect(page.getByText("Say a few jobs into the box below")).toBeVisible();
    await say(page, "what should I prioritise today?");
    // Monday morning is dry and nobody is known to be out, so the washing rule is the one thing.
    await answerInView(page, "Hang the washing out");
    await evidence(page, `HOU-149-empty-house-answer-${size}`, { fullPage: false });
    await page.context().close();
  });

  test(`[MOM-2][MOM-9] (HOU-149) in the practice household, 'what should I prioritise today?' shows its answer next to the composer without scrolling (${size})`, async ({ browser, request, baseURL }) => {
    await reset(request);
    const page = await open(browser, size, baseURL);
    await expect(page.getByText("Hang the washing out")).toBeVisible();
    await say(page, "what should I prioritise today?");
    await answerInView(page, /babysitter|Jess|Dinner/);
    await evidence(page, `HOU-149-practice-answer-${size}`, { fullPage: false });
    await page.context().close();
  });
}

test("[MOM-2] (HOU-149) the answer has a no-guilt dismiss", async ({ page, request }) => {
  await reset(request);
  await login(page);
  await say(page, "if I do one thing, what should it be?");
  const answer = page.getByRole("status", { name: "The house's answer" });
  await expect(answer.getByText("The one thing")).toBeVisible();
  await answer.getByRole("button", { name: "Hide this answer" }).click();
  await expect(answer).toHaveCount(0);
});
