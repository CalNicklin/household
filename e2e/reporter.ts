import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { falseLine, idsIn, LEDGER_DIR, loadVerifications } from "../tools/reporters/verifications.ts";

/** FB-7 for the journeys: the failing verification and why, before the stack trace; and the evidence ledger. */
export default class VerificationReporter implements Reporter {
  readonly #verifications = loadVerifications();
  readonly #results: { ids: string[]; test: string; file: string; state: string; attachments: string[] }[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    const name = test.titlePath().slice(1).join(" > ");
    this.#results.push({ ids: idsIn(name), test: name, file: path.relative(process.cwd(), test.location.file), state: result.status, attachments: result.attachments.flatMap((a) => (a.path === undefined ? [] : [path.relative(process.cwd(), a.path)])) });
    if (result.status === "passed" || result.status === "skipped") return;
    process.stderr.write(`\n${falseLine(this.#verifications, name, result.error?.message ?? "")}\n`);
  }

  onEnd(_result: FullResult): void {
    mkdirSync(LEDGER_DIR, { recursive: true });
    writeFileSync(path.join(LEDGER_DIR, "playwright.json"), `${JSON.stringify(this.#results, null, 1)}\n`);
  }
}
