import type { Page } from "@playwright/test";
import { evidence, expect, login, loginWithForm, reset, say, test } from "./fixtures.ts";

/**
 * HOU-165: offline views are per person. Priya and Tom share the kitchen iPad: what the worker kept
 * for Priya is never what Tom sees, online or off, and her own plan still shows offline (HOME-6).
 */
const kept = (page: Page) => page.evaluate(() => caches.keys().then((keys) => keys.filter((k) => k.startsWith("household-views:"))));
const keptUrls = (page: Page) =>
  page.evaluate(async () => {
    const urls: string[] = [];
    for (const k of await caches.keys()) if (k.startsWith("household-views:")) for (const r of await (await caches.open(k)).keys()) urls.push(r.url);
    return urls;
  });

test("[HOME-6] (HOU-165) on a shared iPad one person's offline views never show to the other, and each still sees the last plan offline", async ({ browser, request, baseURL }) => {
  await reset(request);
  const ctx = await browser.newContext(baseURL === undefined ? {} : { baseURL });
  const page = await ctx.newPage();

  // Priya, with the worker in charge, says something: her conversation is hers alone.
  await login(page, "priya");
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await page.reload();
  await expect(page.getByText("Hang the washing out")).toBeVisible();
  await say(page, "remind me to ring the dentist");
  await expect(page.getByText("“remind me to ring the dentist”")).toBeVisible();
  // She also looks at the week; Tom never does, so only her copy of it could ever be on the iPad.
  await page.goto("/week");
  await expect.poll(async () => (await keptUrls(page)).find((u) => u.includes("/api/trpc/week"))).toBeTruthy();
  const week = (await keptUrls(page)).find((u) => u.includes("/api/trpc/week")) ?? "";
  await page.goto("/");
  await expect.poll(() => kept(page)).toEqual(["household-views:priya"]);
  // Today's conversation is sent no-store, so it is never kept on the device.
  expect((await keptUrls(page)).some((u) => u.includes("/api/trpc/conversation"))).toBe(false);

  // HOME-6 for the same person: offline, Priya still sees the last plan.
  await ctx.setOffline(true);
  await page.reload();
  await expect(page.getByText("Hang the washing out")).toBeVisible();
  await evidence(page, "HOU-165-priya-offline-plan");
  await ctx.setOffline(false);

  // Tom signs in on the same iPad, on a page the worker doesn't control (as after a hard reload), so the
  // worker never sees his login: Priya's views still go, and offline he sees his plan and none of hers.
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.unregister()));
  // (Routing /sw.js would also take the worker's own fetches past setOffline, so registering is held off instead.)
  await page.addInitScript(() => {
    if (sessionStorage.getItem("no-worker") === "1") ServiceWorkerContainer.prototype.register = () => new Promise(() => {});
  });
  await page.evaluate(() => sessionStorage.setItem("no-worker", "1"));
  await loginWithForm(page, "tom");
  expect(await page.evaluate(() => navigator.serviceWorker.controller === null)).toBe(true);
  expect(await kept(page)).not.toContain("household-views:priya");
  await page.evaluate(() => sessionStorage.removeItem("no-worker"));
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await page.reload();
  await expect(page.getByText("Hang the washing out")).toBeVisible();
  await expect.poll(() => kept(page)).toEqual(["household-views:tom"]);
  await ctx.setOffline(true);
  await page.reload();
  await expect(page.getByText("Hang the washing out")).toBeVisible();
  await expect(page.getByText("remind me to ring the dentist")).toHaveCount(0);
  expect(await kept(page)).toEqual(["household-views:tom"]);
  // Priya's week is not served to Tom offline: with no copy of his own, there is no answer at all.
  expect(await page.evaluate((url) => fetch(url).then(() => "answered", () => "none"), week)).toBe("none");
  await evidence(page, "HOU-165-tom-offline-none-of-priya");
  await ctx.close();
});
