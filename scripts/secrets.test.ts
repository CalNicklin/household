import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
// Each sample's value is made here, at runtime, so the samples are not literals in this file either.
const made = () => randomBytes(9).toString("hex");

/** HOU-168: the secret scan's rules (.secretlintrc.yml), run on sample files; which samples does it flag? */
function flagged(samples: Record<string, string>): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), "secrets-"));
  try {
    const files = Object.entries(samples).map(([name, text]) => {
      const file = path.join(dir, name);
      writeFileSync(file, `${text}\n`);
      return file;
    });
    const r = spawnSync("pnpm", ["exec", "secretlint", "--secretlintrc", path.join(root, ".secretlintrc.yml"), "--maskSecrets", "--format", "unix", ...files], { cwd: root, encoding: "utf8" });
    return Object.keys(samples).filter((name) => r.stdout.includes(path.join(dir, name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the secret scan in pnpm check", () => {
  test("[HOU-168] flags a literal password, secret, token or key, a NAME=value setting with one, and a password in a URL", () => {
    const samples = {
      "object.ts": `login({ username: "sam", password: "${made()}" });`,
      "const.ts": `const WEBHOOK_SECRET = "${made()}";`,
      "header.ts": `headers: { "X-Telegram-Bot-Api-Secret-Token": "${made()}" }`,
      "parameter.ts": `const post = (secret = "${made()}") => secret;`,
      "key.ts": `const env = { ANTHROPIC_API_KEY: '${made()}' };`,
      "settings.env": `MCP_TOKEN=${made()}`,
      "script.sh": `echo "POSTGRES_PASSWORD=${made()}" >> .env`,
      "url.ts": `const url = "postgres://postgres:${made()}@localhost:5432/postgres";`,
    };
    expect(flagged(samples)).toEqual(Object.keys(samples));
  });

  test("[HOU-168] leaves alone values made at runtime, practice values from contracts, interpolations, empty settings and paging cursors", () => {
    expect(
      flagged({
        "runtime.ts": "const TOKEN = randomBytes(18).toString(\"base64url\");",
        "practice.ts": "export const PASSWORD = Practice.login;",
        "compose.yml": "POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?run pnpm env:init first}",
        "empty.env": "ANTHROPIC_API_KEY=",
        "regex.ts": "env.replace(/^MCP_TOKEN=.*$/m, \"MCP_TOKEN=\");",
        "cursor.ts": `json(res, 200, { items: [], nextSyncToken: "${made()}", nextPageToken: "${made()}" });`,
        "url.ts": "const url = \"postgres://postgres@localhost:5432/postgres\";",
      }),
    ).toEqual([]);
  });
});
