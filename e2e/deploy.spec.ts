import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensurePostgres } from "../server/testing/postgres.ts";
import { evidence, expect, login, ownStack, reset, test } from "./fixtures.ts";

/**
 * HOU-154: a deploy shows on the next reload, and an open screen picks it up by itself. This journey
 * runs its own server on a spare port of this worker's stack, with its own databases, and replaces it
 * with a new build (the same app with a different build id) the way a deploy does.
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
    // A page that is controlled by build A's worker has every view and the page itself to hand.
    await page.reload();
    await expect(page.getByText("Hang the washing out")).toBeVisible();

    // HOME-6: the network blips; a reload still shows the last plan.
    await ctx.setOffline(true);
    await page.reload();
    await expect(page.getByText("Hang the washing out")).toBeVisible();
    await evidence(page, "HOU-154-offline-last-plan");
    await ctx.setOffline(false);
    await page.reload();
    await expect(shown).toHaveAttribute("content", a);

    // Deploy B. Nobody touches the screen: it reconnects, finds the new worker and reloads itself, once.
    await deploy("b");
    const b = await buildOf();
    expect(b).not.toBe(a);
    let loads = 0;
    page.on("load", () => (loads += 1));
    await eventually(async () => (await shown.getAttribute("content")) === b);
    await expect(shown).toHaveAttribute("content", b);
    await expect(page.getByText("Hang the washing out")).toBeVisible();
    // Once, not a loop: a few seconds later it has still loaded only the once.
    await pause(3_000);
    expect(loads).toBe(1);
    await evidence(page, "HOU-154-reloaded-itself");

    // Deploy C, and reload straight away: that one reload shows C.
    await deploy("c");
    const c = await buildOf();
    expect(c).not.toBe(b);
    await page.reload();
    await expect(shown).toHaveAttribute("content", c);
    await evidence(page, "HOU-154-one-reload");
    await ctx.close();
  } finally {
    state.running?.child.kill("SIGTERM");
  }
});
