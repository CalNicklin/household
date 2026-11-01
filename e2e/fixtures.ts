import { type APIRequestContext, type APIResponse, test as base, expect, type Page } from "@playwright/test";
import { z } from "zod";
import { type Stack, stack } from "./stacks.ts";

export async function json<T>(schema: z.ZodType<T>, response: APIResponse): Promise<T> {
  return schema.parse(await response.json());
}
const zJobRef = z.object({ jobId: z.string() });

export const PASSWORD = "practice";

export async function login(page: Page, username = "priya"): Promise<void> {
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

export async function waitForJob(request: APIRequestContext, jobId: string): Promise<void> {
  await expect
    .poll(async () => (await json(z.object({ status: z.string() }).nullable(), await request.get(`/api/practice/job/${jobId}`)))?.status, { intervals: [100, 200, 500] })
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
export async function evidence(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `evidence/screenshots/${name}.png`, fullPage: true });
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
