import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { Domain } from "@household/contracts";
import { migrationsFolder } from "../db/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DEFAULT_URL = "postgres://postgres:postgres@localhost:5432/postgres";
const EMBEDDED_PORT = 54329;

async function reachable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const embeddedUrl = `postgres://postgres:postgres@localhost:${EMBEDDED_PORT}/postgres`;

/** Where the tests look for Postgres, in order; the last is the embedded server ensurePostgres starts. */
export function postgresCandidates(): string[] {
  return [process.env["TEST_DATABASE_URL"], process.env["DATABASE_URL"], DEFAULT_URL, embeddedUrl].filter((u): u is string => u !== undefined);
}

/**
 * A Postgres server for tests and local dev: `DATABASE_URL` if it answers, else the local default,
 * else an embedded Postgres started from node_modules, so a clean checkout needs nothing installed.
 */
export async function ensurePostgres(): Promise<{ url: string; stop: () => Promise<void> }> {
  for (const url of postgresCandidates()) if (await reachable(url)) return { url, stop: async () => {} };
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const databaseDir = path.join(ROOT, ".data", "pg-embedded");
  const pg = new EmbeddedPostgres({ databaseDir, port: EMBEDDED_PORT, user: "postgres", password: "postgres", persistent: true, onLog: () => {} });
  if (!existsSync(path.join(databaseDir, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  return { url: embeddedUrl, stop: () => pg.stop() };
}

/** Changes whenever a migration or the practice data changes, so templates rebuild themselves. */
export function templatePrefix(): string {
  const hash = createHash("sha256");
  for (const domain of Object.values(Domain)) {
    const folder = migrationsFolder(domain);
    for (const file of readdirSync(folder).filter((f) => f.endsWith(".sql")).sort()) hash.update(readFileSync(path.join(folder, file)));
  }
  for (const file of ["practice/data.ts", "practice/seed.ts"]) hash.update(readFileSync(path.join(ROOT, file)));
  return `tpl${hash.digest("hex").slice(0, 10)}`;
}
