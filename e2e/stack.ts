import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensurePostgres } from "../server/testing/postgres.ts";

/**
 * FB-3 / FB-5: the real app against the practice household, as a preview would run it — Postgres,
 * the practice supermarket, the sealed shopping helper with its own locked login, and the server.
 */
export const PORTS = { server: 3101, shop: 3102, helper: 3103 } as const;
const root = path.resolve(import.meta.dirname, "..");
const data = path.join(root, ".data", "e2e");
// A clean helper every run: nothing remembered from earlier runs.
rmSync(path.join(data, "helper"), { recursive: true, force: true });
mkdirSync(data, { recursive: true });
const creds = path.join(data, "supermarket.json");
const shopPassword = randomBytes(18).toString("base64url");
writeFileSync(creds, JSON.stringify({ url: `http://localhost:${PORTS.shop}`, username: "practice-shopper", password: shopPassword }));
chmodSync(creds, 0o600);

const pg = await ensurePostgres();
const env = { ...process.env, DATABASE_URL: pg.url, PRACTICE: "true" };
const run = (name: string, args: string[], extra: Record<string, string>) => {
  const child = spawn("node", args, { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) process.stderr.write(`[${name}] exited ${code}\n`);
  });
  return child;
};
const children = [
  run("shop", ["practice/supermarket/main.ts"], { PORT: String(PORTS.shop), PRACTICE_SUPERMARKET_PASSWORD: shopPassword }),
  run("helper", ["helper/main.ts"], { PORT: String(PORTS.helper), HELPER_TOKEN: "e2e-helper-token", SUPERMARKET_CREDENTIALS_FILE: creds, HELPER_DATA_DIR: path.join(data, "helper") }),
  run("server", ["server/main.ts"], { PORT: String(PORTS.server), DB_PREFIX: "e2e", HELPER_URL: `http://localhost:${PORTS.helper}`, HELPER_TOKEN: "e2e-helper-token", PUBLIC_URL: `http://localhost:${PORTS.server}` }),
];
const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
