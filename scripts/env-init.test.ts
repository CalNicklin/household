import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const script = path.resolve(import.meta.dirname, "env-init.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function envInit(env: string | null, ...args: string[]): { out: string; env: string; rewritten: boolean; mode: number } {
  const dir = mkdtempSync(path.join(tmpdir(), "env-init-"));
  dirs.push(dir);
  if (env !== null) writeFileSync(path.join(dir, ".env"), env);
  const before = env === null ? null : statSync(path.join(dir, ".env")).ino;
  const out = execFileSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
  expect(readdirSync(dir).filter((f) => f.startsWith(".env.tmp"))).toEqual([]);
  const after = statSync(path.join(dir, ".env"));
  return { out, env: readFileSync(path.join(dir, ".env"), "utf8"), rewritten: before !== after.ino, mode: after.mode & 0o777 };
}

// HOU-168: the credentials in the old .env are made up per run, so no literal one is in the repo.
const made = () => randomBytes(9).toString("base64url");
const OLD_SECRETS = {
  POSTGRES_PASSWORD: made(),
  SESSION_SECRET: made(),
  STORAGE_KEY: made(),
  S3_SECRET_ACCESS_KEY: made(),
  HELPER_TOKEN: made(),
  TELEGRAM_WEBHOOK_SECRET: made(),
  EMAIL_WEBHOOK_SECRET: made(),
  CALENDAR_WEBHOOK_TOKEN: made(),
  MCP_TOKEN: made(),
  TELEGRAM_BOT_TOKEN: `123:${made()}`,
};
const old = (name: keyof typeof OLD_SECRETS) => `${name}=${OLD_SECRETS[name]}`;

// A .env as install.sh wrote it before HOU-148: no MODEL_PROVIDER or MODEL_ID, credentials filled in by hand.
const OLD = [
  "PRACTICE=false",
  "DB_PREFIX=home",
  "HOUSEHOLD_ID=home",
  old("POSTGRES_PASSWORD"),
  old("SESSION_SECRET"),
  old("STORAGE_KEY"),
  "S3_ACCESS_KEY_ID=household-old",
  old("S3_SECRET_ACCESS_KEY"),
  old("HELPER_TOKEN"),
  old("TELEGRAM_WEBHOOK_SECRET"),
  old("EMAIL_WEBHOOK_SECRET"),
  old("CALENDAR_WEBHOOK_TOKEN"),
  old("MCP_TOKEN"),
  `PRACTICE_SUPERMARKET_PASSWORD=${made()}`,
  "SUPERMARKET_SECRET_FILE=./.secrets/waitrose.json",
  "# Cal's note",
  old("TELEGRAM_BOT_TOKEN"),
  "ANTHROPIC_API_KEY=",
  "HOUSEHOLD_DOMAIN=house.example.com",
  "HINDSIGHT_NETWORK=hindsight-net",
].join("\n");

describe("env-init", () => {
  test("[HOU-160] an old .env with no MODEL_PROVIDER gets the real model added; every line already there is kept as it was", () => {
    const { out, env } = envInit(`${OLD}\n`, "--real");
    expect(env.startsWith(`${OLD}\n`)).toBe(true);
    expect(env.slice(OLD.length + 1)).toBe("MODEL_PROVIDER=anthropic\nMODEL_ID=claude-opus-5-5\n");
    // Names only: no value it read or made is printed.
    expect(out).toContain("added to .env: MODEL_PROVIDER, MODEL_ID");
    for (const secret of Object.values(OLD_SECRETS)) expect(out).not.toContain(secret);
  });

  test("[HOU-160] a second run adds nothing and changes nothing; a setting written empty is filled in place", () => {
    const once = envInit(null, "--real");
    expect(once.out).toContain("added to .env: PRACTICE, DB_PREFIX, HOUSEHOLD_ID, MODEL_PROVIDER, MODEL_ID");
    const twice = envInit(once.env, "--real");
    expect(twice.env).toBe(once.env);
    // Nothing to add: .env is not written at all (not even rewritten with the same bytes).
    expect(twice.rewritten).toBe(false);
    expect(once.rewritten).toBe(true);
    // A .env it writes is readable by its owner only.
    expect(once.mode).toBe(0o600);
    expect(envInit("PRACTICE=false\n", "--real")).toMatchObject({ rewritten: true, mode: 0o600 });
    expect(twice.out).toContain("added to .env: nothing");
    expect(twice.out).toContain("left .env as it was");
    const emptied = envInit(once.env.replace(/^MCP_TOKEN=.*$/m, "MCP_TOKEN=").replace(/^MODEL_ID=.*\n/m, ""), "--real");
    expect(emptied.out).toContain("added to .env: MODEL_ID, MCP_TOKEN");
    expect(emptied.env).toMatch(/^MCP_TOKEN=.{8,}$/m);
    expect(emptied.env.match(/^MCP_TOKEN=/gm)).toHaveLength(1);
    // A value already there is never replaced: another provider, or even the practice model (which the
    // real house then refuses at startup, naming the fix, rather than env-init changing it silently).
    expect(envInit("PRACTICE=false\nMODEL_PROVIDER=openai\n", "--real").env).toMatch(/^PRACTICE=false\nMODEL_PROVIDER=openai\n/);
    expect(envInit("PRACTICE=false\nMODEL_PROVIDER=practice\n", "--real").env).toMatch(/^PRACTICE=false\nMODEL_PROVIDER=practice\n/);
  });

  test("[HOU-160] install.sh runs it on every run, not only when .env is new", () => {
    const install = readFileSync(path.resolve(import.meta.dirname, "../deploy/install.sh"), "utf8");
    expect(install).toMatch(/^added="\$\(docker run .* node \/env-init\.ts --real \|/m);
    expect(install).not.toMatch(/if \[ ! -f "\$dir\/\.env" \]/);
  });
});
