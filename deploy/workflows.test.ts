import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Limits } from "@household/contracts";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

/**
 * PLT-8 (HOU-141): the key that deploys the real house lives only in the `production` environment,
 * which only main may use. A pull_request workflow runs from the PR's own branch, so it must never ask
 * for that key or that environment, or take every secret at once. (The branch rule alone doesn't stop
 * a workflow that exists only on some other branch, run by a PR whose head is main: docs/OPERATIONS.md.)
 */
const zWorkflow = z.looseObject({
  on: z.union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())]),
  jobs: z.record(z.string(), z.looseObject({ environment: z.unknown().optional() })),
});

const dir = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((file) => {
    const text = readFileSync(new URL(file, dir), "utf8");
    return { file, text, workflow: zWorkflow.parse(parse(text)) };
  });

const triggers = (on: z.infer<typeof zWorkflow>["on"]) => (typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on));
/** Names the key, picks a secret by a computed name, or takes every secret at once. */
const READS_KEY = /HOUSEHOLD_SSH_KEY\b|secrets\s*\[|toJSON\(\s*secrets\s*\)|secrets"?:\s*"?inherit/;
const environmentName = (env: unknown) => (typeof env === "string" ? env : z.object({ name: z.string() }).safeParse(env).data?.name);

describe("the deploy key", () => {
  it("[PLT-8] is read only by deploy.yml's jobs that run in the production environment", () => {
    const readers = workflows.flatMap(({ file, workflow }) =>
      Object.entries(workflow.jobs)
        .filter(([, job]) => READS_KEY.test(JSON.stringify(job)))
        .map(([name, job]) => ({ file, name, environment: environmentName(job.environment) })),
    );
    expect(readers).toEqual([
      { file: "deploy.yml", name: "ready", environment: "production" },
      { file: "deploy.yml", name: "deploy", environment: "production" },
    ]);
  });

  it("[PLT-8] is out of reach of every workflow a pull request runs", () => {
    const onPullRequest = workflows.filter(({ workflow }) => triggers(workflow.on).some((t) => t.startsWith("pull_request")));
    expect(onPullRequest.map((w) => w.file).sort()).toEqual(["agent-review.yml", "ci.yml", "preview.yml"]);
    for (const { file, text, workflow } of onPullRequest) {
      expect(text, file).not.toMatch(READS_KEY);
      expect(Object.values(workflow.jobs).map((j) => environmentName(j.environment)), file).not.toContain("production");
    }
  });
});

/**
 * HOU-151: the agent review. The model's job can read and can't write; only the model's own step holds
 * the Anthropic key, and it has no GitHub token; the job that writes comments holds no secret; nothing
 * from the PR's checkout runs, and the scripts and prompts come from the base.
 */
const zStep = z.looseObject({ id: z.string().optional(), if: z.string().optional(), name: z.string().optional(), uses: z.string().optional(), run: z.string().optional(), with: z.record(z.string(), z.unknown()).optional(), env: z.record(z.string(), z.unknown()).optional(), "working-directory": z.string().optional() });
const zJob = z.looseObject({ if: z.string(), permissions: z.record(z.string(), z.string()), "timeout-minutes": z.number(), steps: z.array(zStep) });
const review = (() => {
  const w = workflows.find((x) => x.file === "agent-review.yml");
  if (w === undefined) throw new Error("no agent-review.yml");
  const doc = z.looseObject({ permissions: z.record(z.string(), z.string()), jobs: z.object({ review: zJob, "agent-review": zJob }) }).parse(parse(w.text));
  return { text: w.text, ...doc };
})();

// Runs a job's decision step (whose scripts review the PR) as the runner would, in a checkout with or without the review.
const decide = (run: string, hasReview: boolean, baseRef: string) => {
  const checkout = mkdtempSync(path.join(tmpdir(), "agent-review-base-"));
  try {
    if (hasReview) {
      mkdirSync(path.join(checkout, "scripts"));
      mkdirSync(path.join(checkout, ".github/review"), { recursive: true });
      writeFileSync(path.join(checkout, "scripts/agent-review.ts"), "");
      writeFileSync(path.join(checkout, ".github/review/code.md"), "");
    }
    const out = path.join(checkout, "output");
    execFileSync("bash", ["-e", "-c", run], { cwd: checkout, env: { PATH: process.env["PATH"], GITHUB_OUTPUT: out, BASE_REF: baseRef, DEFAULT_BRANCH: "main" }, stdio: "pipe" });
    return readFileSync(out, "utf8").trim();
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
};

describe("HOU-151 the agent review workflow", () => {
  it("runs for this repository's PRs only, with no permission unless a job asks for it", () => {
    expect(review.permissions).toEqual({});
    for (const job of Object.values(review.jobs)) expect(job.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  it("the model's job can read and can't write; only the posting job can write, and only PR comments", () => {
    expect(review.jobs.review.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(review.jobs["agent-review"].permissions).toEqual({ contents: "read", "pull-requests": "write" });
  });

  it("the Anthropic key is only in the model's step, which has no GitHub token; the posting job has no secret", () => {
    const steps = Object.entries(review.jobs).flatMap(([job, j]) => j.steps.map((s) => ({ job, ...s })));
    const withKey = steps.filter((s) => JSON.stringify(s.env ?? {}).includes("secrets.REVIEW_ANTHROPIC_API_KEY }}"));
    expect(withKey.map((s) => [s.job, s.name])).toEqual([["review", "Review (the model; this step has the Anthropic key and no GitHub token)"]]);
    expect(Object.keys(withKey[0]?.env ?? {}).sort()).toEqual(["ANTHROPIC_API_KEY", "BASE", "HEAD", "REVIEW_MODEL"]);
    expect(JSON.stringify(withKey[0])).not.toMatch(/github\.token|GITHUB_TOKEN|GH_TOKEN/);
    expect(JSON.stringify(review.jobs["agent-review"])).not.toMatch(/secrets\./);
    // Elsewhere the key is only tested for being set.
    expect(review.text.match(/secrets\.\w+/g)?.sort()).toEqual(["secrets.REVIEW_ANTHROPIC_API_KEY", "secrets.REVIEW_ANTHROPIC_API_KEY"]);
  });

  it("checks out the base's scripts at the root (the PR's own only while the base has none) and the PR's head into pr/, with no token left", () => {
    for (const job of Object.values(review.jobs)) {
      const checkouts = job.steps.filter((s) => s.uses?.startsWith("actions/checkout@") === true);
      expect(checkouts.map((s) => [s.with?.["ref"], s.with?.["path"] ?? ".", s["if"]])).toEqual([
        ["${{ github.event.pull_request.base.sha }}", ".", expect.any(String)],
        ["${{ github.event.pull_request.head.sha }}", ".", "steps.base.outputs.from == 'head'"],
        ["${{ github.event.pull_request.head.sha }}", "pr", expect.any(String)],
      ]);
      for (const c of checkouts) expect(c.with?.["persist-credentials"]).toBe(false);
      for (const s of job.steps) {
        expect(s["working-directory"]).toBeUndefined();
        // pr/ is only ever passed to the scripts as the repository git reads.
        expect((s.run ?? "").replaceAll("--checkout pr ", "")).not.toMatch(/\bpr\//);
      }
      // Installs run no package's scripts.
      for (const s of job.steps.filter((x) => x.run?.includes("pnpm install") === true)) expect(s.run).toContain("--ignore-scripts");
    }
  });

  it("only a PR into the default branch, while it has no review, is reviewed with its own scripts", () => {
    for (const job of Object.values(review.jobs)) {
      const step = job.steps.find((s) => s.id === "base");
      expect(step?.env).toEqual({ BASE_REF: "${{ github.event.pull_request.base.ref }}", DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}" });
      const run = step?.run ?? "";
      expect(decide(run, true, "main")).toBe("from=base");
      expect(decide(run, true, "release")).toBe("from=base");
      expect(decide(run, false, "main")).toBe("from=head");
      expect(decide(run, false, "release")).toBe("from=none");
    }
    // In the review job, nothing past the decision runs when it says none.
    const after = review.jobs.review.steps.slice(review.jobs.review.steps.findIndex((s) => s.id === "base") + 1);
    for (const s of after) expect(s["if"]).toMatch(/steps\.base\.outputs\.from == 'head'/);
  });

  it("[CODE-13] the review job's timeout is the cited limit", () => {
    expect(review.jobs.review["timeout-minutes"]).toBe(Limits.reviewJobMinutes.value);
  });
});
