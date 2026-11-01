import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { replayDays } from "./replay.ts";

const DAYS = path.resolve(import.meta.dirname, "..", "..", "practice", "days");
const zScore = z.object({ days: z.number(), correctlyAvoided: z.number(), wronglyAvoided: z.number(), missed: z.number() });

describe("Eval against recorded days", () => {
  /**
   * QA-6 / LRN-9: every change is scored against the recorded days in CI. A change may not make the
   * learning wrongly hold back more accepted suggestions, or catch fewer dismissed ones, than the
   * committed baseline. Real days come from the house (practice/days/README.md); there are none yet.
   */
  test("[QA-6][LRN-9] changes are scored against the recorded days and may not do worse than the baseline", () => {
    const now = replayDays(DAYS);
    const baseline = zScore.parse(JSON.parse(readFileSync(path.join(DAYS, "baseline.json"), "utf8")));
    expect(now.days).toBeGreaterThanOrEqual(baseline.days);
    expect(now.wronglyAvoided).toBeLessThanOrEqual(baseline.wronglyAvoided + (now.days - baseline.days));
    expect(now.correctlyAvoided).toBeGreaterThanOrEqual(baseline.correctlyAvoided);
    if (now.days < 20) process.stderr.write(`QA-6 is not true yet: ${now.days} recorded real days, needs at least 20.\n`);
  });
});
