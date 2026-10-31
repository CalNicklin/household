import { Limits } from "@household/contracts";
import { evidence, expect, login, phone, reset, say, telegram, test, timer } from "./fixtures.ts";

test.beforeEach(async ({ request }) => reset(request));

const sentences = (s: string) => s.split(/(?<=[.!?])\s+/).filter((x) => x.trim() !== "").length;

test("[MOM-2][MOM-9] 'if I do one thing, what should it be?' gets one answer with a reason: not a list, not a question, at most three sentences", async ({ page }) => {
  await login(page);
  await say(page, "if I do one thing, what should it be?");
  const reply = page.getByRole("status");
  await expect(reply).toContainText(/babysitter|Jess|Dinner/);
  const text = (await reply.textContent()) ?? "";
  expect(text).not.toContain("?");
  expect(sentences(text)).toBeLessThanOrEqual(3);
  await evidence(page, "MOM-2-one-thing");
});

test("[MOM-3][MOM-1] slow day set on a phone (Telegram) shows on the iPad within two seconds", async ({ page, request }) => {
  await login(page);
  await expect(page.getByText("Hang the washing out")).toBeVisible();
  const t0 = Date.now();
  await telegram(request, { update_id: 8001, message: { chat: { id: 1002 }, from: { id: 1002 }, text: "slow day" } });
  // limit: liveUpdateBudgetMs
  await expect(page.getByText("If you do one thing")).toBeVisible({ timeout: Limits.liveUpdateBudgetMs.value });
  expect(Date.now() - t0).toBeLessThan(Limits.liveUpdateBudgetMs.value);
  await expect(page.getByText(/Slow day · Tom said so/)).toBeVisible();
  await evidence(page, "MOM-3-slow-day-from-phone");
});

test("[MOM-4] a slow day ends at midnight unless you extend it; the next morning is normal", async ({ page, request }) => {
  await login(page);
  await say(page, "slow day");
  await expect(page.getByText("If you do one thing")).toBeVisible();
  await timer(request, "morning-plan", "2026-11-03T05:30:00.000Z");
  await request.post("/api/practice/clock", { data: { at: "2026-11-03T07:00:00.000Z" } });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Tuesday 3 November" })).toBeVisible();
  await expect(page.getByText("If you do one thing")).toHaveCount(0);
  await evidence(page, "MOM-4-next-morning-normal");
});

test("[MOM-6][MOM-7] tap an item and say 'Tom can do it': it moves to Tom, who gets one message", async ({ page, request }) => {
  await login(page);
  const before = (await phone(request, "1002")).length;
  await page.getByText("Hang the washing out").click();
  await expect(page.getByText(/About: Hang the washing out/)).toBeVisible();
  await say(page, "Tom can do it");
  await expect(page.getByText("Hang the washing out", { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await phone(request, "1002")).length).toBe(before + 1);
  expect((await phone(request, "1002")).at(-1)?.text).toContain("Hang the washing out");
  await evidence(page, "MOM-6-handed-to-tom");
});

test("[MOM-7] tap anything and 'move this to tomorrow' works without saying what 'this' is", async ({ page }) => {
  await login(page);
  await page.getByText("Bins out").click();
  await say(page, "move this to tomorrow");
  await expect(page.getByRole("status")).toContainText("Bins out");
  await expect(page.getByText("Bins out", { exact: true })).toHaveCount(0);
  await evidence(page, "MOM-7-move-this");
});

test("[MOM-8] talking works the same as typing", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeRecognition extends EventTarget {
      lang = "en-GB";
      interimResults = false;
      continuous = false;
      start() {
        setTimeout(() => {
          this.dispatchEvent(Object.assign(new Event("result"), { results: [[{ transcript: "we're out of bananas" }]], resultIndex: 0 }));
          this.dispatchEvent(new Event("end"));
        }, 50);
      }
      stop() {}
      abort() {}
    }
    Object.assign(window, { SpeechRecognition: FakeRecognition, webkitSpeechRecognition: FakeRecognition });
  });
  await login(page);
  await page.getByRole("button", { name: "Talk" }).click();
  await expect(page.getByRole("status")).toContainText(/bananas/);
  await evidence(page, "MOM-8-talking");
});
