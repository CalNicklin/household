import { Limits, type ReviewStage, ReviewStatus, type SlopRating } from "@household/contracts";
import { z } from "zod";
import { emptyState, type Merged, type Reply, type ReviewState, type StoredFinding, zReviewState } from "./state.ts";

/**
 * HOU-151: the review's only writes, and what it reads back from the PR. Run by the `agent-review` job,
 * whose token can write pull-request comments and nothing else; the model never runs there.
 */
const BOT = "github-actions[bot]";
const SUMMARY = "<!-- agent-review -->";
const STATE = /<!-- agent-review-state:([A-Za-z0-9+/=]+) -->/;
const FINDING = /<!-- agent-review:(AR-\d{1,5}) -->/;
/** Replies count only from people who can push here (a fork's author can still comment on a public repo). */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const zUser = z.object({ login: z.string() });
const zIssueComment = z.object({ id: z.number().int(), body: z.string().nullable().default(""), user: zUser.nullable() });
const zReviewComment = zIssueComment.extend({ in_reply_to_id: z.number().int().optional(), author_association: z.string() });

export class GitHub {
  private readonly api: string;
  private readonly token: string;
  readonly repo: string;
  constructor(api: string, token: string, repo: string) {
    this.api = api;
    this.token = token;
    this.repo = repo;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`not a repository: ${repo}`);
  }

  private async call(method: string, url: string, body?: unknown): Promise<Response> {
    const res = await fetch(url, {
      method,
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${this.token}`, "x-github-api-version": "2022-11-28", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new GitHubError(res.status, `${method} ${new URL(url).pathname} → ${res.status}`);
    return res;
  }

  async send<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown): Promise<T> {
    return schema.parse(await (await this.call(method, `${this.api}/repos/${this.repo}${path}`, body)).json());
  }

  /** Every page of a list, following the Link header. */
  async all<T>(schema: z.ZodType<T>, path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = `${this.api}/repos/${this.repo}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (url !== null) {
      const res: Response = await this.call("GET", url);
      out.push(...z.array(schema).parse(await res.json()));
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    }
    return out;
  }
}

class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Prior = { state: ReviewState; summaryId: number | null; replies: Map<number, Reply[]> };

/** The last run's state (from its summary comment) and the replies on each finding's comment. */
export async function readPrior(gh: GitHub, pr: number): Promise<Prior> {
  const comments = await gh.all(zIssueComment, `/issues/${pr}/comments`);
  const summary = comments.findLast((c) => c.user?.login === BOT && (c.body ?? "").startsWith(SUMMARY));
  const encoded = STATE.exec(summary?.body ?? "")?.[1];
  let state = emptyState();
  if (encoded !== undefined) {
    const parsed = zReviewState.safeParse(safeJson(Buffer.from(encoded, "base64").toString("utf8")));
    if (parsed.success) state = parsed.data;
  }
  const reviewComments = await gh.all(zReviewComment, `/pulls/${pr}/comments`);
  const ours = new Set(reviewComments.filter((c) => c.user?.login === BOT && FINDING.test(c.body ?? "")).map((c) => c.id));
  const replies = new Map<number, Reply[]>();
  for (const c of reviewComments) {
    if (c.in_reply_to_id === undefined || !ours.has(c.in_reply_to_id) || c.user === null || c.user.login === BOT || !TRUSTED.has(c.author_association)) continue;
    const list = replies.get(c.in_reply_to_id) ?? [];
    list.push({ author: c.user.login, body: (c.body ?? "").slice(0, Limits.reviewMaxTextChars.value) });
    replies.set(c.in_reply_to_id, list);
  }
  return { state, summaryId: summary?.id ?? null, replies };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Model-written text on GitHub: no @-mentions (no one is pinged by a model), no forged markers. */
export function sanitise(s: string): string {
  return s
    .replaceAll(/@(?=[A-Za-z0-9-])/g, "@​")
    .replaceAll("<!--", "&lt;!--")
    .replaceAll("-->", "--&gt;");
}

const oneLine = (s: string) => sanitise(s.split("\n")[0] ?? "").replaceAll("|", "\\|");
const where = (f: Pick<StoredFinding, "file" | "line">) => (f.file === "" ? "the PR" : `\`${f.file.replaceAll("`", "")}${f.line === null ? "" : `:${f.line}`}\``);

function findingBody(f: StoredFinding): string {
  return [
    `**${f.id} · ${f.severity} · ${f.stage}**`,
    "",
    sanitise(f.summary),
    "",
    `**When:** ${sanitise(f.failure_scenario)}`,
    "",
    `<sub>${f.severity === "low" ? "A low never blocks; fix it or reply with the reason you won't." : "Blocks `agent-review` while open."} Fix it and push, or reply here with a reason; the next run reads the reply.</sub>`,
    `<!-- agent-review:${f.id} -->`,
  ].join("\n");
}

export type RunSummary = {
  sha: string;
  base: string;
  model: string;
  stages: { stage: ReviewStage; costMicros: number; steps: number; signal: boolean }[];
  slop: { rating: SlopRating | null; rationale: string | null };
};

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/** The summary comment: verdict, open findings, settled ones, cost, and the state for the next run. */
export function summaryBody(merged: Merged, run: RunSummary): string {
  // The state keeps each finding's text short; the full text is on the finding's own comment.
  const shorten = (n: number) => merged.state.findings.map((f) => ({ ...f, summary: f.summary.slice(0, n), failure_scenario: f.failure_scenario.slice(0, n), reason: f.reason?.slice(0, n) ?? null }));
  let findings = shorten(Limits.reviewStateTextChars.value);
  let tables = true;
  for (;;) {
    const body = renderSummary({ ...merged.state, findings }, run, tables);
    if (body.length <= Limits.reviewMaxCommentChars.value) return body;
    // Too long for GitHub. First forget the oldest settled finding (it may then be raised again)…
    const settled = findings.findIndex((f) => f.status !== ReviewStatus.open);
    if (settled !== -1) findings.splice(settled, 1);
    // …then list the open findings by count only (each still has its own comment), with a line of text each…
    else if (tables) {
      tables = false;
      findings = shorten(80).filter((f) => f.status === ReviewStatus.open);
    }
    // …then forget the oldest open finding (if it is still there, the next run raises it again).
    else findings.shift();
  }
}

const row = (f: StoredFinding, last: string) => `| ${f.id} | ${f.stage} | ${f.severity} | ${where(f)} | ${oneLine(f.summary)} | ${last} |`;

function renderSummary(state: ReviewState, run: RunSummary, tables: boolean): string {
  const merged = { state };
  const open = merged.state.findings.filter((f) => f.status === ReviewStatus.open);
  const settled = merged.state.findings.filter((f) => f.status !== ReviewStatus.open);
  const blocking = open.filter((f) => f.severity !== "low").length;
  const total = run.stages.reduce((s, x) => s + x.costMicros, 0);
  const lines = [
    SUMMARY,
    `## Agent review: ${blocking > 0 ? `✗ ${blocking} open medium or high finding${blocking === 1 ? "" : "s"} block this PR` : "✓ nothing blocks this PR"}`,
    "",
    `Reviewed \`${run.sha.slice(0, 7)}\` against its diff base \`${run.base.slice(0, 7)}\` with \`${run.model}\`. Cost ${dollars(total)} (${run.stages.map((s) => `${s.stage} ${dollars(s.costMicros)}, ${s.steps} steps`).join("; ")}).`,
    "",
    `**Slop:** ${run.slop.rating ?? "not rated"}${run.slop.rationale === null ? "" : ` — ${sanitise(run.slop.rationale).replaceAll("\n", " ")}`}`,
    "",
  ];
  if (open.length === 0) lines.push("No open findings.");
  else if (!tables) lines.push(`### Open (${open.length})`, "", "Too many to list here; each has its own comment.");
  else lines.push(`### Open (${open.length})`, "", "| | Stage | Severity | Where | Finding | |", "|---|---|---|---|---|---|", ...open.map((f) => row(f, f.commentId === null ? "not on a diff line" : "")));
  if (settled.length > 0 && tables) lines.push("", `<details><summary>Settled (${settled.length})</summary>`, "", "| | Stage | Severity | Where | Finding | Outcome |", "|---|---|---|---|---|---|", ...settled.map((f) => row(f, `${f.status}: ${oneLine(f.reason ?? "")}`)), "", "</details>");
  lines.push(
    "",
    "<sub>Each open finding has a comment on its line. Fix it and push, or reply to that comment with a reason and then push or re-run all jobs of the `agent-review` workflow. A finding that is settled (fixed, accepted, or not raised again) is not raised again unless its code changes.</sub>",
    `<!-- agent-review-state:${Buffer.from(JSON.stringify(merged.state)).toString("base64")} -->`,
  );
  return lines.join("\n");
}

const zCreated = z.object({ id: z.number().int() });

/**
 * Posts what changed on this push: a comment on each new finding's line (or its file when the line
 * isn't in the diff), a reply on each settled finding's comment, and the summary, edited in place.
 * Returns the state with the new comments' ids, as the summary stores it.
 */
export async function publish(gh: GitHub, pr: number, prior: Prior, merged: Merged, run: RunSummary, commentable: Map<string, Set<number>>): Promise<ReviewState> {
  const ids = new Map<string, number>();
  for (const f of merged.raised) {
    const lines = commentable.get(f.file);
    if (lines === undefined) continue;
    const anchor = f.line !== null && lines.has(f.line) ? { line: f.line, side: "RIGHT" } : { subject_type: "file" };
    try {
      ids.set(f.id, (await gh.send(zCreated, "POST", `/pulls/${pr}/comments`, { commit_id: run.sha, path: f.file, body: findingBody(f), ...anchor })).id);
    } catch (e) {
      // GitHub refuses a line it doesn't consider part of the diff; the finding stays in the summary.
      if (!(e instanceof GitHubError && e.status === 422)) throw e;
    }
  }
  for (const f of merged.settled) {
    if (f.commentId === null) continue;
    const reason = f.reason === null ? "" : ` ${sanitise(f.reason)}`;
    await gh.send(zCreated, "POST", `/pulls/${pr}/comments/${f.commentId}/replies`, { body: `**${f.id} ${f.status}** at \`${run.sha.slice(0, 7)}\`.${reason}` });
  }
  const state: ReviewState = { ...merged.state, findings: merged.state.findings.map((f) => (ids.has(f.id) ? { ...f, commentId: ids.get(f.id) ?? null } : f)) };
  const body = summaryBody({ ...merged, state }, run);
  if (prior.summaryId === null) await gh.send(zCreated, "POST", `/issues/${pr}/comments`, { body });
  else await gh.send(zCreated, "PATCH", `/issues/comments/${prior.summaryId}`, { body });
  return state;
}
