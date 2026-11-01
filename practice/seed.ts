import { Channel, DeliveryChannel, Domain, Limits, Urgency } from "@household/contracts";
import { closePool, databaseName, dropDatabases, ensureDatabase, migrateDomain } from "../server/db/index.ts";
import { hashPassword } from "../server/domains/household/router.ts";
import type { Env } from "../server/env.ts";
import { connectAll, schemas } from "../server/runtime.ts";
import * as data from "./data.ts";

const H = schemas.household;
const B = schemas.backlog;
const P = schemas.parcels;
const C = schemas.calendar;

/** Create (or reuse) every domain database for a prefix and run its migrations. */
export async function migrateAll(env: Env, template?: (d: Domain) => string): Promise<void> {
  for (const domain of Object.values(Domain)) await ensureDatabase(env.DATABASE_URL, databaseName(env.DB_PREFIX, domain), template?.(domain));
  const dbs = connectAll(env);
  try {
    if (template === undefined) for (const domain of Object.values(Domain)) await migrateDomain(dbs[domain], domain);
  } finally {
    await Promise.all(Object.values(dbs).map((db) => closePool(db.$client)));
  }
}

/** FB-6: people, a week of calendar (via the practice Google), twenty backlog items, three parcels. */
export async function seedPractice(env: Env, now: Date = new Date(data.PRACTICE_START)): Promise<void> {
  const dbs = connectAll(env);
  try {
    const h = dbs.household;
    await h.insert(H.settings).values({ household: data.PRACTICE_HOUSEHOLD, name: "Practice household", timezone: data.PRACTICE_TZ, retainMessages: true, latitude: 51.4545, longitude: -2.5879, healthOwner: "priya" });
    await h.insert(H.people).values(data.people.map((p) => ({ ...p, nurseryDays: [...p.nurseryDays] })));
    await h.insert(H.identities).values([...data.identities]);
    const passwordHash = hashPassword(data.PRACTICE_PASSWORD);
    await h.insert(H.logins).values([
      { personId: "priya", username: "priya", passwordHash },
      { personId: "tom", username: "tom", passwordHash },
    ]);
    // CH-7: urgent goes to the messenger, everything else to the morning screen; each of us can change it.
    const routing = { [Urgency.urgent]: DeliveryChannel.telegram, [Urgency.normal]: DeliveryChannel.screen, [Urgency.low]: DeliveryChannel.screen };
    const personDefaults = {
      // limit: defaultDailyMessageBudget
      dailyMessageBudget: Limits.defaultDailyMessageBudget.value,
      // limit: defaultQuietStartHour
      quietStartHour: Limits.defaultQuietStartHour.value,
      // limit: defaultQuietEndHour
      quietEndHour: Limits.defaultQuietEndHour.value,
      routing,
    };
    await h.insert(H.personSettings).values([
      { personId: "priya", ...personDefaults },
      { personId: "tom", ...personDefaults },
    ]);
    for (const s of data.sitters) {
      const [row] = await h.insert(H.sitters).values({ name: s.name, knownFreeDays: [...s.knownFreeDays] }).returning();
      if (row !== undefined) await h.insert(H.sitterIdentities).values({ sitterId: row.id, channel: Channel.telegram, address: s.telegram });
    }
    await h.insert(H.rules).values(data.rules.map((r) => ({ kind: r.spec.kind, spec: r.spec.kind === "bins" ? { ...r.spec, evenWeeks: [...r.spec.evenWeeks], oddWeeks: [...r.spec.oddWeeks] } : { ...r.spec }, createdBy: r.createdBy, createdAt: now })));
    await h.insert(H.nurseryTerms).values([...data.nurseryTerms]);
    await h.insert(H.nurseryEvents).values([...data.nurseryEvents]);
    await h.insert(H.wellbeingIdeas).values([...data.wellbeingIdeas]);

    await dbs.backlog.insert(B.items).values(
      data.backlog.map((b, i) => ({
        text: b.text,
        tags: b.tags,
        confirmedTags: b.daysAgo > 2,
        createdBy: b.createdBy,
        createdVia: Channel.app,
        sourceMessage: `seed-${i}`,
        createdAt: new Date(now.getTime() - b.daysAgo * 86_400_000),
      })),
    );
    // The first calendar sync, as if Google had been read once (later changes arrive by webhook, CH-6).
    const [sync] = await dbs.calendar.insert(C.syncs).values({ syncToken: String(data.calendar.length), at: now }).returning();
    await dbs.calendar.insert(C.events).values(
      data.calendar.map((e) => ({
        externalId: e.externalId,
        title: e.title,
        start: new Date(e.start),
        end: new Date(e.end),
        allDay: e.allDay ?? false,
        attendees: e.attendees,
        away: e.away ?? [],
        work: e.work ?? false,
        soloWithKids: e.soloWithKids ?? null,
        syncId: sync?.id ?? null,
      })),
    );
    await dbs.parcels.insert(P.arrivals).values(data.parcels.map((p, i) => ({ ...p, sourceKey: `seed-parcel-${i}`, createdAt: now })));
  } finally {
    await Promise.all(Object.values(dbs).map((db) => closePool(db.$client)));
  }
}

export async function resetPractice(env: Env, now?: Date): Promise<void> {
  await dropDatabases(env.DATABASE_URL, env.DB_PREFIX);
  await migrateAll(env);
  await seedPractice(env, now);
}

/** Empty every practice table in place (the databases and their connections stay) and seed again. */
export async function truncateAndSeed(env: Env, now: Date): Promise<void> {
  const dbs = connectAll(env);
  try {
    for (const domain of Object.values(Domain)) {
      const tables = await dbs[domain].$client.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'");
      if (tables.rows.length > 0) await dbs[domain].$client.query(`truncate ${tables.rows.map((t) => `"${t.tablename}"`).join(", ")} cascade`);
    }
  } finally {
    await Promise.all(Object.values(dbs).map((db) => closePool(db.$client)));
  }
  await seedPractice(env, now);
}
