import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

/**
 * PLT-8 (HOU-141): the key that deploys the real house lives only in the `production` environment,
 * which only main may use. A pull_request workflow runs from the PR's own branch, so it must never ask
 * for that key or that environment; the environment's branch rule would refuse it anyway.
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
const environmentName = (env: unknown) => (typeof env === "string" ? env : z.object({ name: z.string() }).safeParse(env).data?.name);

describe("the deploy key", () => {
  it("[PLT-8] is read only by deploy.yml's jobs that run in the production environment", () => {
    const readers = workflows.flatMap(({ file, workflow }) =>
      Object.entries(workflow.jobs)
        .filter(([, job]) => JSON.stringify(job).includes("secrets.HOUSEHOLD_SSH_KEY"))
        .map(([name, job]) => ({ file, name, environment: environmentName(job.environment) })),
    );
    expect(readers).toEqual([
      { file: "deploy.yml", name: "ready", environment: "production" },
      { file: "deploy.yml", name: "deploy", environment: "production" },
    ]);
  });

  it("[PLT-8] is out of reach of every workflow a pull request runs", () => {
    const onPullRequest = workflows.filter(({ workflow }) => triggers(workflow.on).some((t) => t.startsWith("pull_request")));
    expect(onPullRequest.map((w) => w.file).sort()).toEqual(["ci.yml", "preview.yml"]);
    for (const { file, text, workflow } of onPullRequest) {
      expect(text, file).not.toContain("HOUSEHOLD_SSH_KEY");
      expect(Object.values(workflow.jobs).map((j) => environmentName(j.environment)), file).not.toContain("production");
    }
  });
});
