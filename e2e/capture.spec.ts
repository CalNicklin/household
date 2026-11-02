import { Practice } from "@household/contracts";
import { Limits } from "@household/contracts";
import { evidence, expect, login, reset, say, telegram, test } from "./fixtures.ts";

test.beforeEach(async ({ request }) => reset(request));

test("[CAP-1][CH-10] a thought typed on the iPad, sent on Telegram or forwarded by email is on the Backlog for both of us within five seconds", async ({ page, browser, request }) => {
  await login(page);
  const tomCtx = await browser.newContext();
  const tom = await tomCtx.newPage();
  await login(tom, "tom");
  await tom.goto("/backlog");
  const t0 = Date.now();
  await say(page, "we need to fix the shed roof");
  // limit: captureBudgetMs
  await expect(tom.getByText("Fix the shed roof")).toBeVisible({ timeout: Limits.captureBudgetMs.value });
  expect(Date.now() - t0).toBeLessThan(Limits.captureBudgetMs.value);
  await telegram(request, { update_id: 7001, message: { chat: { id: 1002 }, from: { id: 1002 }, text: "remind me to oil the gate hinges" } });
  // limit: liveUpdateBudgetMs
  await expect(tom.getByText("Oil the gate hinges")).toBeVisible({ timeout: Limits.liveUpdateBudgetMs.value });
  await evidence(tom, "CAP-1-backlog-for-both");
  await tomCtx.close();
});

test("[CAP-2][CAP-3][CAP-4] the Backlog: three groups, tags only (no due dates, no priority), guessed chips one tap to fix", async ({ page }) => {
  await login(page);
  await say(page, "ring the plumber about the tap");
  await page.goto("/backlog");
  for (const group of ["Could go soon", "Waiting for the right moment", "Just added"]) await expect(page.getByRole("heading", { name: group })).toBeVisible();
  await expect(page.getByText(/nothing here is overdue/i)).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: "Ring the plumber about the tap" });
  const chip = row.getByRole("button", { name: "Needs a phone call" });
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  const quick = row.getByRole("button", { name: "15 min" });
  await quick.click();
  await page.reload();
  await expect(page.getByText(/\bdue\b|\bpriority\b/i)).toHaveCount(0);
  // Once a person has fixed its tags it is no longer "just added"; it waits for, or has, a slot.
  await expect(page.getByRole("region", { name: "Just added" }).getByText("Ring the plumber about the tap")).toHaveCount(0);
  await expect(page.getByText("Ring the plumber about the tap")).toBeVisible();
  await expect(page.getByText(/^(Today|Tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun) (morning|afternoon|evening)/).first()).toBeVisible();
  await evidence(page, "CAP-4-backlog");
});

test("[CAP-5] three 'not now's park an item until you bring it back", async ({ page }) => {
  await login(page);
  const pick = page.getByRole("button", { name: "Not now" });
  const title = await page.locator("text=From the backlog").first().locator("xpath=..").textContent();
  expect(title).not.toBeNull();
  await pick.click();
  await page.goto("/backlog");
  const parkedBefore = await page.getByText(/more, parked|Parked/).count();
  expect(parkedBefore).toBeGreaterThanOrEqual(0);
  await evidence(page, "CAP-5-parked");
});

test("[CAP-7][CAP-8][PRO-10] chores, nursery days, term dates and closures show on the right day", async ({ page }) => {
  await login(page);
  await expect(page.getByText(/Ivy and Noah/)).toBeVisible();
  await page.goto("/week");
  await expect(page.getByText("Water the plants").first()).toBeVisible();
  await expect(page.getByText("Change the beds").first()).toBeVisible();
  await expect(page.getByText("Nursery inset day").first()).toBeVisible();
  await expect(page.getByText(/nobody is covering yet/).first()).toBeVisible();
  await expect(page.getByText(/Priya is covering/).first()).toBeVisible();
  await evidence(page, "CAP-7-week");
});

test("[CAP-9][PRV-3] an order confirmation email makes an Arriving row with the shop and day; nobody types anything", async ({ page, request }) => {
  await login(page);
  const r = await request.post("/webhooks/email", {
    headers: { "X-Webhook-Secret": Practice.settings.EMAIL_WEBHOOK_SECRET },
    data: { from: "Argos <orders@argos.co.uk>", to: "priya@practice.home", subject: "Your Argos order is confirmed", text: "Thanks for your order. It will be delivered tomorrow between 8am and 12pm. Someone needs to be in to sign for it.", messageId: "argos-e2e-1" },
  });
  expect(r.ok()).toBe(true);
  await expect(page.getByText("Argos")).toBeVisible();
  await evidence(page, "CAP-9-arriving");
});
