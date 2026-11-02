import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensurePostgres } from "../server/testing/postgres.ts";
import { evidence, expect, login, ownStack, reset, test } from "./fixtures.ts";

/**
 * HOU-154: a deploy shows on the next reload, and an open screen picks it up by itself. This journey
 * runs its own server on a spare port of this worker's stack, and replaces it with a new build (the same
 * app with a different build id) the way a deploy does. Three builds: B reaches an untouched page by
 * itself, C on one reload. (HOU-163 sizes the pools, so its server shares Postgres with the stacks.)
 */
const root = path.resolve(import.meta.dirname, "..");
const built = path.join(root, "web", "dist", "client");

type Server = { child: ChildProcess };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Until `read` says yes; the test's own time limit is the bound. */
async function eventually(read: () => Promise<boolean>): Promise<void> {
  for (;;) {
    if (await read().catch(() => false)) return;
    await pause(250);
  }
}

const healthy = (url: string) => eventually(async () => (await fetch(`${url}/healthz`)).ok);

test("[HOME-6] (HOU-154) after a deploy one reload shows the new build, an open screen reloads itself, and offline still shows the last plan", async ({ browser }) => {
  test.setTimeout(180_000);
  const own = ownStack();
  const port = own.server + 5;
  const url = `http://localhost:${port}`;
  const pg = await ensurePostgres();
  const builds = path.join(own.dataDir, "builds");
  rmSync(builds, { recursive: true, force: true });

  const state: { running: Server | null } = { running: null };
  /** Build `name`: the web app as built, plus a marker file, so its build id is its own. */
  const deploy = async (name: string): Promise<void> => {
    if (state.running !== null) {
      const { child } = state.running;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    const dist = path.join(builds, name);
    mkdirSync(dist, { recursive: true });
    cpSync(built, dist, { recursive: true });
    writeFileSync(path.join(dist, "build.txt"), name);
    const child = spawn("node", ["server/main.ts"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: pg.url, PRACTICE: "true", PORT: String(port), DB_PREFIX: `${own.dbPrefix}deploy`, PUBLIC_URL: url, WEB_DIST: dist },
      stdio: ["ignore", "ignore", "inherit"],
    });
    state.running = { child };
    await healthy(url);
  };
  const buildOf = async (): Promise<string> => {
    const sw = await (await fetch(`${url}/sw.js`)).text();
    return /const BUILD = "([0-9a-f]+)"/.exec(sw)?.[1] ?? "";
  };

  try {
    await deploy("a");
    const a = await buildOf();
    const ctx = await browser.newContext({ baseURL: url });
    // A fresh practice household first, so the first plan is not raced by the reset.
    await reset(ctx.request);
    const page = await ctx.newPage();
    await login(page);
    const shown = page.locator('meta[name="household-build"]');
    await expect(shown).toHaveAttribute("content", a);
    await expect(page.getByText("Hang the washing out")).toBeVisible();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    // Deploy B to the page as first opened (no worker when it loaded; A's took over without a reload),
    // and nobody touches it. In the house, Caddy answers the live connection's reconnect with a 502
    // while the new server starts, and EventSource gives up on that for good; here the browser stubs
    // /api/live with that 502 until `unroute`. The next minute's check (or a glance at the screen, as
    // here) opens it again, finds the new worker, and the page reloads itself: once, not in a loop.
    let loads = 0;
    page.on("load", () => (loads += 1));
    await page.route("**/api/live", (route) => route.fulfill({ status: 502 }));
    await deploy("b");
    const b = await buildOf();
    expect(b).not.toBe(a);
    expect(await shown.getAttribute("content")).toBe(a);
    await page.unroute("**/api/live");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await eventually(async () => (await shown.getAttribute("content")) === b);
    await expect(page.getByText("Hang the washing out")).toBeVisible();
    await pause(1_500);
    expect(loads).toBe(1);
    await evidence(page, "HOU-154-reloaded-itself");

    // HOME-6: the network blips; a reload still shows the last plan.
    await ctx.setOffline(true);
    await page.reload();
    await expect(page.getByText("Hang the washing out")).toBeVisible();
    await evidence(page, "HOU-154-offline-last-plan");
    await ctx.setOffline(false);

    // Deploy C, and reload straight away: that one reload shows C. The live connection is cut first, so
    // the page's own reload cannot race this one; this step is about the reload alone.
    await page.route("**/api/live", (route) => route.abort());
    await deploy("c");
    const c = await buildOf();
    expect(c).not.toBe(b);
    await page.reload();
    await expect(shown).toHaveAttribute("content", c);
    await evidence(page, "HOU-154-one-reload");
    await ctx.close();
  } finally {
    const last = state.running?.child;
    if (last !== undefined && last.exitCode === null) {
      const exited = new Promise((resolve) => last.once("exit", resolve));
      last.kill("SIGTERM");
      await exited;
    }
  }
});
