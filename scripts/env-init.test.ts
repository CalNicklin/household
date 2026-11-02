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

// A .env as install.sh wrote it before HOU-148: no MODEL_PROVIDER or MODEL_ID, credentials filled in by hand.
const OLD = [
  "PRACTICE=false",
  "DB_PREFIX=home",
  "HOUSEHOLD_ID=home",
  "POSTGRES_PASSWORD=pg-old",
  "SESSION_SECRET=session-old",
  "STORAGE_KEY=storage-old",
  "S3_ACCESS_KEY_ID=household-old",
  "S3_SECRET_ACCESS_KEY=s3-old",
  "HELPER_TOKEN=helper-old",
  "TELEGRAM_WEBHOOK_SECRET=tg-old",
  "EMAIL_WEBHOOK_SECRET=email-old",
  "CALENDAR_WEBHOOK_TOKEN=cal-old",
  "MCP_TOKEN=mcp-old",
  "PRACTICE_SUPERMARKET_PASSWORD=sm-old",
  "SUPERMARKET_SECRET_FILE=./.secrets/waitrose.json",
  "# Cal's note",
  "TELEGRAM_BOT_TOKEN=123:abc",
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
    for (const secret of ["pg-old", "session-old", "storage-old", "s3-old", "helper-old", "tg-old", "email-old", "cal-old", "mcp-old", "123:abc"]) expect(out).not.toContain(secret);
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
