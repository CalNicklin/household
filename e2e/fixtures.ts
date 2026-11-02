import { type APIRequestContext, type APIResponse, test as base, expect, type Page } from "@playwright/test";
import { z } from "zod";
import { type Stack, stack } from "./stacks.ts";

export async function json<T>(schema: z.ZodType<T>, response: APIResponse): Promise<T> {
  return schema.parse(await response.json());
}
const zJobRef = z.object({ jobId: z.string() });

export const PASSWORD = "practice";

/**
 * FB-2: signed in with the session cookie straight from /api/login, then on the home screen. The
 * form on /login is the journey only where logging in is part of it (loginWithForm, first-day.spec.ts).
 */
export async function login(page: Page, username = "priya"): Promise<void> {
  const r = await page.request.post("/api/login", { data: { username, password: PASSWORD } });
  expect(r.ok()).toBe(true);
  await page.goto("/");
}

/**
 * HOU-166: wait until the service worker controls the page. Call it before `page.route`, then open the
 * screen under test: once the worker is in charge every request goes through it, and one made while it
 * is taking over (within a moment of login) can reach the server without Playwright's route seeing it.
 */
export async function underServiceWorker(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
}

/** Log in as a person does: the form on /login, then wherever it sends you. */
export async function loginWithForm(page: Page, username = "priya"): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Name").fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

export async function api(request: APIRequestContext, username = "priya"): Promise<APIRequestContext> {
  const r = await request.post("/api/login", { data: { username, password: PASSWORD } });
  expect(r.ok()).toBe(true);
  return request;
}

/** A fresh practice household at a given practice time; waits for the morning plan. */
export async function reset(request: APIRequestContext, at = "2026-11-02T07:00:00.000Z"): Promise<void> {
  await api(request);
  const r = await request.post("/api/practice/reset", { data: { at } });
  expect(r.ok()).toBe(true);
  const { jobId } = await json(zJobRef, r);
  await waitForJob(request, jobId);
}

/** HOU-149: a brand-new house at a practice time — the people and logins only, and no plan yet. */
export async function resetEmpty(request: APIRequestContext, at = "2026-11-02T07:00:00.000Z"): Promise<void> {
  await api(request);
  const r = await request.post("/api/practice/reset", { data: { at, empty: true } });
  expect(r.ok()).toBe(true);
}

export async function waitForJob(request: APIRequestContext, jobId: string): Promise<void> {
  await expect
    .poll(async () => (await json(z.object({ status: z.string() }).nullable(), await request.get(`/api/practice/job/${jobId}`)))?.status, { intervals: [50] })
    .toMatch(/succeeded|failed/);
}

export async function phone(request: APIRequestContext, address: string): Promise<{ text: string; buttons: { label: string; data: string }[] }[]> {
  return json(z.array(z.object({ text: z.string(), buttons: z.array(z.object({ label: z.string(), data: z.string() })) })), await request.get(`/api/practice/phone?address=${address}`));
}

export async function telegram(request: APIRequestContext, body: unknown) {
  return request.post("/webhooks/telegram", { data: body, headers: { "X-Telegram-Bot-Api-Secret-Token": "practice-telegram-secret" } });
}

export async function timer(request: APIRequestContext, timerKind: string, at: string): Promise<void> {
  await request.post("/api/practice/clock", { data: { at, frozen: true } });
  const r = await request.post("/api/practice/timer", { data: { timer: timerKind, at } });
  await waitForJob(request, (await json(zJobRef, r)).jobId);
}

/** FB-4: a screenshot attached to the test as evidence for the verification line. */
export async function evidence(page: Page, name: string, options: { fullPage?: boolean } = {}): Promise<void> {
  // HOU-149: `fullPage: false` keeps only what is on screen, for "visible without scrolling".
  await page.screenshot({ path: `evidence/screenshots/${name}.png`, fullPage: options.fullPage ?? true });
  await base.info().attach(name, { path: `evidence/screenshots/${name}.png`, contentType: "image/png" });
}

/** FB-2: this worker's own stack (e2e/stacks.ts): its server, supermarket, helper and files. */
export function ownStack(): Stack {
  return stack(base.info().parallelIndex);
}

/**
 * FB-2: `page`, `request` and new contexts resolve relative URLs against this worker's own server.
 * The config sets no baseURL; this is the only place it comes from.
 */
export const test = base.extend({
  baseURL: async ({ baseURL: _unset }, use, info) => use(`http://localhost:${stack(info.parallelIndex).server}`),
});
export { expect };

/** Say something in the composer, as Priya would on the iPad. */
export async function say(page: Page, text: string): Promise<void> {
  const box = page.getByRole("textbox", { name: /tell the house|add to the backlog/i });
  await box.fill(text);
  await box.press("Enter");
}
