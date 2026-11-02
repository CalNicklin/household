import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * HOU-168: the offline secret scan in `pnpm check` (rules in .secretlintrc.yml). It reads every file
 * git tracks, plus new ones it would track, so a credential is caught before it is pushed rather than
 * by GitGuardian after. Images are skipped: they hold no text to scan. Findings name the file and
 * line; the value itself is masked so the scan never prints a credential into a log.
 */
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/i;

const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
const files = [...new Set(listed.stdout.split("\0"))].filter((f) => f !== "" && !BINARY.test(f) && existsSync(f));

const scan = spawnSync("pnpm", ["exec", "secretlint", "--maskSecrets", "--format", "unix", ...files], { stdio: "inherit" });
if (scan.status !== 0) {
  process.stdout.write("FALSE HOU-168: a credential-shaped literal is in the repo; make it at runtime (randomBytes) or take the practice value from contracts/src/practice.ts\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`no credential-shaped literals in ${files.length} files\n`);
}
