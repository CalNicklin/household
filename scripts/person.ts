import { practicePorts } from "../practice/fakes.ts";
import { loadEnv } from "../server/env.ts";
import { realPorts } from "../server/integrations/index.ts";
import { deletePerson, exportPerson } from "../server/privacy/person.ts";
import { createRuntime } from "../server/runtime.ts";

/**
 * PRV-7, one command each:
 *   pnpm person export <person> > me.json
 *   pnpm person delete <person>
 */
const [command, person] = process.argv.slice(2);
if ((command !== "export" && command !== "delete") || person === undefined) {
  console.error("usage: pnpm person export|delete <person>");
  process.exit(2);
}
const env = loadEnv();
const ports = env.PRACTICE ? practicePorts() : realPorts(env, { now: () => new Date() }, { timeZone: "Europe/London", personForEmail: () => null }).ports;
const rt = await createRuntime(env, ports);
if (command === "export") process.stdout.write(`${JSON.stringify(await exportPerson(rt, person), null, 2)}\n`);
else {
  await deletePerson(rt, person);
  console.error(JSON.stringify({ event: "deleted", person }));
}
await rt.close();
