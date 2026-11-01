import { zHouseSetup } from "@household/contracts";
import { migrateAll } from "../practice/seed.ts";
import { loadEnv } from "../server/env.ts";
import { isHouseSetUp, setUpHouse } from "../server/setup/house.ts";

/**
 * PLT-8: set up the real house once, on the server. Reads the house (no secrets) on stdin and prints
 * each adult's generated app password once, to the terminal that ran it (`sudo household-setup < house.json`
 * on the server runs this in the app's image). `--check` only answers, reading and migrating nothing:
 * exit 0 if set up, 3 if not.
 */
const env = loadEnv();
if (env.PRACTICE) {
  console.error("house:setup is for the real house (PRACTICE=false); the practice household seeds itself");
  process.exit(2);
}
// `--check` only reads: household-deploy asks it with a new image before that image is known to be healthy.
if (process.argv.includes("--check")) process.exit((await isHouseSetUp(env)) ? 0 : 3);
await migrateAll(env);
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const logins = await setUpHouse(env, zHouseSetup.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
if (logins === null) {
  console.error("the house is already set up; nothing changed");
} else {
  console.error("Set up. Each adult's app login (shown once: keep it in the password manager):");
  for (const l of logins) process.stdout.write(`  ${l.username}  ${l.password}\n`);
}
