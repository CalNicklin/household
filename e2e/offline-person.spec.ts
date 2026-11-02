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
  await expect.poll(() => kept(page)).toEqual(["household-views:priya"]);
  // Today's conversation is sent no-store, so it is never kept on the device.
  expect((await keptUrls(page)).some((u) => u.includes("/api/trpc/conversation"))).toBe(false);

  // HOME-6 for the same person: offline, Priya still sees the last plan.
  await ctx.setOffline(true);
  await page.reload();
  await expect(page.getByText("Hang the washing out")).toBeVisible();
  await evidence(page, "HOU-165-priya-offline-plan");
  await ctx.setOffline(false);

  // Tom signs in on the same iPad: Priya's views go, and offline he sees his plan and none of hers.
  await loginWithForm(page, "tom");
  await expect(page.getByText("Hang the washing out")).toBeVisible();
  await expect.poll(() => kept(page)).toEqual(["household-views:tom"]);
  await ctx.setOffline(true);
  await page.reload();
  await expect(page.getByText("Hang the washing out")).toBeVisible();
  await expect(page.getByText("remind me to ring the dentist")).toHaveCount(0);
  expect(await kept(page)).toEqual(["household-views:tom"]);
  await evidence(page, "HOU-165-tom-offline-none-of-priya");
  await ctx.close();
});
