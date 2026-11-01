import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

/**
 * FB-5 on Cal's VPS: each PR's preview is its own compose project next to the real house. It runs the
 * practice household on fakes, inside a fixed memory budget, and shares nothing with the house but
 * the house's Caddy in front of it. deploy/test-preview.sh drives the real thing against Docker.
 */
const zService = z.looseObject({
  image: z.string().optional(),
  build: z.unknown().optional(),
  mem_limit: z.string().optional(),
  memswap_limit: z.string().optional(),
  ports: z.array(z.string()).optional(),
  expose: z.array(z.string()).optional(),
  env_file: z.unknown().optional(),
  privileged: z.boolean().optional(),
  network_mode: z.string().optional(),
  volumes: z.array(z.string()).optional(),
  environment: z.union([z.record(z.string(), z.string()), z.array(z.string())]).optional(),
  networks: z.union([z.array(z.string()), z.record(z.string(), z.unknown())]).optional(),
});
const zNetwork = z.looseObject({ name: z.string().optional(), external: z.boolean().optional(), internal: z.boolean().optional() });
const zCompose = z.looseObject({
  "x-memory": z.record(z.string(), z.string()).optional(),
  services: z.record(z.string(), zService),
  networks: z.record(z.string(), zNetwork).optional(),
  volumes: z.record(z.string(), z.unknown()).optional(),
});

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const preview = zCompose.parse(parse(read("compose.preview.yml"), { merge: true }));
const house = zCompose.parse(parse(read("compose.yml"), { merge: true }));
const overlay = zCompose.parse(parse(read("compose.caddy-previews.yml")));
const workflow = z
  .looseObject({
    on: z.looseObject({ pull_request: z.looseObject({ types: z.array(z.string()) }) }),
    permissions: z.record(z.string(), z.string()),
    jobs: z.record(z.string(), z.looseObject({ if: z.string().optional(), needs: z.string().optional(), permissions: z.record(z.string(), z.string()).optional(), steps: z.array(z.looseObject({ run: z.string().optional(), env: z.record(z.string(), z.string()).optional() })).optional() })),
  })
  .parse(parse(read("../.github/workflows/preview.yml")));

const zSteps = z.looseObject({
  jobs: z.looseObject({ image: z.looseObject({ steps: z.array(z.looseObject({ id: z.string().optional(), uses: z.string().optional(), with: z.record(z.string(), z.unknown()).optional() })) }) }),
});

/** The budget household-preview uses unless household.conf says otherwise (household-common.sh). */
const DEFAULT_BUDGET_MB = Number(/PREVIEW_BUDGET_MB="\$\{PREVIEW_BUDGET_MB:-(\d+)\}"/.exec(read("household-common.sh"))?.[1]);

function megabytes(limit: string): number {
  const m = /^(\d+)m$/.exec(limit);
  if (m?.[1] === undefined) throw new Error(`household-preview reads caps only in m, not ${limit}`);
  return Number(m[1]);
}

describe("a PR's preview", () => {
  it("[FB-5] has a hard memory cap on every container, set in x-memory, and two previews fit in the 600 MB budget", () => {
    const services = Object.entries(preview.services);
    expect(services.map(([name]) => name).sort()).toEqual(["app", "postgres"]);
    const caps = preview["x-memory"] ?? {};
    expect(Object.keys(caps).sort()).toEqual(["app", "postgres"]);
    for (const [name, s] of services) {
      expect(s.mem_limit, `${name}'s cap is not its x-memory value`).toBe(caps[name]);
      expect(s.memswap_limit, `${name} may swap past its cap`).toBe(s.mem_limit);
    }
    const cost = Object.values(caps).reduce((sum, cap) => sum + megabytes(cap), 0);
    expect(DEFAULT_BUDGET_MB).toBe(600);
    expect(Math.floor(DEFAULT_BUDGET_MB / cost)).toBe(2);
  });

  it("[FB-5] runs the practice household on its own, with nothing of the real house's", () => {
    const app = preview.services["app"];
    expect(app?.image).toMatch(/^\$\{PREVIEW_IMAGE:\?.*\}$/);
    expect(app?.environment).toMatchObject({ PRACTICE: "true", HELPER_URL: "", DATABASE_URL: "postgres://postgres@postgres:5432/postgres" });
    const env = Object.keys(app?.environment ?? {});
    // None of the real house's secrets or settings (deploy/compose.yml, scripts/env-init.ts).
    for (const name of ["POSTGRES_PASSWORD", "STORAGE_KEY", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "HINDSIGHT_URL", "GOOGLE_ACCESS_TOKEN_FILE"]) expect(env).not.toContain(name);
    for (const [name, s] of Object.entries(preview.services)) {
      expect(s.env_file, `${name} reads an env file`).toBeUndefined();
      expect(s.ports, `${name} publishes a port`).toBeUndefined();
      expect(s.network_mode).toBeUndefined();
      expect(s.privileged ?? false).toBe(false);
      expect(s.build, `${name} would build on the server`).toBeUndefined();
      // Only its own named volumes: no host path, so not the house's files, credentials or the Docker socket.
      for (const v of s.volumes ?? []) expect(Object.keys(preview.volumes ?? {}), `${name} mounts ${v}`).toContain(v.split(":")[0]);
    }
    // A PR's image is unreviewed code: not root, no capabilities, no escalation, bounded CPU and processes.
    for (const [name, s] of Object.entries(preview.services)) {
      expect(s["user"], `${name} may run as root`).toMatch(/^[1-9]\d*:[1-9]\d*$/);
      expect(s["cap_drop"], `${name} keeps capabilities`).toEqual(["ALL"]);
      expect(s["security_opt"]).toEqual(["no-new-privileges:true"]);
      expect(s["cpus"], `${name} may take every core`).toBeLessThan(1);
      expect(s["pids_limit"], `${name} has no process limit`).toBeGreaterThan(0);
    }
    // Nothing runs on a token or secret whose practice default is published in server/env.ts.
    for (const name of ["SESSION_SECRET", "MCP_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "EMAIL_WEBHOOK_SECRET", "CALENDAR_WEBHOOK_TOKEN", "HELPER_TOKEN"])
      expect(app?.environment, name).toMatchObject({ [name]: `\${PREVIEW_${name}:?}` });
    // Its volumes are its own (compose prefixes them with household-pr-<n>), never the house's.
    expect(Object.keys(preview.volumes ?? {}).sort()).toEqual(["objects", "pgdata"]);
  });

  it("[FB-5] is on internal networks only: its own, and household-previews, where only the house's Caddy joins it", () => {
    expect(preview.networks?.["default"]).toMatchObject({ internal: true });
    expect(preview.networks?.["previews"]).toMatchObject({ name: "household-previews", external: true });
    expect(preview.services["postgres"]?.networks).toBeUndefined();
    expect(preview.services["app"]?.networks).toMatchObject({ previews: { aliases: ["pr-${PREVIEW_NUMBER:?}"] } });
    // The overlay adds the previews network to the house's Caddy and nothing else of the house's.
    expect(Object.keys(overlay.services)).toEqual(["caddy"]);
    expect(overlay.services["caddy"]?.networks).toEqual(["default", "previews"]);
    expect(overlay.networks?.["previews"]).toMatchObject({ name: "household-previews", external: true });
    for (const [name, s] of Object.entries(house.services)) expect(s.networks, `the house's ${name} names a network`).toBeUndefined();
    expect(read("household-common.sh")).toMatch(/\^PREVIEW_DOMAIN=\.\+.*compose\.caddy-previews\.yml/);
  });

  it("[FB-5] is served at pr-<n>.<preview domain>, with a certificate only while it runs", () => {
    const main = read("Caddyfile");
    const sites = read("Caddyfile.previews");
    const ask = /on_demand_tls \{\s*ask (http:\/\/127\.0\.0\.1:\d+)\/\s*\}/.exec(main)?.[1];
    expect(ask).toBeDefined();
    expect(sites).toContain(`${ask ?? ""} {\n\tbind 127.0.0.1`);
    expect(main).toMatch(/^import \/etc\/caddy\/previews\/\*\.caddy$/m);
    expect(overlay.services["caddy"]?.volumes).toContain("./Caddyfile.previews:/etc/caddy/previews/previews.caddy:ro");
    expect(sites).toMatch(/^\*\.\{\$PREVIEW_DOMAIN\} \{\n\ttls \{\n\t\ton_demand\n\t\}/m);
    expect(sites).toContain("header_regexp preview Host ^(pr-[1-9][0-9]{0,5})\\.");
  });
});

describe("household-preview", () => {
  const script = fileURLToPath(new URL("household-preview.sh", import.meta.url));
  function run(args: string[]): number | null {
    const dir = mkdtempSync(join(tmpdir(), "preview-"));
    try {
      writeFileSync(join(dir, ".env"), "PREVIEW_DOMAIN=preview.example.com\n");
      writeFileSync(join(dir, "household.conf"), `HOUSEHOLD_DIR=${dir}\nPREVIEWS_DIR=${join(dir, "previews")}\n`);
      return spawnSync("bash", [script, ...args], { env: { PATH: process.env["PATH"] ?? "", HOUSEHOLD_CONF: join(dir, "household.conf") }, stdio: "ignore" }).status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const digest = `sha256:${"a".repeat(64)}`;

  it("[FB-5] accepts only `preview <n> sha256:<digest>` and `preview-stop <n>`, as one argument", () => {
    for (const bad of [[], [""], ["preview"], [`preview 0 ${digest}`], [`preview 01 ${digest}`], [`preview 1234567 ${digest}`], ["preview 1 latest"], [`preview 1 ${digest}; id`], [`preview 1 ${digest} x`], ["preview-stop 1; reboot"], ["preview-stop ../1"], ["preview-stop", "1"], [digest]])
      expect(run(bad), JSON.stringify(bad)).toBe(2);
    // Well-formed: past the check, it stops only because this is not a server with previews set up.
    expect(run([`preview 12 ${digest}`])).toBe(1);
    expect(run(["preview-stop 12"])).toBe(1);
  });
});

describe("the preview workflow", () => {
  it("[FB-5] never runs for a fork, starts with no permissions, and removes the preview when the PR closes", () => {
    expect(workflow.on.pull_request.types).toEqual(expect.arrayContaining(["opened", "synchronize", "reopened", "closed"]));
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs["ready"]?.if).toBe("github.event.pull_request.head.repo.full_name == github.repository");
    const after = Object.entries(workflow.jobs).filter(([name]) => name !== "ready");
    expect(after.map(([name, job]) => [name, job.needs])).toEqual([
      ["image", "ready"],
      ["deploy", "image"],
      ["stop", "ready"],
    ]);
    expect(workflow.jobs["stop"]?.if).toContain("github.event.action == 'closed'");
    expect(workflow.jobs["image"]?.if).toContain("github.event.action != 'closed'");
  });

  it("[PLT-8] builds the image on every same-repo PR, preview secrets or not, and pushes and deploys only with them", () => {
    // HOU-145: an image that can't build fails this PR's `image` job, not main's deploy after the merge.
    expect(workflow.jobs["image"]?.if).toBe("github.event.action != 'closed'");
    const text = read("../.github/workflows/preview.yml");
    expect(text).toContain("push: ${{ needs.ready.outputs.configured == 'true' }}");
    expect(text).toContain("pushed: ${{ needs.ready.outputs.configured }}");
    expect(workflow.jobs["deploy"]?.if).toBe("needs.image.outputs.pushed == 'true'");
    // The same build as deploy.yml's: the same buildx setup and build action, given the same inputs but
    // where it pushes and what it is called.
    const build = (file: string) => {
      const steps = zSteps.parse(parse(read(file))).jobs.image.steps;
      const setup = steps.filter((s) => s.uses?.startsWith("docker/setup-buildx-action@"));
      const push = steps.find((s) => s.id === "build");
      const { tags: _tags, push: _push, ...inputs } = push?.with ?? {};
      return { setup, uses: push?.uses, inputs };
    };
    expect(build("../.github/workflows/preview.yml")).toEqual(build("../.github/workflows/deploy.yml"));
    expect(build("../.github/workflows/deploy.yml")).toMatchObject({ uses: "docker/build-push-action@v6", inputs: { context: "." } });
  });

  it("[FB-5] asks the server for only the two preview forms, with the preview key, never the deploy key", () => {
    const runs = Object.values(workflow.jobs).flatMap((j) => j.steps ?? []);
    const ssh = runs.flatMap((s) => (s.run ?? "").split("\n").filter((l) => l.includes("ssh ")));
    expect(ssh).toHaveLength(2);
    expect(ssh[0]).toMatch(/"household@\$SSH_HOST" "preview \$PR \$DIGEST"/);
    expect(ssh[1]).toMatch(/"household@\$SSH_HOST" "preview-stop \$PR"/);
    const keys = runs.map((s) => s.env?.["SSH_KEY"]).filter((k) => k !== undefined);
    expect(keys).toEqual(["${{ secrets.HOUSEHOLD_PREVIEW_SSH_KEY }}", "${{ secrets.HOUSEHOLD_PREVIEW_SSH_KEY }}"]);
    expect(read("../.github/workflows/preview.yml")).not.toContain("secrets.HOUSEHOLD_SSH_KEY");
    // PR images go to their own package, which household-deploy (HOUSEHOLD_REPO) never pulls from.
    expect(read("../.github/workflows/preview.yml")).toContain("tags: ghcr.io/calnicklin/household-preview:pr-${{ github.event.pull_request.number }}");
    expect(read("household-common.sh")).toContain('PREVIEW_REPO="${PREVIEW_REPO:-ghcr.io/calnicklin/household-preview}"');
    expect(read("household-preview.sh")).toContain('image="$PREVIEW_REPO@$digest"');
  });
});
