import { type Domain, Limits } from "@household/contracts";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { Client, Pool } from "pg";

export type DomainDb<S extends Record<string, unknown>> = NodePgDatabase<S> & { $client: Pool };

export function databaseName(prefix: string, domain: Domain): string {
  return `${prefix}_${domain}`;
}

export function databaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** One Postgres database per domain (CODE-4): a domain's db handle can only see its own tables. */
export function connectDomain<S extends Record<string, unknown>>(baseUrl: string, prefix: string, domain: Domain, schema: S): DomainDb<S> {
  const pool = new Pool({
    connectionString: databaseUrl(baseUrl, databaseName(prefix, domain)),
    // limit: domainPoolMax
    max: Limits.domainPoolMax.value,
    // limit: poolIdleMs
    idleTimeoutMillis: Limits.poolIdleMs.value,
  });
  return drizzle(pool, { schema });
}

/**
 * Close a pool and wait until every connection has actually gone. pg-pool's end() resolves as soon
 * as it has asked each connection to close; a database dropped WITH (FORCE) in that moment kills one
 * mid-close, and its client throws an unhandled "terminating connection" (57P01).
 */
export async function closePool(pool: Pool): Promise<void> {
  const gone = new Promise<void>((resolve) => {
    let open = pool.totalCount;
    if (open === 0) resolve();
    pool.on("remove", () => {
      open -= 1;
      if (open === 0) resolve();
    });
  });
  await pool.end();
  await gone;
}

export async function ensureDatabase(baseUrl: string, name: string, template?: string): Promise<void> {
  const client = new Client({ connectionString: baseUrl });
  await client.connect();
  try {
    const exists = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (exists.rowCount === 0) {
      const tpl = template === undefined ? "" : ` template "${template}"`;
      await client.query(`create database "${name}"${tpl}`);
    }
  } finally {
    await client.end();
  }
}

export async function dropDatabases(baseUrl: string, prefix: string): Promise<void> {
  const client = new Client({ connectionString: baseUrl });
  await client.connect();
  try {
    const rows = await client.query<{ datname: string }>("select datname from pg_database where datname like $1", [`${prefix}\\_%`]);
    for (const row of rows.rows) await client.query(`drop database if exists "${row.datname}" with (force)`);
  } finally {
    await client.end();
  }
}

export function migrationsFolder(domain: Domain): string {
  return path.resolve(import.meta.dirname, "..", "domains", domain, "migrations");
}

export async function migrateDomain(db: DomainDb<Record<string, unknown>>, domain: Domain): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder(domain) });
}
