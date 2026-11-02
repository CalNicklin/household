import { loadEnvOrExit, modelStatus } from "../server/env.ts";

/**
 * HOU-160: what `sudo household-status` runs inside the running app container, so it reads the settings
 * that container started with: which model the house is using, and whether its key is set (never the key).
 */
const env = loadEnvOrExit();
console.log(`house: ${env.PRACTICE ? "practice household" : "the real house"} (${env.HOUSEHOLD_ID})`);
console.log(`model: ${modelStatus(env)}`);
