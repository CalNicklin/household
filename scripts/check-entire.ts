import { execFileSync } from "node:child_process";

/**
 * QA-4: every commit an agent makes links to the Entire session that produced it. CI rejects any
 * commit in the PR without an `Entire-Checkpoint:` trailer. Locally it only warns.
 */
const base = process.argv[2] ?? process.env["FALLOW_BASE"] ?? "origin/main";
let range: string[];
try {
  // --no-merges: on a pull request CI tests GitHub's own merge commit, which no agent made.
  range = execFileSync("git", ["rev-list", "--no-merges", `${base}..HEAD`], { encoding: "utf8" }).split("\n").filter((s) => s !== "");
} catch {
  process.stdout.write(`no base ${base}; skipping the Entire trailer check\n`);
  process.exit(0);
}
const missing = range.filter((sha) => !/^Entire-Checkpoint: \S+/m.test(execFileSync("git", ["log", "-1", "--format=%B", sha], { encoding: "utf8" })));
if (missing.length === 0) process.exit(0);
const line = `FALSE QA-4: ${missing.length} of ${range.length} commits have no Entire-Checkpoint trailer (${missing.slice(0, 5).map((s) => s.slice(0, 8)).join(", ")}${missing.length > 5 ? ", …" : ""})`;
if (process.env["CI"] === "true") {
  process.stdout.write(`${line}\n`);
  process.exit(1);
}
process.stdout.write(`warning (CI fails this): ${line}\n`);
