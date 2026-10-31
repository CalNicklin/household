import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ID = /\b([A-Z]{2,4}-\d{1,2})\b/;

/** Every line of VERIFICATIONS.md, keyed by ID, in plain language. */
export function loadVerifications(): Map<string, string> {
  const text = readFileSync(path.join(ROOT, "VERIFICATIONS.md"), "utf8");
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^- \[[ x]\] ([A-Z]{2,4}-\d{1,2}) (?:\*\*\(gate\)\*\* )?(.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out.set(m[1], m[2].replaceAll("**", ""));
  }
  return out;
}

/** Test names start with the verification IDs they prove: "[CAP-1][CH-10] a capture shows on…". */
export function idsIn(name: string): string[] {
  const ids: string[] = [];
  for (const m of name.matchAll(/\[([A-Z]{2,4}-\d{1,2})\]/g)) if (m[1] !== undefined) ids.push(m[1]);
  if (ids.length === 0) {
    const bare = ID.exec(name);
    if (bare?.[1] !== undefined) ids.push(bare[1]);
  }
  return ids;
}

/** FB-7: what is false, in one plain line, before any stack trace. */
export function falseLine(verifications: Map<string, string>, testName: string, error: string): string {
  const ids = idsIn(testName);
  const head = ids.length === 0 ? "FALSE (no verification ID on this test)" : ids.map((id) => `FALSE ${id}: ${verifications.get(id) ?? "(unknown ID)"}`).join("\n");
  const reason = testName.replace(/\[[A-Z]{2,4}-\d{1,2}\]\s*/g, "").trim();
  const firstErrorLine = error.split("\n").find((l) => l.trim() !== "") ?? "";
  return `${head}\n  because: ${reason}\n  error:   ${firstErrorLine}`;
}

export const LEDGER_DIR = path.join(ROOT, "evidence");
