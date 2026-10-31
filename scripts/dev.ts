import { spawn } from "node:child_process";
import { ensurePostgres } from "../server/testing/postgres.ts";

/**
 * FB-1: the whole system locally with one command — Postgres (local or embedded), the practice
 * supermarket and shopping helper, the server with watch, and the Vite dev server with HMR.
 */
const pg = await ensurePostgres();
const env = { ...process.env, DATABASE_URL: process.env["DATABASE_URL"] ?? pg.url, PRACTICE: "true" };
const run = (name: string, cmd: string, args: string[], extra: Record<string, string> = {}) => {
  const child = spawn(cmd, args, { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = (chunk: Buffer) => process.stdout.write(chunk.toString().replace(/^/gm, `[${name}] `));
  child.stdout.on("data", tag);
  child.stderr.on("data", tag);
  child.on("exit", (code) => process.stdout.write(`[${name}] exited ${code}\n`));
  return child;
};
run("shop", "node", ["practice/supermarket/main.ts"], { PORT: "3002" });
run("server", "node", ["--watch-path=server", "--watch-path=contracts", "--watch-path=practice", "server/main.ts"], { PORT: "3001" });
run("web", "pnpm", ["run", "dev:web", "--port", "3000", "--strictPort"]);
