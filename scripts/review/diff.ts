import { execFileSync } from "node:child_process";
import { Limits } from "@household/contracts";

/**
 * HOU-151: the diff a review reads: the PR's head against its merge base with the base branch, without
 * the files no reviewer reads line by line. No external diff driver or textconv runs, so nothing in the
 * PR's checkout executes.
 */
/** A commit's full or abbreviated sha, and nothing that git could read as an option. */
export const SHA = /^[0-9a-f]{7,40}$/;

const EXCLUDED = ["pnpm-lock.yaml", "evidence/**", "design/**", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.webp", "**/*.pdf"];

/** Throws for a diff over the limit: the PR is too big to review and should be split. */
export function prDiff(checkout: string, base: string, head: string): string {
  for (const sha of [base, head]) if (!SHA.test(sha)) throw new Error(`not a commit sha: ${sha}`);
  const tooBig = new Error(`this PR's diff is over ${Limits.reviewMaxDiffChars.value} characters (lockfile, evidence/ and design/ left out): too big to review; split it`);
  let diff: string;
  try {
    diff = execFileSync(
      "git",
      ["-C", checkout, "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", `${base}...${head}`, "--", ".", ...EXCLUDED.map((p) => `:(exclude,glob)${p}`)],
      // Bytes, so a little over the character limit: anything bigger is refused below anyway.
      { encoding: "utf8", maxBuffer: Limits.reviewMaxDiffChars.value * 4 },
    );
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOBUFS") throw tooBig;
    throw e;
  }
  if (diff.length > Limits.reviewMaxDiffChars.value) throw tooBig;
  return diff;
}

/**
 * The lines of each file that a review comment can point at: the new side of each hunk. A hunk's
 * length comes from its header, so a line inside it that looks like a header (an added "++ x" is
 * "+++ x") is still content.
 */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith("\\")) continue;
      if (raw.startsWith("-")) oldLeft--;
      else {
        if (raw.startsWith(" ")) oldLeft--;
        newLeft--;
        if (file !== null) out.get(file)?.add(line);
        line++;
      }
      continue;
    }
    if (raw.startsWith("diff --git ")) file = null;
    else if (raw.startsWith("+++ ")) {
      file = raw === "+++ /dev/null" ? null : raw.slice(4).replace(/^b\//, "");
      if (file !== null && !out.has(file)) out.set(file, new Set());
    } else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (hunk?.[2] !== undefined) {
        oldLeft = Number(hunk[1] ?? "1");
        line = Number(hunk[2]);
        newLeft = Number(hunk[3] ?? "1");
      }
    }
  }
  return out;
}

/** The diff base: where the PR's head left the base branch, never the base branch's current tip. */
export function diffBase(checkout: string, baseTip: string, head: string): string {
  for (const sha of [baseTip, head]) if (!SHA.test(sha)) throw new Error(`not a commit sha: ${sha}`);
  return execFileSync("git", ["-C", checkout, "merge-base", baseTip, head], { encoding: "utf8" }).trim();
}
