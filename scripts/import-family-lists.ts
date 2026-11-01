import { practicePorts } from "../practice/fakes.ts";
import { migrateAll } from "../practice/seed.ts";
import { loadEnv } from "../server/env.ts";
import { realPorts } from "../server/integrations/index.ts";
import { createRuntime } from "../server/runtime.ts";
import { FAMILY_LISTS_ENV, readFamilyLists, redacted } from "./family-lists/read.ts";

/**
 * CAP-6: copy Family Lists' lists and items into the lists domain, once (order, ticks and emoji kept).
 *
 *   FAMILY_LISTS_DATABASE_URL='postgresql://…' pnpm lists:import            # copy into this house
 *   FAMILY_LISTS_DATABASE_URL='postgresql://…' pnpm lists:import --dry-run  # only count what is there
 *
 * It reads Family Lists in a read-only transaction and never writes to it. It writes to this house's
 * lists domain (DATABASE_URL, DB_PREFIX and the rest of .env, as `pnpm start` does) and refuses if any
 * list is already there. The connection string is read from the environment only; it is never printed.
 */
const source = process.env[FAMILY_LISTS_ENV];
if (source === undefined || source === "") {
  console.error(`set ${FAMILY_LISTS_ENV} to the Family Lists Postgres connection string (see docs/OPERATIONS.md)`);
  process.exit(2);
}
const dryRun = process.argv.includes("--dry-run");

try {
  const snapshot = await readFamilyLists(source);
  const counts = { lists: snapshot.lists.length, items: snapshot.lists.reduce((n, l) => n + l.items.length, 0) };
  if (dryRun) {
    console.log(JSON.stringify({ event: "family-lists-read", ...counts }));
    process.exit(0);
  }
  const env = loadEnv();
  await migrateAll(env);
  const ports = env.PRACTICE ? practicePorts() : realPorts(env, { now: () => new Date() }, { timeZone: "Europe/London", personForEmail: () => null }).ports;
  const rt = await createRuntime(env, ports);
  try {
    const imported = await rt.system("family-lists import").lists.importLists(snapshot);
    console.log(JSON.stringify({ event: "family-lists-imported", prefix: env.DB_PREFIX, ...imported }));
  } finally {
    await rt.close();
  }
} catch (e) {
  console.error(JSON.stringify({ event: "family-lists-import-failed", error: redacted(e instanceof Error ? e.message : String(e), source) }));
  process.exit(1);
}
