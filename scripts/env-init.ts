import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * PLT-8 / PRV-6: generate every secret docker compose needs, at random, into `.env` and `.secrets/`
 * (both git-ignored). Nothing secret has a default in the repo. Re-running keeps existing values.
 *   pnpm env:init            → a practice household (the default)
 *   pnpm env:init --real     → the real house: PRACTICE=false; then fill in the credentials in .env
 */
const real = process.argv.includes("--real");
const random = (bytes = 24) => randomBytes(bytes).toString("base64url");
const existing = new Map<string, string>();
if (existsSync(".env"))
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined && m[2] !== "") existing.set(m[1], m[2]);
  }
const keep = (name: string, make: () => string) => existing.get(name) ?? make();

const values: Record<string, string> = {
  PRACTICE: keep("PRACTICE", () => (real ? "false" : "true")),
  DB_PREFIX: keep("DB_PREFIX", () => (real ? "home" : "practice")),
  // PLT-6: the household's Hindsight banks are named after it (household-<id>-person-<person>).
  HOUSEHOLD_ID: keep("HOUSEHOLD_ID", () => (real ? "home" : "practice")),
  POSTGRES_PASSWORD: keep("POSTGRES_PASSWORD", () => random()),
  SESSION_SECRET: keep("SESSION_SECRET", () => random(32)),
  STORAGE_KEY: keep("STORAGE_KEY", () => randomBytes(32).toString("hex")),
  S3_ACCESS_KEY_ID: keep("S3_ACCESS_KEY_ID", () => `household-${random(6)}`),
  S3_SECRET_ACCESS_KEY: keep("S3_SECRET_ACCESS_KEY", () => random(32)),
  HELPER_TOKEN: keep("HELPER_TOKEN", () => random()),
  TELEGRAM_WEBHOOK_SECRET: keep("TELEGRAM_WEBHOOK_SECRET", () => random()),
  EMAIL_WEBHOOK_SECRET: keep("EMAIL_WEBHOOK_SECRET", () => random()),
  CALENDAR_WEBHOOK_TOKEN: keep("CALENDAR_WEBHOOK_TOKEN", () => random()),
  MCP_TOKEN: keep("MCP_TOKEN", () => random()),
  PRACTICE_SUPERMARKET_PASSWORD: keep("PRACTICE_SUPERMARKET_PASSWORD", () => random()),
  SUPERMARKET_SECRET_FILE: keep("SUPERMARKET_SECRET_FILE", () => (real ? "./.secrets/waitrose.json" : "./.secrets/supermarket.json")),
};
const rest = [...existing.entries()].filter(([k]) => !(k in values)).map(([k, v]) => `${k}=${v}`);
writeFileSync(".env", `${[...Object.entries(values).map(([k, v]) => `${k}=${v}`), ...rest].join("\n")}\n`, { mode: 0o600 });

mkdirSync(".secrets", { recursive: true, mode: 0o700 });
writeFileSync(
  ".secrets/seaweedfs-s3.json",
  JSON.stringify({ identities: [{ name: "household", credentials: [{ accessKey: values["S3_ACCESS_KEY_ID"], secretKey: values["S3_SECRET_ACCESS_KEY"] }], actions: ["Admin", "Read", "Write", "List", "Tagging"] }] }, null, 2),
  { mode: 0o600 },
);
chmodSync(".secrets/seaweedfs-s3.json", 0o644);
if (!real) writeFileSync(".secrets/supermarket.json", JSON.stringify({ url: "http://supermarket:3002", username: "practice-shopper", password: values["PRACTICE_SUPERMARKET_PASSWORD"] }), { mode: 0o600 });
console.log(
  [
    `wrote .env and .secrets/ (${real ? "the real house" : "a practice household"})`,
    "The shopping helper runs as uid 1001 and refuses a login file anyone else can read:",
    `  sudo chown 1001 ${values["SUPERMARKET_SECRET_FILE"]} && chmod 600 ${values["SUPERMARKET_SECRET_FILE"]}`,
    real ? "Now fill in ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, the Google settings and the Waitrose login file (see .env.example)." : "",
  ]
    .filter((l) => l !== "")
    .join("\n"),
);
