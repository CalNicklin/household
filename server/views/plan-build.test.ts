import { TimerKind } from "@household/contracts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { HttpEnv } from "../adapters/registry.ts";
import { buildId } from "../build.ts";
import { createApp } from "../http/app.ts";
import type { TestHousehold } from "../testing/household.ts";
import { householdWithApp, loginCookie } from "../testing/http.ts";
import { localDate } from "../time.ts";

let h: TestHousehold;
let app: Hono<HttpEnv>;

beforeAll(async () => {
  ({ h, app } = await householdWithApp());
});
afterAll(async () => h.close());

const today = () => localDate(h.ports.clock.now(), h.rt.timeZone);
const build = () => buildId(h.rt.env.WEB_DIST);
const catchUps = async () => (await h.rt.system("t").jobs.recentJobs()).filter((j) => j.intent === `timer:${TimerKind.catchUpPlan}`);

async function until<T>(read: () => Promise<T | null>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await read();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

describe("a deploy shows on the next reload (HOU-154)", () => {
  test("[HOME-6][PLT-1] (HOU-154) a plan records the build that made it", async () => {
    const cookie = await loginCookie(app);
    await app.request(`/api/trpc/screen?input=${encodeURIComponent("{}")}`, { headers: { cookie } });
    const plan = await until(() => h.rt.system("t").plans.latest({ date: today() }));
    expect(plan.build).toBe(build());
    // That first plan's own catch-up job, finished.
    await until(async () => ((await catchUps()).some((j) => j.status === "succeeded") ? true : null));
  });

  test("[HOME-6][PLT-1] (HOU-154) today's plan made by an older build is redone once, through a job, and not on every request", async () => {
    const before = await until(() => h.rt.system("t").plans.latest({ date: today() }));
    const earlier = (await catchUps()).length;
    // A plan the previous build made today (before builds were recorded, `build` is absent).
    const older = await h.rt.system("t").plans.save({ date: today(), blocks: before.blocks, inputs: { trigger: "older-build" }, trigger: "older-build", jobId: null });
    expect(older.build).toBeNull();
    const cookie = await loginCookie(app);
    const screen = () => app.request(`/api/trpc/screen?input=${encodeURIComponent("{}")}`, { headers: { cookie } });
    expect((await screen()).status).toBe(200);
    const redone = await until(async () => {
      const p = await h.rt.system("t").plans.latest({ date: today() });
      return p !== null && p.version > older.version ? p : null;
    });
    expect(redone.build).toBe(build());
    const jobs = await until(async () => {
      const j = await catchUps();
      return j.length === earlier + 1 && j.every((x) => x.status !== "running") ? j : null;
    });
    expect(jobs.every((j) => j.status === "succeeded")).toBe(true);
    // The redone plan is this build's: asking again, many times, starts nothing more.
    for (let i = 0; i < 3; i++) expect((await screen()).status).toBe(200);
    expect(await catchUps()).toHaveLength(earlier + 1);
    expect((await h.rt.system("t").plans.latest({ date: today() }))?.version).toBe(redone.version);
  });

  test("[HOME-6] (HOU-154) the service worker and the page are served with this build's id and never cached", async () => {
    const dist = mkdtempSync(path.join(tmpdir(), "hou-154-dist-"));
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "sw.js"), 'const BUILD = "__BUILD__";');
    writeFileSync(path.join(dist, "_shell.html"), "<html><head><title>Household</title></head><body></body></html>");
    const served = createApp({ ...h.rt, env: { ...h.rt.env, WEB_DIST: dist } }, []);
    const sw = await served.request("/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    expect(await sw.text()).toBe(`const BUILD = "${build()}";`);
    const cookie = await loginCookie(served);
    const page = await served.request("/", { headers: { cookie } });
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(await page.text()).toContain(`<meta name="household-build" content="${build()}">`);
  });
});
