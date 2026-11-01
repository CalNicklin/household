import { randomBytes } from "node:crypto";
import { Domain } from "@household/contracts";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { migrateAll, seedPractice } from "../../practice/seed.ts";
import { databaseName, dropDatabases } from "../db/index.ts";
import { loadEnv } from "../env.ts";
import { ensurePostgres, templatePrefix } from "./postgres.ts";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    templatePrefix: string;
    runId: string;
  }
}

async function templateReady(url: string, prefix: string): Promise<boolean> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const rows = await client.query("select count(*)::int as n from pg_database where datname like $1", [`${prefix}\\_%`]);
    return rows.rows[0]?.n === Object.values(Domain).length;
  } finally {
    await client.end();
  }
}

/** Builds migrated + seeded template databases once; each test household is a cheap copy. */
export default async function setup(project: TestProject) {
  const pg = await ensurePostgres();
  // FB-2: CI declares its Postgres throwaway, so it can skip flushing to disk. Every test household
  // creates and drops databases, and each of those forced a full checkpoint. Never set locally.
  if (process.env["THROWAWAY_DATABASE"] === "true") {
    const client = new Client({ connectionString: pg.url });
    await client.connect();
    for (const setting of ["fsync", "synchronous_commit", "full_page_writes"]) await client.query(`alter system set ${setting} = off`);
    await client.query("select pg_reload_conf()");
    await client.end();
  }
  const prefix = templatePrefix();
  if (!(await templateReady(pg.url, prefix))) {
    const env = loadEnv({ DATABASE_URL: pg.url, DB_PREFIX: prefix });
    await dropDatabases(pg.url, prefix);
    await migrateAll(env);
    await seedPractice(env);
    // Templates cannot have open connections when copied.
    const client = new Client({ connectionString: pg.url });
    await client.connect();
    for (const d of Object.values(Domain)) await client.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [databaseName(prefix, d)]);
    await client.end();
  }
  // Several test runs can share one Postgres (agents in parallel): each only ever drops its own databases.
  const runId = randomBytes(3).toString("hex");
  project.provide("databaseUrl", pg.url);
  project.provide("templatePrefix", prefix);
  project.provide("runId", runId);
  return async () => {
    const client = new Client({ connectionString: pg.url });
    await client.connect();
    const stale = await client.query<{ datname: string }>("select datname from pg_database where datname like $1", [`r${runId}%`]);
    for (const row of stale.rows) await client.query(`drop database if exists "${row.datname}" with (force)`);
    await client.end();
    await pg.stop();
  };
}
