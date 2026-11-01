import { spawn, spawnSync } from "node:child_process";

/**
 * CODE-11: the only check. tsc, oxlint, Fallow, drizzle-kit check, then the tests (unit and the
 * Playwright journeys). FB-2: the whole run is timed and must stay under three minutes; slow extras
 * live in `pnpm check:full`.
 *
 * The steps run in three lanes at once, because none needs another lane's output: the static checks,
 * the unit tests (their own databases, random ports), and the web build followed by the journeys
 * (one stack per Playwright worker: its own e2e databases and ports, see e2e/stacks.ts). Each step's
 * output is printed in one piece when it ends.
 */
const full = process.argv.includes("--full");
const started = Date.now();

function baseRef(): string | null {
  for (const ref of [process.env["FALLOW_BASE"], "origin/main", "main"]) {
    if (ref === undefined || ref === "") continue;
    const ok = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { stdio: "ignore" }).status === 0;
    if (ok) return ref;
  }
  return null;
}

type Step = { name: string; cmd: string; args: string[] };
const base = baseRef();
const lanes: Step[][] = [
  [
    { name: "entire trailers", cmd: "node", args: ["scripts/check-entire.ts", base ?? "origin/main"] },
    { name: "tsc", cmd: "pnpm", args: ["exec", "tsc", "-p", "."] },
    { name: "oxlint", cmd: "pnpm", args: ["exec", "oxlint", "--type-aware", "--deny-warnings"] },
    // CODE-8: `fallow audit` against the base branch; on a branch with no base, the whole project.
    base === null ? { name: "fallow", cmd: "pnpm", args: ["exec", "fallow", "--fail-on-issues", "--quiet"] } : { name: "fallow", cmd: "pnpm", args: ["exec", "fallow", "audit", "--base", base, "--quiet"] },
    { name: "drizzle-kit check", cmd: "node", args: ["scripts/drizzle.ts", "check"] },
  ],
  [{ name: "tests", cmd: "pnpm", args: ["exec", "vitest", "run"] }],
  [
    { name: "web build", cmd: "pnpm", args: ["run", "build:web"] },
    { name: "e2e", cmd: "pnpm", args: ["exec", "playwright", "test", ...(full ? [] : ["--grep-invert", "@full"])] },
  ],
];

function run(step: Step): Promise<{ ok: boolean; seconds: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(step.cmd, step.args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    child.on("close", (code) => {
      const seconds = (Date.now() - t0) / 1000;
      const ok = code === 0;
      process.stdout.write(`\n▶ ${step.name}\n${Buffer.concat(chunks).toString()}${ok ? "" : `\n✗ ${step.name} failed after ${seconds.toFixed(1)}s\n`}`);
      resolve({ ok, seconds });
    });
  });
}

const timings: string[] = [];
const results = await Promise.all(
  lanes.map(async (lane) => {
    for (const step of lane) {
      const { ok, seconds } = await run(step);
      timings.push(`${step.name} ${seconds.toFixed(1)}s`);
      if (!ok) return false;
    }
    return true;
  }),
);
const total = (Date.now() - started) / 1000;
// exitCode, not exit(): exit() can drop the end of a large step's output still queued for a pipe,
// which in CI is where the failing tests are named (FB-7).
if (results.includes(false)) {
  process.stdout.write(`\n✗ pnpm check failed in ${total.toFixed(1)}s\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\n✓ pnpm check passed in ${total.toFixed(1)}s (${timings.join(", ")})\n`);
  // FB-2: anything slower than three minutes must be split into check:full.
  if (!full && total > 180) {
    process.stdout.write("FALSE FB-2: pnpm check took longer than three minutes on this machine\n");
    process.exitCode = 1;
  }
}
