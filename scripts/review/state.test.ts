import { Limits, ReviewStage, zReviewFinding } from "@household/contracts";
import { describe, expect, it } from "vitest";
import { type Answers, emptyState, merge, normalise, priorFor, type ReadHead, type StageAnswer, unchanged, windowOf } from "./state.ts";

/** HOU-151: the findings schema and the blocking decision. */
const quiet = (): StageAnswer => ({ findings: [], earlier: [] });
const answers = (over: Partial<Answers> = {}): Answers => ({ code: quiet(), security: quiet(), slop: quiet(), ...over });
const finding = (over: Partial<StageAnswer["findings"][number]> = {}): StageAnswer["findings"][number] => ({
  severity: "medium",
  file: "server/a.ts",
  line: 5,
  summary: "divides by three",
  failure_scenario: "half(4) returns 1.33",
  confidence: 0.9,
  repeats: null,
  ...over,
});
const lines = (n: number, change?: [number, string]) =>
  Array.from({ length: n }, (_, i) => (change !== undefined && change[0] === i + 1 ? change[1] : `const l${i + 1} = ${i + 1};`)).join("\n");
const files =
  (map: Record<string, string>): ReadHead =>
  (f) =>
    map[f] ?? null;
const head = (sha: string, map: Record<string, string>) => ({ sha, read: files(map), diff: "diff" });

describe("HOU-151 findings", () => {
  it("a finding is {stage, severity, file, line, summary, failure_scenario, confidence}, validated", () => {
    expect(zReviewFinding.safeParse({ stage: "code", severity: "high", file: "a.ts", line: 3, summary: "s", failure_scenario: "f", confidence: 0.8 }).success).toBe(true);
    expect(zReviewFinding.safeParse({ stage: "code", severity: "critical", file: "a.ts", line: 3, summary: "s", failure_scenario: "f", confidence: 0.8 }).success).toBe(false);
    expect(zReviewFinding.safeParse({ stage: "lint", severity: "low", file: "a.ts", line: 3, summary: "s", failure_scenario: "f", confidence: 0.8 }).success).toBe(false);
    expect(zReviewFinding.safeParse({ stage: "code", severity: "low", file: "a.ts", line: 0, summary: "s", failure_scenario: "f", confidence: 0.8 }).success).toBe(false);
    expect(zReviewFinding.safeParse({ stage: "code", severity: "low", file: "a.ts", line: null, summary: "", failure_scenario: "f" }).success).toBe(false);
  });

  it("normalise bounds what the model wrote and keeps paths inside the repository", () => {
    expect(normalise(ReviewStage.code, finding({ file: "b/server/a.ts", summary: "x".repeat(9000) }))).toMatchObject({ file: "server/a.ts", summary: "x".repeat(4000) });
    expect(normalise(ReviewStage.code, finding({ file: "../../etc/passwd" }))?.file).toBe("");
    expect(normalise(ReviewStage.code, finding({ file: "/etc/passwd" }))?.file).toBe("");
    expect(normalise(ReviewStage.code, finding({ line: 0 }))?.line).toBeNull();
    expect(normalise(ReviewStage.code, finding({ summary: "   " }))).toBeNull();
  });
});

describe("HOU-151 the blocking decision", () => {
  const a = { "server/a.ts": lines(20) };

  it("blocks on an open medium or high, never on a low", () => {
    expect(merge(emptyState(), answers({ code: { findings: [finding({ severity: "low" })], earlier: [] } }), head("aaaaaaa", a)).blocking).toBe(false);
    expect(merge(emptyState(), answers({ security: { findings: [finding({ severity: "medium" })], earlier: [] } }), head("aaaaaaa", a)).blocking).toBe(true);
    expect(merge(emptyState(), answers({ slop: { findings: [finding({ severity: "high" })], earlier: [] } }), head("aaaaaaa", a)).blocking).toBe(true);
    expect(merge(emptyState(), answers(), head("aaaaaaa", a)).blocking).toBe(false);
  });

  it("numbers new findings and caps each stage at its limit, most severe first", () => {
    const many = Array.from({ length: 30 }, (_, i) => finding({ line: 1 + i * 10, severity: i === 29 ? "high" : "low", file: `f${i}.ts` }));
    const m = merge(emptyState(), answers({ code: { findings: many, earlier: [] } }), head("aaaaaaa", {}));
    expect(m.raised).toHaveLength(Limits.reviewMaxFindings.value);
    expect(m.raised[0]).toMatchObject({ id: "AR-1", severity: "high", file: "f29.ts" });
    expect(m.state.next).toBe(Limits.reviewMaxFindings.value + 1);
  });

  it("a finding fixed in a later push is settled as fixed and stops blocking", () => {
    const first = merge(emptyState(), answers({ code: { findings: [finding()], earlier: [] } }), head("aaaaaaa", a));
    const second = merge(first.state, answers(), head("bbbbbbb", { "server/a.ts": lines(20, [5, "const l5 = 5 / 2;"]) }));
    expect(second.settled).toMatchObject([{ id: "AR-1", status: "fixed", settledOn: "bbbbbbb" }]);
    expect(second.blocking).toBe(false);
  });

  it("a reply the stage accepts settles the finding; it isn't raised again while the code is unchanged", () => {
    const first = merge(emptyState(), answers({ code: { findings: [finding()], earlier: [] } }), head("aaaaaaa", a));
    const second = merge(first.state, answers({ code: { findings: [], earlier: [{ id: "AR-1", outcome: "accepted", reason: "the divisor is three on purpose" }] } }), head("aaaaaaa", a));
    expect(second.settled).toMatchObject([{ id: "AR-1", status: "accepted", reason: "the divisor is three on purpose" }]);
    expect(second.blocking).toBe(false);
    // The model raises it again, on the same code or by name: suppressed.
    const third = merge(second.state, answers({ code: { findings: [finding({ line: 5 }), finding({ repeats: "AR-1", line: 40, file: "elsewhere.ts" })], earlier: [] } }), head("ccccccc", a));
    expect(third.raised).toEqual([]);
    expect(third.blocking).toBe(false);
    // A finding on other code nearby is a different finding.
    expect(merge(second.state, answers({ code: { findings: [finding({ line: 6 })], earlier: [] } }), head("ccccccc", a)).raised).toMatchObject([{ id: "AR-2", line: 6 }]);
  });

  it("a new defect right next to a fixed one is still raised", () => {
    const first = merge(emptyState(), answers({ code: { findings: [finding({ line: 10 })], earlier: [] } }), head("aaaaaaa", a));
    const fixedFile = { "server/a.ts": lines(20, [10, "const l10 = fixed();"]) };
    const second = merge(first.state, answers({ code: { findings: [finding({ line: 11, summary: "the fix broke the next line" })], earlier: [{ id: "AR-1", outcome: "fixed", reason: "changed" }] } }), head("bbbbbbb", fixedFile));
    expect(second.settled).toMatchObject([{ id: "AR-1", status: "fixed" }]);
    expect(second.raised).toMatchObject([{ id: "AR-2", line: 11 }]);
    expect(second.blocking).toBe(true);
  });

  it("a finding its stage stops mentioning stays open while its code is unchanged (it fails closed)", () => {
    const first = merge(emptyState(), answers({ code: { findings: [finding()], earlier: [] } }), head("aaaaaaa", a));
    // A re-run on the same head whose answer forgets AR-1, and raises it again without saying so.
    const forgot = merge(first.state, answers({ code: { findings: [finding()], earlier: [] } }), head("aaaaaaa", a));
    expect(forgot.settled).toEqual([]);
    expect(forgot.raised).toEqual([]);
    expect(forgot.open.map((f) => f.id)).toEqual(["AR-1"]);
    expect(forgot.blocking).toBe(true);
  });

  it("an accepted finding is raised again, with a new id, once its code changes", () => {
    const first = merge(emptyState(), answers({ code: { findings: [finding()], earlier: [] } }), head("aaaaaaa", a));
    const accepted = merge(first.state, answers({ code: { findings: [], earlier: [{ id: "AR-1", outcome: "accepted", reason: "on purpose" }] } }), head("bbbbbbb", a));
    const changed = { "server/a.ts": lines(20, [4, "const l4 = compute();"]) };
    const again = merge(accepted.state, answers({ code: { findings: [finding()], earlier: [] } }), head("ccccccc", changed));
    expect(again.raised).toMatchObject([{ id: "AR-2", status: "open" }]);
    expect(again.state.findings.map((f) => f.id)).toEqual(["AR-2"]);
  });

  it("a still-open finding keeps blocking and is not counted twice", () => {
    const first = merge(emptyState(), answers({ code: { findings: [finding()], earlier: [] } }), head("aaaaaaa", a));
    const second = merge(first.state, answers({ code: { findings: [finding({ repeats: "AR-1" })], earlier: [{ id: "AR-1", outcome: "still_open", reason: "unchanged" }] } }), head("bbbbbbb", a));
    expect(second.open.map((f) => f.id)).toEqual(["AR-1"]);
    expect(second.raised).toEqual([]);
    expect(second.blocking).toBe(true);
  });

  it("a stage only judges its own earlier findings", () => {
    const first = merge(emptyState(), answers({ security: { findings: [finding()], earlier: [] } }), head("aaaaaaa", a));
    const second = merge(first.state, answers({ code: { findings: [], earlier: [{ id: "AR-1", outcome: "accepted", reason: "fine" }] }, security: { findings: [], earlier: [{ id: "AR-1", outcome: "still_open", reason: "no" }] } }), head("bbbbbbb", a));
    expect(second.open.map((f) => f.id)).toEqual(["AR-1"]);
    expect(priorFor(ReviewStage.code, second.state, new Map()).open).toEqual([]);
    expect(priorFor(ReviewStage.security, second.state, new Map([["AR-1", [{ author: "cal", body: "on purpose" }]]])).open).toMatchObject([{ id: "AR-1", replies: [{ author: "cal", body: "on purpose" }] }]);
  });
});

describe("HOU-151 the code a finding points at", () => {
  it("survives lines moving, not lines changing", () => {
    const before = lines(20);
    const w = windowOf({ file: "a.ts", line: 10 }, files({ "a.ts": before }), "d");
    expect(unchanged({ file: "a.ts", line: 10, window: w }, files({ "a.ts": `// a new header\n\n${before}` }), "d")).toBe(true);
    expect(unchanged({ file: "a.ts", line: 10, window: w }, files({ "a.ts": lines(20, [11, "changed();"]) }), "d")).toBe(false);
    expect(unchanged({ file: "a.ts", line: 10, window: w }, files({}), "d")).toBe(false);
  });

  it("is the whole file for a whole-file finding and the diff for a whole-PR one", () => {
    const w = windowOf({ file: "a.ts", line: null }, files({ "a.ts": "x" }), "d");
    expect(unchanged({ file: "a.ts", line: null, window: w }, files({ "a.ts": "x" }), "d")).toBe(true);
    expect(unchanged({ file: "a.ts", line: null, window: w }, files({ "a.ts": "y" }), "d")).toBe(false);
    const pr = windowOf({ file: "", line: null }, files({}), "diff one");
    expect(unchanged({ file: "", line: null, window: pr }, files({}), "diff one")).toBe(true);
    expect(unchanged({ file: "", line: null, window: pr }, files({}), "diff two")).toBe(false);
  });
});
