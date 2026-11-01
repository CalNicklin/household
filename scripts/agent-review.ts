import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { blockingSeverities, ModelProvider, ReviewStage } from "@household/contracts";
import { z } from "zod";
import { languageModel } from "../server/agent/model.ts";
import { commentableLines, diffBase, prDiff } from "./review/diff.ts";
import { GitHub, publish, readPrior, type RunSummary } from "./review/github.ts";
import { DEFAULT_REVIEW_MODEL, GitTrees, reviewContext, runStage, stagePrompt, type StageResult, toStageAnswer, zModelAnswer } from "./review/model.ts";
import { type Answers, merge, priorFor, zReviewState } from "./review/state.ts";

/**
 * HOU-151: the agent review in CI (.github/workflows/agent-review.yml). Always run from the base
 * branch's checkout; the PR's head is only ever read, from a second checkout, through git.
 *
 *   node scripts/agent-review.ts prior  --pr <n> --out prior.json                    GH_TOKEN (read)
 *   node scripts/agent-review.ts review --checkout pr --base <sha> --head <sha> --prior prior.json --out answers.json
 *                                                                                    ANTHROPIC_API_KEY only
 *   node scripts/agent-review.ts post   --checkout pr --base <sha> --head <sha> --pr <n> --answers answers.json
 *                                                                                    GH_TOKEN (pull-requests: write)
 *
 * `review` reads the PR's title and body from GITHUB_EVENT_PATH. `post` exits 1 while any open finding
 * is medium or high: that is the `agent-review` check.
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { pr: { type: "string" }, out: { type: "string" }, checkout: { type: "string" }, base: { type: "string" }, head: { type: "string" }, prior: { type: "string" }, answers: { type: "string" } },
});
const need = (name: keyof typeof values): string => {
  const v = values[name];
  if (typeof v !== "string" || v === "") throw new Error(`--${name} is required`);
  return v;
};
const env = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`${name} is not set`);
  return v;
};
const summary = (md: string) => {
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file !== undefined && file !== "") appendFileSync(file, `${md}\n`);
  process.stdout.write(`${md}\n`);
};
const github = () => new GitHub(process.env["GITHUB_API_URL"] ?? "https://api.github.com", env("GH_TOKEN"), env("GITHUB_REPOSITORY"));
/** --base is the base branch's tip from the event; the review reads from the diff base. */
const headTrees = () => new GitTrees(need("checkout"), diffBase(need("checkout"), need("base"), need("head")), need("head"));
const prNumber = () => z.coerce.number().int().min(1).parse(need("pr"));

const zPriorFile = z.object({ state: zReviewState, replies: z.array(z.tuple([z.string(), z.array(z.object({ author: z.string(), body: z.string() }))])) });
const zAnswersFile = z.object({
  sha: z.string(),
  base: z.string(),
  model: z.string(),
  stages: z.array(z.object({ stage: z.enum(ReviewStage), answer: zModelAnswer, costMicros: z.number(), steps: z.number().int(), usage: z.object({ input: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number() }) })),
});

const zEvent = z.object({ pull_request: z.object({ title: z.string(), body: z.string().nullable() }) });

async function reviewCommand(): Promise<void> {
  const trees = headTrees();
  const event = zEvent.parse(JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8")));
  const prior = zPriorFile.parse(JSON.parse(readFileSync(need("prior"), "utf8")));
  const replies = new Map(prior.replies);
  const diff = prDiff(trees.repo, trees.base, trees.head);
  const context = reviewContext({ title: event.pull_request.title, body: event.pull_request.body ?? "", trees, diff });
  const modelId = process.env["REVIEW_MODEL"] || DEFAULT_REVIEW_MODEL;
  const model = languageModel({ MODEL_PROVIDER: ModelProvider.anthropic, MODEL_ID: modelId });
  const run = (stage: ReviewStage, onFirstStep?: () => void) => runStage({ stage, model, modelId, prompt: stagePrompt(ROOT, stage), context, prior: priorFor(stage, prior.state, replies), trees, ...(onFirstStep === undefined ? {} : { onFirstStep }) });
  // The code stage writes the shared prefix to the cache; the other two start once it has, and read it.
  // If it fails, the other two never start.
  let warmed: ((ok: boolean) => void) | undefined;
  const warm = new Promise<boolean>((resolve) => (warmed = resolve));
  const first = run(ReviewStage.code, () => warmed?.(true));
  first.then(
    () => warmed?.(true),
    () => warmed?.(false),
  );
  const rest = warm.then((ok) => {
    if (!ok) throw new Error("the code stage failed");
    return Promise.all([run(ReviewStage.security), run(ReviewStage.slop)]);
  });
  rest.catch(() => undefined);
  const results: StageResult[] = [await first, ...(await rest)];
  const out = { sha: trees.head, base: trees.base, model: modelId, stages: results.map(({ stage, answer, costMicros, steps, usage }) => ({ stage, answer, costMicros, steps, usage })) };
  writeFileSync(need("out"), JSON.stringify(out, null, 1));
  const total = results.reduce((s, r) => s + r.costMicros, 0);
  summary(
    [
      `### Agent review cost: $${(total / 1_000_000).toFixed(4)} (${modelId})`,
      "",
      "| Stage | Steps | Input | Cache read | Cache write | Output | Cost |",
      "|---|---|---|---|---|---|---|",
      ...results.map((r) => `| ${r.stage} | ${r.steps} | ${r.usage.input} | ${r.usage.cacheRead} | ${r.usage.cacheWrite} | ${r.usage.output} | $${(r.costMicros / 1_000_000).toFixed(4)} |`),
    ].join("\n"),
  );
}

async function priorCommand(): Promise<void> {
  const p = await readPrior(github(), prNumber());
  writeFileSync(need("out"), JSON.stringify({ state: p.state, replies: [...p.replies] }));
}

async function postCommand(): Promise<void> {
  const gh = github();
  const pr = prNumber();
  const trees = headTrees();
  const file = zAnswersFile.parse(JSON.parse(readFileSync(need("answers"), "utf8")));
  if (file.sha !== trees.head || file.base !== trees.base) throw new Error("the answers are for another commit");
  const byStage = new Map(file.stages.map((s) => [s.stage, s]));
  const answerOf = (stage: ReviewStage) => {
    const s = byStage.get(stage);
    if (s === undefined) throw new Error(`no answer from the ${stage} stage`);
    return toStageAnswer(s.answer);
  };
  const answers: Answers = { code: answerOf(ReviewStage.code), security: answerOf(ReviewStage.security), slop: answerOf(ReviewStage.slop) };
  const diff = prDiff(trees.repo, trees.base, trees.head);
  const before = await readPrior(gh, pr);
  const merged = merge(before.state, answers, { sha: trees.head, read: (f) => trees.show("head", f), diff });
  const slop = byStage.get(ReviewStage.slop)?.answer;
  const run: RunSummary = {
    sha: trees.head,
    base: trees.base,
    model: file.model,
    stages: file.stages.map((s) => ({ stage: s.stage, costMicros: s.costMicros, steps: s.steps })),
    slop: { rating: slop?.rating ?? null, rationale: slop?.rationale ?? null },
  };
  const { failures } = await publish(gh, pr, before, merged, run, commentableLines(diff));
  for (const failure of failures) process.stdout.write(`::warning title=Agent review comment::${annotation(failure)}\n`);
  const blocking = merged.open.filter((f) => blockingSeverities.includes(f.severity));
  summary(`### agent-review: ${merged.blocking ? `✗ ${blocking.length} open medium or high` : "✓ nothing blocks"} (${merged.open.length} open, ${merged.raised.length} new, ${merged.settled.length} settled on this push)`);
  for (const f of blocking) process.stdout.write(`::error title=${f.id} ${f.severity} (${f.stage})::${annotation(`${f.file === "" ? "" : `${f.file}${f.line === null ? "" : `:${f.line}`} `}${f.summary}`)}\n`);
  if (merged.blocking) process.exit(1);
}

/** One line of an annotation: the first line only, with the characters workflow commands give meaning to escaped. */
const annotation = (s: string) => (s.split("\n")[0] ?? "").replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll(":", "%3A");

const commands: Record<string, () => Promise<void>> = { review: reviewCommand, prior: priorCommand, post: postCommand };
const command = commands[positionals[0] ?? ""];
if (command === undefined) {
  process.stderr.write("usage: node scripts/agent-review.ts prior|review|post …\n");
  process.exit(2);
}
await command();
