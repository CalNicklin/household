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
    const uncounted: number[] = [];
    try {
      // With pg-pool's end() alone, connections were still open in 9 of 40 rounds, and dropping the
      // database WITH (FORCE) then killed them mid-close: an unhandled 57P01 that failed CI.
      for (let round = 0; round < 20; round++) {
        const prefix = `pool${randomBytes(4).toString("hex")}`;
        const name = databaseName(prefix, Domain.household);
        await ensureDatabase(url, name);
        const db = connectDomain(url, prefix, Domain.household, {});
        const ran = await Promise.all([1, 2, 3, 4].map(() => db.$client.query<{ pid: number }>("select pg_backend_pid() as pid, pg_sleep(0.01)")));
        const pids = ran.map((r) => r.rows[0]?.pid ?? -1);
        // Every connection the pool holds ran one of the queries, so the pids cover all of them.
        if (new Set(pids).size !== db.$client.totalCount) uncounted.push(round);
        await closePool(db.$client);
        // The pool's own backends, by pid: an autovacuum worker analysing the shared pg_database
        // catalog can briefly connect to a fresh database too, and it is not one of the pool's (nor
        // is one that reuses a closed backend's pid, hence backend_type).
        const open = await admin.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = $1 and pid = any($2::int[]) and backend_type = 'client backend'", [name, pids]);
        stillOpen.push(open.rows[0]?.n ?? -1);
        await dropDatabases(url, prefix);
      }
    } finally {
      await admin.end();
    }
    expect(uncounted).toEqual([]);
    expect(stillOpen.filter((n) => n !== 0)).toEqual([]);
  });
});
