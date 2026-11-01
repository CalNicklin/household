import { loadEnv } from "../server/env.ts";
import { ensurePostgres } from "../server/testing/postgres.ts";
import { resetPractice } from "../practice/seed.ts";

/** FB-6: one command, a fresh practice household (people, a week of calendar, 20 backlog items, 3 parcels, a basket). */
const started = Date.now();
const pg = await ensurePostgres();
const env = loadEnv({ ...process.env, DATABASE_URL: process.env["DATABASE_URL"] ?? pg.url });
if (!env.PRACTICE) throw new Error("seed only ever touches the practice household (PRACTICE=true)");
await resetPractice(env);
console.log(JSON.stringify({ event: "seeded", prefix: env.DB_PREFIX, ms: Date.now() - started }));
