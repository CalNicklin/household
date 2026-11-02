import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Limits } from "@household/contracts";
import { ensurePostgres } from "../server/testing/postgres.ts";
import { evidence, expect, login, ownStack, reset, test, underServiceWorker } from "./fixtures.ts";

/**
 * HOU-154: a deploy shows on the next reload, and an open screen picks it up by itself. This journey
 * runs its own server on a spare port of this worker's stack, and replaces it with a new build (the same
 * app with a different build id) the way a deploy does. Three builds: B reaches an untouched page by
 * itself, C on one reload. (HOU-163 sizes the pools, so its server shares Postgres with the stacks.)
 */
const root = path.resolve(import.meta.dirname, "..");
const built = path.join(root, "web", "dist", "client");

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * HOU-166: until `read` says yes, failing after deployWaitMs, or at once if `child` (the server being
 * waited on) exits first. A wait with no bound ran into the test's own time limit, and a test that
 * times out is abandoned mid-wait.
 */
async function eventually(what: string, read: () => Promise<boolean>, child?: ChildProcess): Promise<void> {
  // limit: deployWaitMs
  const until = Date.now() + Limits.deployWaitMs.value;
  for (;;) {
    if (child !== undefined && exited(child)) throw new Error(`${what}: the server exited (${child.exitCode ?? child.signalCode}) first`);
    const left = until - Date.now();
    if (left <= 0) throw new Error(`${what}: not within ${Limits.deployWaitMs.value} ms`);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), left)));
    const yes = await Promise.race([read().catch(() => false), late]);
    clearTimeout(timer);
    if (yes) return;
    await pause(250);
  }
}

const answers = async (url: string) => (await fetch(`${url}/healthz`)).ok;

/** Stop a deploy server, and wait until it has gone; one that ignores SIGTERM is killed. */
async function stop(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  const gone = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([gone, eventually("the old server stopping", async () => exited(child)).catch(() => child.kill("SIGKILL"))]);
  await gone;
}

/**
 * HOU-166: the server running now. A failed or timed-out test is torn down here, after it (Playwright
 * runs afterEach after a timeout too); a worker that exits kills it as it goes. Before this, a hung run
 * left its server on the port and the next run talked to that one.
 */
const running: { child: ChildProcess | null } = { child: null };
const killOnExit = () => running.child?.kill("SIGKILL");
process.once("exit", killOnExit);
test.afterEach(async () => {
  const child = running.child;
  running.child = null;
  if (child !== null) await stop(child);
});

test("[HOME-6] (HOU-154) after a deploy one reload shows the new build, an open screen reloads itself, and offline still shows the last plan", async ({ browser }) => {
  test.setTimeout(180_000);
  const own = ownStack();
  const port = own.server + 5;
  const url = `http://localhost:${port}`;
  const pg = await ensurePostgres();
  const builds = path.join(own.dataDir, "builds");
  rmSync(builds, { recursive: true, force: true });

  /** Build `name`: the web app as built, plus a marker file, so its build id is its own. */
  const deploy = async (name: string): Promise<void> => {
    if (running.child !== null) await stop(running.child);
    // HOU-166: nothing else may be answering here (an earlier run's server), or every build would be that one.
    if (await answers(url).catch(() => false)) throw new Error(`something is already serving ${url}; stop it (an earlier run's deploy server?) and run again`);
    const dist = path.join(builds, name);
    mkdirSync(dist, { recursive: true });
    cpSync(built, dist, { recursive: true });
    writeFileSync(path.join(dist, "build.txt"), name);
    const child = spawn("node", ["server/main.ts"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: pg.url, PRACTICE: "true", PORT: String(port), DB_PREFIX: `${own.dbPrefix}deploy`, PUBLIC_URL: url, WEB_DIST: dist },
      stdio: ["ignore", "ignore", "inherit"],
    });
    running.child = child;
    await eventually(`build ${name} starting`, () => answers(url), child);
  };
  const buildOf = async (): Promise<string> => {
    const sw = await (await fetch(`${url}/sw.js`)).text();
    return /const BUILD = "([0-9a-f]+)"/.exec(sw)?.[1] ?? "";
  };

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
  await underServiceWorker(page);

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
  // limit: deployWaitMs
  await expect(shown).toHaveAttribute("content", b, { timeout: Limits.deployWaitMs.value });
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
});
