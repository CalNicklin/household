/**
 * HOU-151: the agent review that runs in CI on every push to a PR. Three stages (Entire's code, security
 * and slop reviews), each returning graded findings; the `agent-review` check fails while any medium or
 * high finding on the latest push is open.
 */
import { z } from "zod";
import { Limits } from "./limits.ts";

type ValueOf<T> = T[keyof T];

export const ReviewStage = {
  code: "code",
  security: "security",
  slop: "slop",
} as const;
export type ReviewStage = ValueOf<typeof ReviewStage>;
export const zReviewStage = z.enum(ReviewStage);

export const ReviewSeverity = {
  high: "high",
  medium: "medium",
  low: "low",
} as const;
export type ReviewSeverity = ValueOf<typeof ReviewSeverity>;
export const zReviewSeverity = z.enum(ReviewSeverity);

/** A low never blocks; a medium or a high blocks while it is open. */
export const blockingSeverities: readonly ReviewSeverity[] = [ReviewSeverity.high, ReviewSeverity.medium];

/** The slop stage's overall rating of the change, shown in the summary; it does not block by itself. */
export const SlopRating = {
  low: "Low",
  medium: "Medium",
  large: "Large",
} as const;
export type SlopRating = ValueOf<typeof SlopRating>;
export const zSlopRating = z.enum(SlopRating);

/**
 * Where a finding stands. `open` blocks (if medium or high). The rest are settled: `fixed` (the code it
 * points at changed and the reviewer no longer raises it), `accepted` (the reviewer accepted a reply's
 * reason) and `dropped` (raised once, not raised again on unchanged code). A settled finding is not raised
 * again unless the code it points at changes.
 */
export const ReviewStatus = {
  open: "open",
  fixed: "fixed",
  accepted: "accepted",
  dropped: "dropped",
} as const;
export type ReviewStatus = ValueOf<typeof ReviewStatus>;
export const zReviewStatus = z.enum(ReviewStatus);

/** What a stage says about a finding from an earlier run that is still open. */
export const ReviewOutcome = {
  fixed: "fixed",
  accepted: "accepted",
  stillOpen: "still_open",
} as const;
export type ReviewOutcome = ValueOf<typeof ReviewOutcome>;
export const zReviewOutcome = z.enum(ReviewOutcome);

const text = (max: number) => z.string().trim().min(1).max(max);

/** One finding, as the issue specifies it: `{stage, severity, file, line, summary, failure_scenario}`. */
export const zReviewFinding = z.object({
  stage: zReviewStage,
  severity: zReviewSeverity,
  /** Repo-relative path, or "" for a finding about the PR as a whole. */
  file: z.string().max(Limits.reviewMaxTextChars.value),
  /** 1-based line in the PR's head, or null for a whole-file (or whole-PR) finding. */
  line: z.number().int().min(1).nullable(),
  summary: text(Limits.reviewMaxTextChars.value),
  failure_scenario: text(Limits.reviewMaxTextChars.value),
});
export type ReviewFinding = z.infer<typeof zReviewFinding>;
