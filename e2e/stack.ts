import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { ensurePostgres } from "../server/testing/postgres.ts";
import { READY_PORT, type Stack, stack, STACKS } from "./stacks.ts";

/**
 * FB-3 / FB-5: the real app against the practice household, as a preview would run it — Postgres,
 * the practice supermarket, the sealed shopping helper with its own locked login, and the server.
 * FB-2: one such stack per Playwright worker (e2e/stacks.ts), all started at once; READY_PORT answers
 * once every stack's server does.
 */
const root = path.resolve(import.meta.dirname, "..");
const pg = await ensurePostgres();
const env = { ...process.env, DATABASE_URL: pg.url, PRACTICE: "true" };
const run = (name: string, args: string[], extra: Record<string, string>) => {
  const child = spawn("node", args, { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) process.stderr.write(`[${name}] exited ${code}\n`);
  });
  return child;
};

function start(own: Stack): ChildProcess[] {
  // A clean helper every run: nothing remembered from earlier runs.
  rmSync(path.join(own.dataDir, "helper"), { recursive: true, force: true });
  mkdirSync(own.dataDir, { recursive: true });
  const shopPassword = randomBytes(18).toString("base64url");
  writeFileSync(own.creds, JSON.stringify({ url: `http://localhost:${own.shop}`, username: "practice-shopper", password: shopPassword }));
  chmodSync(own.creds, 0o600);
  // HOU-168: the helper's token is made up per run too; the journeys read it from this file.
  const helperToken = randomBytes(18).toString("base64url");
  writeFileSync(own.helperTokenFile, helperToken, { mode: 0o600 });
  return [
    run(`shop ${own.index}`, ["practice/supermarket/main.ts"], { PORT: String(own.shop), PRACTICE_SUPERMARKET_PASSWORD: shopPassword }),
    run(`helper ${own.index}`, ["helper/main.ts"], { PORT: String(own.helper), HELPER_TOKEN: helperToken, SUPERMARKET_CREDENTIALS_FILE: own.creds, HELPER_DATA_DIR: path.join(own.dataDir, "helper") }),
    run(`server ${own.index}`, ["server/main.ts"], { PORT: String(own.server), DB_PREFIX: own.dbPrefix, HELPER_URL: `http://localhost:${own.helper}`, HELPER_TOKEN: helperToken, PUBLIC_URL: `http://localhost:${own.server}` }),
  ];
}

const stacks = Array.from({ length: STACKS }, (_, i) => stack(i));
const children = stacks.flatMap(start);

async function up(own: Stack): Promise<boolean> {
  try {
    return (await fetch(`http://localhost:${own.server}/healthz`)).ok;
  } catch {
    return false;
  }
}
const ready = createServer((_req, res) => {
  void (async () => {
    const ok = await Promise.all(stacks.map(up));
    res.writeHead(ok.every(Boolean) ? 200 : 503).end();
  })();
}).listen(READY_PORT);

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  ready.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
