import { serve } from "@hono/node-server";
import { Channel, PersonRole, TimerKind } from "@household/contracts";
import { practicePorts } from "../practice/fakes.ts";
import { migrateAll, seedPractice } from "../practice/seed.ts";
import { loadAdapters } from "./adapters/registry.ts";
import { acceptTimer } from "./coordinator/accept.ts";
import { houseCalendars, loadEnvOrExit, modelStatus, unknownCalendarOwners } from "./env.ts";
import { createApp } from "./http/app.ts";
import { practiceRoutes } from "./http/practice.ts";
import { realPorts } from "./integrations/index.ts";
import { S3ObjectStore } from "./integrations/s3-object-store.ts";
import { HttpShoppingHelper } from "./integrations/shopping-helper.ts";
import { launchJobs } from "./jobs/launch.ts";
import type { Ports } from "./ports.ts";
import { createRuntime } from "./runtime.ts";
import { localDate } from "./time.ts";

/** PLT-8: the whole system is this one process plus Postgres, object storage, Hindsight and the helper. */
async function main(): Promise<void> {
  const env = loadEnvOrExit();
  await migrateAll(env);
  const emails = new Map<string, string>();
  const shopping = env.HELPER_URL === undefined ? undefined : new HttpShoppingHelper(env.HELPER_URL, env.HELPER_TOKEN);
  let ports: Ports;
  if (env.PRACTICE) {
    ports = practicePorts({ frozen: false, ...(shopping === undefined ? {} : { shopping }) });
    // PLT-7: a preview with object storage configured keeps screenshots there, encrypted, like the real house.
    if (env.S3_ENDPOINT !== undefined && env.S3_ACCESS_KEY_ID !== undefined && env.S3_SECRET_ACCESS_KEY !== undefined) {
      const objects = new S3ObjectStore({ endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, encryptionKey: env.STORAGE_KEY });
      await objects.ensureBucket();
      ports = { ...ports, objects };
    }
  } else {
    const real = realPorts(env, { now: () => new Date() }, { timeZone: "Europe/London", personForEmail: (e) => emails.get(e.toLowerCase()) ?? null, ...(shopping === undefined ? {} : { shopping }) });
    ports = real.ports;
    if (ports.objects instanceof S3ObjectStore) await ports.objects.ensureBucket();
    if (real.missing.length > 0) console.warn(JSON.stringify({ event: "ports-missing-credentials", missing: real.missing }));
  }
  const probe = await createRuntime(env, ports);
  const seeded = (await probe.dbs.household.query.settings.findFirst()) !== undefined;
  await probe.close();
  if (!seeded) {
    if (!env.PRACTICE) throw new Error("household not set up: run `pnpm house:setup < house.json` first (docs/OPERATIONS.md)");
    await seedPractice(env, ports.clock.now());
  }
  const rt = await createRuntime(env, ports);
  for (const a of await rt.system("boot").household.adults())
    if (a.role === PersonRole.adult) for (const addr of await rt.system("boot").household.addressesFor({ person: a.id })) if (addr.channel === Channel.email) emails.set(addr.address.toLowerCase(), a.id);
  // HOME-1: an owner that isn't anyone in the house (a typo) would attribute their events to nobody.
  const strangers = unknownCalendarOwners(houseCalendars(env), (await rt.system("boot").household.adults()).map((p) => p.id));
  if (strangers.length > 0) console.warn(JSON.stringify({ event: "calendar-owner-unknown", owners: strangers, fix: "use a person's ID or `shared` in GOOGLE_CALENDARS" }));
  const adapters = await loadAdapters();
  await launchJobs(rt);
  for (const a of adapters) await a.start?.(rt);
  const app = createApp(rt, adapters, env.PRACTICE ? practiceRoutes(rt) : undefined);
  serve({ fetch: app.fetch, port: env.PORT });
  console.log(JSON.stringify({ event: "listening", port: env.PORT, practice: env.PRACTICE, model: modelStatus(env), adapters: adapters.map((a) => a.name) }));
  // HOME-11: after a restart, today's plan exists before anyone looks.
  const today = localDate(ports.clock.now(), rt.timeZone);
  if ((await rt.system("boot").plans.latest({ date: today })) === null) await acceptTimer(rt, TimerKind.morningPlan, ports.clock.now());
}

await main();
