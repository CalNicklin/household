import { loadEnv } from "../server/env.ts";
import { FAMILY_LISTS_ENV, readFamilyLists, redacted } from "./family-lists/read.ts";

/**
 * CAP-6: copy Family Lists' lists and items into the lists domain, once (order, ticks and emoji kept).
 *
 * Run it where the app runs, so it reads the house's own settings (docs/OPERATIONS.md):
 *
 *   FAMILY_LISTS_DATABASE_URL='postgresql://…' docker compose run --rm -e FAMILY_LISTS_DATABASE_URL app node scripts/import-family-lists.ts --dry-run
 *   FAMILY_LISTS_DATABASE_URL='postgresql://…' docker compose run --rm -e FAMILY_LISTS_DATABASE_URL app node scripts/import-family-lists.ts
 *
 * It reads Family Lists in a read-only transaction and never writes to it. It writes to the lists
 * domain of the house its environment names (DATABASE_URL, DB_PREFIX, PRACTICE, as `pnpm start` reads
 * them), says which, and refuses if any list is already there. Without `--practice` it refuses to write
 * into the practice household, so a run that missed the house's settings cannot land there by default.
 * The connection string is read from the environment only; it is never printed.
 *
 * The runtime is loaded only once there is something to write, and the real integrations only for the
 * real house: loading them takes over a second, so the read, the dry run and the refusals stay quick.
 */
const source = process.env[FAMILY_LISTS_ENV];
if (source === undefined || source === "") {
  console.error(`set ${FAMILY_LISTS_ENV} to the Family Lists Postgres connection string (see docs/OPERATIONS.md)`);
  process.exit(2);
}
const dryRun = process.argv.includes("--dry-run");
const intoPractice = process.argv.includes("--practice");

try {
  const snapshot = await readFamilyLists(source);
  const counts = { lists: snapshot.lists.length, items: snapshot.lists.reduce((n, l) => n + l.items.length, 0) };
  if (dryRun) {
    console.log(JSON.stringify({ event: "family-lists-read", ...counts }));
    process.exit(0);
  }
  const env = loadEnv();
  if (env.PRACTICE && !intoPractice) {
    console.error(JSON.stringify({ event: "family-lists-import-refused", reason: "these settings are the practice household (PRACTICE is not false); run it where the app runs (docs/OPERATIONS.md), or pass --practice to copy into the practice household on purpose" }));
    process.exit(2);
  }
  const [{ migrateAll }, { createRuntime }] = await Promise.all([import("../practice/seed.ts"), import("../server/runtime.ts")]);
  await migrateAll(env);
  const ports = env.PRACTICE
    ? (await import("../practice/fakes.ts")).practicePorts()
    : (await import("../server/integrations/index.ts")).realPorts(env, { now: () => new Date() }, { timeZone: "Europe/London", personForEmail: () => null }).ports;
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
