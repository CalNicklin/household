import { randomBytes } from "node:crypto";
import { Channel, DeliveryChannel, type HouseSetup, Limits, PersonRole, Urgency } from "@household/contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { closePool } from "../db/index.ts";
import { hashPassword } from "../domains/household/router.ts";
import type { Env } from "../env.ts";
import { connectAll, schemas } from "../runtime.ts";

const H = schemas.household;

/** CH-7 and PRO-7: the settings every adult starts with; each of us can change them. */
export function personDefaults() {
  return {
    // limit: defaultDailyMessageBudget
    dailyMessageBudget: Limits.defaultDailyMessageBudget.value,
    // limit: defaultQuietStartHour
    quietStartHour: Limits.defaultQuietStartHour.value,
    // limit: defaultQuietEndHour
    quietEndHour: Limits.defaultQuietEndHour.value,
    // CH-7: urgent goes to the messenger, everything else to the morning screen.
    routing: { [Urgency.urgent]: DeliveryChannel.telegram, [Urgency.normal]: DeliveryChannel.screen, [Urgency.low]: DeliveryChannel.screen },
  };
}

/** Postgres codes for "no such database" and "no such table": a house never migrated is not set up. */
const NOT_THERE = new Set(["3D000", "42P01"]);
const zPgError = z.object({ code: z.string().optional(), cause: z.object({ code: z.string().optional() }).optional() });

/**
 * Whether the house has been set up (the app refuses to start the real house until it has). Read-only:
 * it creates and migrates nothing, so asking with a new image leaves the databases as they were.
 */
export async function isHouseSetUp(env: Env): Promise<boolean> {
  const dbs = connectAll(env);
  try {
    // Only "is there a row": no column list, so a newer image's schema can ask an older database.
    return (await dbs.household.execute(sql`select 1 from settings limit 1`)).rows.length > 0;
  } catch (e) {
    const pg = zPgError.safeParse(e);
    const code = pg.success ? (pg.data.cause?.code ?? pg.data.code) : undefined;
    if (code !== undefined && NOT_THERE.has(code)) return false;
    throw e;
  } finally {
    await Promise.all(Object.values(dbs).map((db) => closePool(db.$client)));
  }
}

/**
 * PLT-8: set up the real house once, on the server, from a description with no secrets in it. Each
 * adult gets an app login whose password is generated here and returned once; nothing else (rules,
 * backlog, sitters) is written, because those are a person's to write (PRV-1). Returns null when the
 * house is already set up, so running it twice changes nothing.
 */
export async function setUpHouse(env: Env, house: HouseSetup): Promise<{ username: string; password: string }[] | null> {
  if (await isHouseSetUp(env)) return null;
  const dbs = connectAll(env);
  try {
    return await dbs.household.transaction(async (tx) => {
      await tx.insert(H.settings).values({ household: env.HOUSEHOLD_ID, name: house.name, timezone: house.timezone, latitude: house.latitude, longitude: house.longitude, retainMessages: true, healthOwner: house.healthOwner ?? null });
      await tx.insert(H.people).values([
        ...house.adults.map((a) => ({ id: a.id, name: a.name, role: PersonRole.adult, nurseryDays: [] })),
        ...house.children.map((c) => ({ id: c.id, name: c.name, role: PersonRole.child, nurseryDays: c.nurseryDays })),
      ]);
      const logins: { username: string; password: string }[] = [];
      for (const a of house.adults) {
        const password = randomBytes(12).toString("base64url");
        await tx.insert(H.logins).values({ personId: a.id, username: a.id, passwordHash: hashPassword(password) });
        await tx.insert(H.identities).values([
          { personId: a.id, channel: Channel.app, address: a.id },
          ...(a.email === undefined ? [] : [{ personId: a.id, channel: Channel.email, address: a.email.toLowerCase() }]),
          ...(a.telegram === undefined ? [] : [{ personId: a.id, channel: Channel.telegram, address: a.telegram }]),
        ]);
        await tx.insert(H.personSettings).values({ personId: a.id, ...personDefaults() });
        logins.push({ username: a.id, password });
      }
      return logins;
    });
  } finally {
    await Promise.all(Object.values(dbs).map((db) => closePool(db.$client)));
  }
}
