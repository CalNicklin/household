import { execFileSync } from "node:child_process";
import { Limits } from "@household/contracts";

/**
 * HOU-151: the diff a review reads: the PR's head against its merge base with the base branch, without
 * the files no reviewer reads line by line. No external diff driver or textconv runs, so nothing in the
 * PR's checkout executes.
 */
const EXCLUDED = ["pnpm-lock.yaml", "evidence/**", "design/**", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.webp", "**/*.pdf"];

export function prDiff(checkout: string, base: string, head: string): string {
  for (const sha of [base, head]) if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`not a commit sha: ${sha}`);
  return execFileSync(
    "git",
    ["-C", checkout, "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", `${base}...${head}`, "--", ".", ...EXCLUDED.map((p) => `:(exclude,glob)${p}`)],
    { encoding: "utf8", maxBuffer: Limits.reviewMaxDiffChars.value * 4 },
  );
}

/** The lines of each file that a review comment can point at: the new side of each hunk. */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = null;
      line = 0;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file = raw === "+++ /dev/null" ? null : raw.slice(4).replace(/^b\//, "");
      if (file !== null && !out.has(file)) out.set(file, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk?.[1] !== undefined) {
      line = Number(hunk[1]);
      continue;
    }
    if (file === null || line === 0) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) out.get(file)?.add(line++);
    // "-" lines and "\ No newline" don't advance the new side.
  }
  return out;
}

/** The diff base: where the PR's head left the base branch, never the base branch's current tip. */
export function diffBase(checkout: string, baseTip: string, head: string): string {
  for (const sha of [baseTip, head]) if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`not a commit sha: ${sha}`);
  return execFileSync("git", ["-C", checkout, "merge-base", baseTip, head], { encoding: "utf8" }).trim();
}
