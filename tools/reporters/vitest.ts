import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Reporter, TestCase, TestModule } from "vitest/node";
import { falseLine, idsIn, LEDGER_DIR, loadVerifications } from "./verifications.ts";

/** FB-7 reporter: prints the failing verification and why first; writes the evidence ledger. */
export default class VerificationReporter implements Reporter {
  readonly #verifications = loadVerifications();
  readonly #results: { ids: string[]; test: string; file: string; state: string }[] = [];

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result();
    const ids = idsIn(testCase.fullName);
    this.#results.push({ ids, test: testCase.fullName, file: path.relative(process.cwd(), testCase.module.moduleId), state: result.state });
    if (result.state !== "failed") return;
    const message = result.errors?.[0]?.message ?? "";
    process.stderr.write(`\n${falseLine(this.#verifications, testCase.fullName, message)}\n`);
  }

  onTestRunEnd(_modules: ReadonlyArray<TestModule>): void {
    mkdirSync(LEDGER_DIR, { recursive: true });
    writeFileSync(path.join(LEDGER_DIR, "vitest.json"), `${JSON.stringify(this.#results, null, 1)}\n`);
  }
}
