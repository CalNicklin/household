import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { Domain } from "@household/contracts";
import { migrationsFolder } from "../db/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
/** HOU-168: no password in a URL here; a local server that wants one gets it from PGPASSWORD, as pg reads it. */
const DEFAULT_URL = "postgres://postgres@localhost:5432/postgres";
const EMBEDDED_PORT = 54329;
/**
 * The embedded server's data, and its password beside it (git-ignored, like all of .data): made at
 * random when the server is first initialised, so none is in the repo. The directory is new with
 * HOU-168; an older `.data/pg-embedded` (password in the repo) is no longer used and can be deleted.
 */
const EMBEDDED_DIR = path.join(ROOT, ".data", "postgres-embedded");
const EMBEDDED_PASSWORD_FILE = `${EMBEDDED_DIR}.password`;

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

function embeddedUrl(password: string): string {
  return `postgres://postgres:${encodeURIComponent(password)}@localhost:${EMBEDDED_PORT}/postgres`;
}

function embeddedPassword(): string | undefined {
  return existsSync(EMBEDDED_PASSWORD_FILE) ? readFileSync(EMBEDDED_PASSWORD_FILE, "utf8") : undefined;
}

/** For a test that runs a script with a bare environment: the local server's PGPASSWORD, if it needs one. */
export function postgresPasswordEnv(): { PGPASSWORD?: string } {
  const password = process.env["PGPASSWORD"];
  return password === undefined ? {} : { PGPASSWORD: password };
}

/** Where the tests look for Postgres, in order; the last is the embedded server ensurePostgres starts, once it has been made. */
export function postgresCandidates(): string[] {
  const password = embeddedPassword();
  return [process.env["TEST_DATABASE_URL"], process.env["DATABASE_URL"], DEFAULT_URL, password === undefined ? undefined : embeddedUrl(password)].filter((u): u is string => u !== undefined);
}

/**
 * A Postgres server for tests and local dev: `DATABASE_URL` if it answers, else the local default,
 * else an embedded Postgres started from node_modules, so a clean checkout needs nothing installed.
 */
export async function ensurePostgres(): Promise<{ url: string; stop: () => Promise<void> }> {
  for (const url of postgresCandidates()) if (await reachable(url)) return { url, stop: async () => {} };
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const fresh = !existsSync(path.join(EMBEDDED_DIR, "PG_VERSION"));
  if (fresh) {
    mkdirSync(path.dirname(EMBEDDED_DIR), { recursive: true });
    // Exclusive create: when two runs start the server for the first time at once, both use the one
    // password that was written first, never one each.
    try {
      writeFileSync(EMBEDDED_PASSWORD_FILE, randomBytes(18).toString("base64url"), { mode: 0o600, flag: "wx" });
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
    }
  }
  const password = embeddedPassword();
  if (password === undefined) throw new Error(`${EMBEDDED_PASSWORD_FILE} is missing: delete ${EMBEDDED_DIR} (test data only) and it will be made again`);
  const pg = new EmbeddedPostgres({ databaseDir: EMBEDDED_DIR, port: EMBEDDED_PORT, user: "postgres", password, persistent: true, onLog: () => {} });
  if (fresh) await pg.initialise();
  await pg.start();
  return { url: embeddedUrl(password), stop: () => pg.stop() };
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
