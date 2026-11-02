import type { Browser, Page } from "@playwright/test";
import { evidence, expect, login, reset, test } from "./fixtures.ts";

/**
 * HOU-159: talking to the house from any screen: a Send button, a mic that says what it is doing,
 * and today's conversation above the composer. At the kitchen iPad's size and a phone's.
 */
const SIZES = {
  ipad: { viewport: { width: 1180, height: 820 } },
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true },
} as const;

async function open(browser: Browser, size: keyof typeof SIZES, baseURL: string | undefined, init?: () => void): Promise<Page> {
  const ctx = await browser.newContext({ ...SIZES[size], ...(baseURL === undefined ? {} : { baseURL }) });
  const page = await ctx.newPage();
  if (init !== undefined) await page.addInitScript(init);
  await login(page);
  return page;
}

/** The same journeys run in Chromium and WebKit; each engine's screenshots keep their own names. */
const engine = () => (test.info().project.name === "ipad" ? "" : `-${test.info().project.name}`);
const box = (page: Page) => page.getByRole("textbox", { name: /tell the house|ask the house/i });
const conversation = (page: Page) => page.getByRole("region", { name: "Today with the house" });
const answer = (page: Page) => page.getByRole("status", { name: "The house's answer" });

/** Type, then tap the Send button (not the keyboard's return key). */
async function typeAndSend(page: Page, text: string): Promise<void> {
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
  await box(page).fill(text);
  // With text in the box the mic gives way to Send.
  await expect(page.getByRole("button", { name: "Talk" })).toHaveCount(0);
  const send = page.getByRole("button", { name: "Send" });
  const size = await send.boundingBox();
  expect(size?.width).toBeGreaterThanOrEqual(44);
  expect(size?.height).toBeGreaterThanOrEqual(44);
  await send.click();
  await expect(box(page)).toHaveValue("");
  await expect(page.getByRole("button", { name: "Talk" })).toBeVisible();
}

for (const size of ["ipad", "phone"] as const) {
  test(`[MOM-2][MOM-8] (HOU-159) type and send with the button, ask what to prioritise and see the answer, ask a follow-up and see both exchanges (${size})`, async ({ browser, request, baseURL }) => {
    await reset(request);
    const page = await open(browser, size, baseURL);
    await typeAndSend(page, "what should I prioritise today?");
    // What you said shows straight away, and the answer lands right where you are looking.
    await expect(conversation(page).getByText("“what should I prioritise today?”")).toBeVisible();
    await expect(answer(page).getByText("The one thing")).toBeVisible();
    await expect(answer(page)).toContainText(/babysitter|Jess|Dinner/);
    await expect(answer(page)).toBeInViewport({ ratio: 1 });
    await evidence(page, `HOU-159-answer-${size}${engine()}`, { fullPage: false });

    await typeAndSend(page, "what's happening today?");
    await expect(conversation(page).getByText("“what's happening today?”")).toBeVisible();
    await expect(answer(page).getByText("From the house")).toBeVisible();
    // Both exchanges, oldest first: the first question is still there above the newest answer.
    const said = conversation(page).getByText(/”$/);
    await expect(said).toHaveText(["You said: “what should I prioritise today?”", "You said: “what's happening today?”"]);
    await expect(conversation(page)).toContainText(/babysitter|Jess|Dinner/);
    await expect(answer(page)).toBeInViewport({ ratio: 1 });
    await expect(box(page)).toBeInViewport({ ratio: 1 });
    await evidence(page, `HOU-159-follow-up-${size}${engine()}`, { fullPage: false });

    // Collapsible: hiding it leaves one quiet link that opens it again.
    await answer(page).getByRole("button", { name: "Hide this answer" }).click();
    await expect(conversation(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Today with the house · 2" }).click();
    await expect(conversation(page).getByText(/”$/)).toHaveCount(2);
    await page.context().close();
  });

  test(`[MOM-8] (HOU-159) the conversation and an ask-or-tell placeholder are on every screen with a composer (${size})`, async ({ browser, request, baseURL }) => {
    await reset(request);
    const page = await open(browser, size, baseURL);
    await typeAndSend(page, "what should I prioritise today?");
    await expect(answer(page).getByText("The one thing")).toBeVisible();
    for (const [path, placeholder] of [
      ["/lists", "Add to a list, or ask the house anything"],
      ["/shop", "Add to the shop, or ask the house anything"],
      ["/backlog", "Dump a job here, or ask the house anything"],
      ["/week", "Tell me something, or ask"],
    ] as const) {
      await page.goto(path);
      await expect(box(page)).toHaveAttribute("placeholder", placeholder);
      // A fresh screen shows the conversation folded away; one tap opens it.
      await page.getByRole("button", { name: "Today with the house · 1" }).click();
      await expect(conversation(page).getByText("“what should I prioritise today?”")).toBeVisible();
    }
    // A question asked on Lists is answered on Lists, above the composer.
    await page.goto("/lists");
    await typeAndSend(page, "what's happening today?");
    await expect(answer(page).getByText("From the house")).toBeVisible();
    await expect(answer(page)).toBeInViewport({ ratio: 1 });
    await evidence(page, `HOU-159-lists-${size}${engine()}`, { fullPage: false });
    await page.context().close();
  });

  test(`[MOM-8] (HOU-159) the mic shows Listening…, and says plainly when it couldn't hear (${size})`, async ({ browser, request, baseURL }) => {
    await reset(request);
    const page = await open(browser, size, baseURL, () => {
      // A speech API that listens until told what happened, the way Safari's does.
      class FakeRecognition extends EventTarget {
        lang = "en-GB";
        interimResults = false;
        continuous = false;
        start() {
          Object.assign(window, { lastRecognition: this });
        }
        stop() {
          this.dispatchEvent(new Event("end"));
        }
        abort() {}
      }
      Object.assign(window, { SpeechRecognition: FakeRecognition, webkitSpeechRecognition: FakeRecognition });
    });
    const fail = (code: string) =>
      page.evaluate((c) => {
        const r: unknown = Reflect.get(window, "lastRecognition");
        if (!(r instanceof EventTarget)) throw new Error("not listening");
        r.dispatchEvent(Object.assign(new Event("error"), { error: c }));
        r.dispatchEvent(new Event("end"));
      }, code);

    await page.getByRole("button", { name: "Talk" }).click();
    await expect(page.getByText("Listening…")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop listening" })).toBeVisible();
    await evidence(page, `HOU-159-listening-${size}${engine()}`, { fullPage: false });
    await fail("no-speech");
    await expect(page.getByText("Couldn't hear that — try the keyboard's mic.")).toBeVisible();
    await expect(box(page)).toBeFocused();
    await evidence(page, `HOU-159-mic-error-${size}${engine()}`, { fullPage: false });

    // No permission: say so, and point at the keyboard's mic.
    await page.getByRole("button", { name: "Talk" }).click();
    await fail("not-allowed");
    await expect(page.getByText(/microphone is turned off for this app/)).toBeVisible();

    // Speech can't run here at all (Safari's answer in some home-screen apps).
    await page.getByRole("button", { name: "Talk" }).click();
    await fail("service-not-allowed");
    await expect(page.getByText(/Voice isn't available in this browser/)).toBeVisible();

    // Tapping again while listening stops quietly.
    await page.getByRole("button", { name: "Talk" }).click();
    await page.getByRole("button", { name: "Stop listening" }).click();
    await expect(page.getByText("Listening…")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Talk" })).toBeVisible();
    await page.context().close();
  });

  test(`[MOM-8] (HOU-159) with no speech API the mic focuses the box and says why (${size})`, async ({ browser, request, baseURL }) => {
    await reset(request);
    const page = await open(browser, size, baseURL, () => {
      Object.assign(window, { SpeechRecognition: undefined, webkitSpeechRecognition: undefined });
    });
    await page.getByRole("button", { name: "Talk" }).click();
    await expect(page.getByText("Voice isn't available in this browser. Tap the keyboard's mic to dictate instead.")).toBeVisible();
    await expect(box(page)).toBeFocused();
    await evidence(page, `HOU-159-no-speech-api-${size}${engine()}`, { fullPage: false });
    await page.context().close();
  });
}
