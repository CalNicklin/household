import { loadEnv } from "../server/env.ts";
import { realPorts } from "../server/integrations/index.ts";
import { createRuntime } from "../server/runtime.ts";
import { googleCheck } from "./google/check.ts";

/** HOU-147: what `sudo household-google check` runs, in the app's image with the house's settings. */
const env = loadEnv();
if (env.PRACTICE) {
  console.error("google:check is for the real house (PRACTICE=false); the practice household has no Google");
  process.exit(2);
}
const clock = { now: () => new Date() };
const rt = await createRuntime(env, realPorts(env, clock, { timeZone: "Europe/London", personForEmail: () => null }).ports);
try {
  const api = rt.system("household-google check");
  process.exitCode = await googleCheck({
    env,
    clock,
    watches: () => api.calendar.watches(),
    people: async () => (await api.household.adults()).map((p) => ({ id: p.id, name: p.name })),
    out: (line) => console.log(line),
  });
} finally {
  await rt.close();
}
