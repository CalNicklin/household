import { createHash } from "node:crypto";
import {
  blockingSeverities,
  Limits,
  type ReviewFinding,
  ReviewOutcome,
  type ReviewSeverity,
  ReviewStage,
  ReviewStatus,
  zReviewFinding,
  zReviewOutcome,
  zReviewSeverity,
  zReviewStatus,
} from "@household/contracts";
import { z } from "zod";
import { SHA } from "./diff.ts";

/**
 * HOU-151: the review's memory between pushes, and the one rule that decides the check. Plain code, no
 * model: the stages say what they see; this file decides what is new, what is settled and what blocks.
 */

/** What one stage's model call must return. Loose on purpose (the API's structured output takes no length limits); `normalise` bounds it. */
export const zStageAnswer = z.object({
  findings: z.array(
    z.object({
      severity: zReviewSeverity,
      file: z.string(),
      line: z.number().int().nullable(),
      summary: z.string(),
      failure_scenario: z.string(),
      confidence: z.number(),
      /** The id (AR-n) of an earlier finding this one restates, or null. */
      repeats: z.string().nullable(),
    }),
  ),
  /** One entry per earlier open finding of this stage. */
  earlier: z.array(z.object({ id: z.string(), outcome: zReviewOutcome, reason: z.string() })),
});
export type StageAnswer = z.infer<typeof zStageAnswer>;

/** The three stages' answers for one push. */
export type Answers = Record<ReviewStage, StageAnswer>;

const zSha = z.string().regex(SHA);
const zStored = zReviewFinding.extend({
  id: z.string().regex(/^AR-\d{1,5}$/),
  status: zReviewStatus,
  /** The head the finding was raised on. */
  sha: zSha,
  /** The code it points at (see `windowOf`): a settled finding stays settled while this is unchanged. */
  window: z.string().max(200),
  /** Its inline review comment, if it has one. */
  commentId: z.number().int().nullable(),
  /** Why it was settled, and on which head. */
  reason: z.string().max(Limits.reviewStateTextChars.value).nullable(),
  settledOn: zSha.nullable(),
});
export type StoredFinding = z.infer<typeof zStored>;

export const zReviewState = z.object({ version: z.literal(1), next: z.number().int().min(1), findings: z.array(zStored) });
export type ReviewState = z.infer<typeof zReviewState>;
export const emptyState = (): ReviewState => ({ version: 1, next: 1, findings: [] });

/** The head's files, read-only. null when the file doesn't exist at the head. */
export type ReadHead = (file: string) => string | null;

const WINDOW_BEFORE = 3;
const WINDOW_AFTER = 3;
const NEAR_LINES = 3;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const normaliseLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .join("\n");

/**
 * The code a finding points at, as a hash: of the lines around it (whitespace-trimmed), of the whole
 * file for a whole-file finding, or of the diff for a finding about the PR as a whole.
 */
export function windowOf(finding: Pick<ReviewFinding, "file" | "line">, read: ReadHead, diff: string): string {
  if (finding.file === "") return `diff:${sha256(diff)}`;
  const text = read(finding.file);
  if (text === null) return "missing";
  if (finding.line === null) return `file:${sha256(normaliseLines(text))}`;
  const lines = normaliseLines(text).split("\n");
  const around = lines.slice(Math.max(0, finding.line - 1 - WINDOW_BEFORE), finding.line + WINDOW_AFTER);
  return `lines:${around.length}:${sha256(around.join("\n"))}`;
}

/** True while the code a finding points at is still there, unchanged, anywhere in its file. */
export function unchanged(stored: Pick<StoredFinding, "file" | "line" | "window">, read: ReadHead, diff: string): boolean {
  const m = /^lines:(\d+):([0-9a-f]{64})$/.exec(stored.window);
  if (m === null) return windowOf(stored, read, diff) === stored.window;
  const text = read(stored.file);
  if (text === null) return false;
  const lines = normaliseLines(text).split("\n");
  const n = Number(m[1]);
  for (let i = 0; i + n <= lines.length; i++) if (sha256(lines.slice(i, i + n).join("\n")) === m[2]) return true;
  return false;
}

/** Bounds and tidies a finding from the model: trimmed, capped text and a repo-relative path. */
const cap = (s: string) => s.trim().slice(0, Limits.reviewMaxTextChars.value);
const short = (s: string) => s.trim().slice(0, Limits.reviewStateTextChars.value);

export function normalise(stage: ReviewStage, f: StageAnswer["findings"][number]): ReviewFinding | null {
  const file = cap(f.file.replace(/^(?:\.\/|[ab]\/)/, ""));
  const parsed = zReviewFinding.safeParse({
    stage,
    severity: f.severity,
    // A path, nothing else: no markup, quoting or control characters can ride along into a comment.
    file: file.startsWith("/") || file.split("/").includes("..") || /[<>`|\\\p{Cc}]/u.test(file) ? "" : file,
    line: f.line !== null && f.line >= 1 ? f.line : null,
    summary: cap(f.summary),
    failure_scenario: cap(f.failure_scenario),
    confidence: Math.min(1, Math.max(0, f.confidence)),
  });
  return parsed.success ? parsed.data : null;
}

const severityRank: Record<ReviewSeverity, number> = { high: 0, medium: 1, low: 2 };

export type Merged = {
  state: ReviewState;
  /** Raised for the first time on this push: each gets an inline comment. */
  raised: StoredFinding[];
  /** Settled on this push: each gets a reply on its comment. */
  settled: StoredFinding[];
  open: StoredFinding[];
  blocking: boolean;
};

const near = (a: Pick<ReviewFinding, "stage" | "file" | "line">, b: Pick<ReviewFinding, "stage" | "file" | "line">) =>
  a.stage === b.stage && a.file === b.file && (a.line === null || b.line === null ? a.line === b.line : Math.abs(a.line - b.line) <= NEAR_LINES);

/**
 * A new finding restates a remembered one of its stage when it is near one still open, or anchored on
 * exactly the code of one accepted. A fixed finding is only restated by name (`repeats`), so a
 * new defect next to a fix is still raised.
 */
function restates(f: ReviewFinding, window: string, k: StoredFinding): boolean {
  if (k.status === ReviewStatus.open) return near(k, f);
  if (k.status === ReviewStatus.fixed) return false;
  return k.stage === f.stage && k.file === f.file && k.window === window;
}

/**
 * The check's rule. Earlier settled findings whose code changed are forgotten (they may be raised
 * again); the rest suppress any finding that restates them. Each earlier open finding is fixed,
 * accepted or still open as its stage says; one the stage doesn't mention is fixed if its code changed
 * and stays open if not (failing closed: a model that forgets a finding doesn't clear it). New findings get the next ids. It blocks while any open finding is medium or high.
 */
export function merge(prior: ReviewState, answers: Answers, head: { sha: string; read: ReadHead; diff: string }): Merged {
  const { sha, read, diff } = head;
  const kept = prior.findings.filter((f) => f.status === ReviewStatus.open || unchanged(f, read, diff));
  const settled: StoredFinding[] = [];
  const findings = kept.map((f): StoredFinding => {
    if (f.status !== ReviewStatus.open) return f;
    const said = answers[f.stage].earlier.find((e) => e.id === f.id);
    const changed = !unchanged(f, read, diff);
    let next: StoredFinding;
    if (said?.outcome === ReviewOutcome.accepted) next = { ...f, status: ReviewStatus.accepted, reason: short(said.reason) || "accepted", settledOn: sha };
    else if (said?.outcome === ReviewOutcome.fixed || (said === undefined && changed)) next = { ...f, status: ReviewStatus.fixed, reason: (said === undefined ? "" : short(said.reason)) || "no longer raised after the code changed", settledOn: sha };
    else return f;
    // A settled finding remembers the code as it is now, so it stays settled until that changes.
    next = { ...next, window: windowOf(next, read, diff) };
    settled.push(next);
    return next;
  });

  let nextId = prior.next;
  const raised: StoredFinding[] = [];
  for (const stage of Object.values(ReviewStage)) {
    const fresh = answers[stage].findings
      .filter((f) => f.repeats === null || !findings.some((k) => k.id === f.repeats))
      .map((f) => normalise(stage, f))
      .filter((f): f is ReviewFinding => f !== null)
      .map((f) => ({ f, window: windowOf(f, read, diff) }))
      .filter(({ f, window }) => !findings.some((k) => restates(f, window, k)) && !raised.some((r) => near(r, f)))
      .sort((a, b) => severityRank[a.f.severity] - severityRank[b.f.severity])
      .slice(0, Limits.reviewMaxFindings.value);
    for (const { f, window } of fresh) raised.push({ ...f, id: `AR-${nextId++}`, status: ReviewStatus.open, sha, window, commentId: null, reason: null, settledOn: null });
  }
  const all = [...findings, ...raised];
  const open = all.filter((f) => f.status === ReviewStatus.open);
  return { state: { version: 1, next: nextId, findings: all }, raised, settled, open, blocking: open.some((f) => blockingSeverities.includes(f.severity)) };
}

/** Earlier findings as a stage sees them: its own open ones (with replies) to judge, and the settled ones not to raise again. */
export function priorFor(stage: ReviewStage, state: ReviewState, replies: ReadonlyMap<string, readonly Reply[]>) {
  const mine = state.findings.filter((f) => f.stage === stage);
  return {
    open: mine.filter((f) => f.status === ReviewStatus.open).map((f) => ({ ...pick(f), replies: replies.get(f.id) ?? [] })),
    settled: mine.filter((f) => f.status !== ReviewStatus.open).map((f) => ({ ...pick(f), status: f.status, reason: f.reason })),
  };
}
const pick = (f: StoredFinding) => ({ id: f.id, severity: f.severity, file: f.file, line: f.line, summary: f.summary, failure_scenario: f.failure_scenario });

/** A reply to a finding's comment, from someone who can push to the repo. */
export type Reply = { author: string; body: string };
