import { execFileSync, spawnSync } from "node:child_process";

/**
 * CODE-11: the only check. tsc, oxlint, Fallow, drizzle-kit check, then the tests (unit and the
 * Playwright journeys). FB-2: the whole run is timed and must stay under three minutes; slow extras
 * live in `pnpm check:full`.
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

const base = baseRef();
const steps: { name: string; cmd: string; args: string[] }[] = [
  { name: "entire trailers", cmd: "node", args: ["scripts/check-entire.ts", base ?? "origin/main"] },
  { name: "tsc", cmd: "pnpm", args: ["exec", "tsc", "-p", "."] },
  { name: "oxlint", cmd: "pnpm", args: ["exec", "oxlint", "--type-aware", "--deny-warnings"] },
  // CODE-8: `fallow audit` against the base branch; on a branch with no base, the whole project.
  base === null ? { name: "fallow", cmd: "pnpm", args: ["exec", "fallow", "--fail-on-issues", "--quiet"] } : { name: "fallow", cmd: "pnpm", args: ["exec", "fallow", "audit", "--base", base, "--quiet"] },
  { name: "drizzle-kit check", cmd: "node", args: ["scripts/drizzle.ts", "check"] },
  { name: "tests", cmd: "pnpm", args: ["exec", "vitest", "run"] },
  { name: "web build", cmd: "pnpm", args: ["run", "build:web"] },
  { name: "e2e", cmd: "pnpm", args: ["exec", "playwright", "test", ...(full ? [] : ["--grep-invert", "@full"])] },
];

const timings: string[] = [];
for (const step of steps) {
  const t0 = Date.now();
  process.stdout.write(`\n▶ ${step.name}\n`);
  try {
    execFileSync(step.cmd, step.args, { stdio: "inherit", env: process.env });
  } catch {
    process.stdout.write(`\n✗ ${step.name} failed after ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    process.exit(1);
  }
  timings.push(`${step.name} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
const total = (Date.now() - started) / 1000;
process.stdout.write(`\n✓ pnpm check passed in ${total.toFixed(1)}s (${timings.join(", ")})\n`);
// FB-2: anything slower than three minutes must be split into check:full.
if (!full && total > 180) {
  process.stdout.write("FALSE FB-2: pnpm check took longer than three minutes on this machine\n");
  process.exit(1);
}
