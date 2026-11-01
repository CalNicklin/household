import { Domain } from "@household/contracts";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { describe, expect, inject, test } from "vitest";
import { closePool, connectDomain, databaseName, dropDatabases, ensureDatabase } from "./index.ts";

describe("closing a domain's pool", () => {
  test("[FB-6] once a pool is closed none of its connections is left, so a practice reset can drop the databases straight away", async () => {
    const url = inject("databaseUrl");
    const admin = new Client({ connectionString: url });
    await admin.connect();
    const stillOpen: number[] = [];
    try {
      // With pg-pool's end() alone, connections were still open in 9 of 40 rounds, and dropping the
      // database WITH (FORCE) then killed them mid-close: an unhandled 57P01 that failed CI.
      for (let round = 0; round < 20; round++) {
        const prefix = `pool${randomBytes(4).toString("hex")}`;
        const name = databaseName(prefix, Domain.household);
        await ensureDatabase(url, name);
        const db = connectDomain(url, prefix, Domain.household, {});
        await Promise.all([1, 2, 3, 4].map(() => db.$client.query("select pg_sleep(0.01)")));
        await closePool(db.$client);
        const open = await admin.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = $1", [name]);
        stillOpen.push(open.rows[0]?.n ?? -1);
        await dropDatabases(url, prefix);
      }
    } finally {
      await admin.end();
    }
    expect(stillOpen.filter((n) => n !== 0)).toEqual([]);
  });
});
