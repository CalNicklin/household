import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { describe, expect, inject, it } from "vitest";
import { practicePorts } from "../../practice/fakes.ts";
import { migrateAll } from "../../practice/seed.ts";
import { dropDatabases } from "../db/index.ts";
import { loadEnv } from "../env.ts";
import { createRuntime } from "../runtime.ts";
import { isHouseSetUp, setUpHouse } from "./house.ts";

const house = {
  name: "Home",
  timezone: "Europe/London",
  latitude: 51.45,
  longitude: -2.59,
  adults: [
    { id: "sam", name: "Sam", email: "Sam@Example.com", telegram: "42" },
    { id: "alex", name: "Alex" },
  ],
  children: [{ id: "kit", name: "Kit", nurseryDays: ["mon" as const] }],
};

describe("setting up the real house", () => {
  it("[PLT-8] writes the house and its adults once, with generated logins that work, and changes nothing the second time", async () => {
    const url = inject("databaseUrl");
    const prefix = `s${inject("runId")}${randomBytes(3).toString("hex")}`;
    const env = loadEnv({ DATABASE_URL: url, DB_PREFIX: prefix, HOUSEHOLD_ID: "home" });
    try {
      // household-deploy asks with a new image before it is healthy: asking creates nothing.
      expect(await isHouseSetUp(env)).toBe(false);
      const client = new Client({ connectionString: url });
      await client.connect();
      const made = await client.query("select datname from pg_database where datname like $1", [`${prefix}\\_%`]);
      await client.end();
      expect(made.rows).toEqual([]);
      await migrateAll(env);
      expect(await isHouseSetUp(env)).toBe(false);
      const logins = await setUpHouse(env, house);
      expect(logins?.map((l) => l.username)).toEqual(["sam", "alex"]);
      expect(new Set(logins?.map((l) => l.password)).size).toBe(2);
      expect(await setUpHouse(env, { ...house, name: "Other" })).toBeNull();

      const rt = await createRuntime(env, practicePorts());
      try {
        const api = rt.system("test");
        expect((await api.household.settings()).name).toBe("Home");
        expect((await api.household.adults()).map((p) => p.id).sort()).toEqual(["alex", "sam"]);
        expect(await api.household.resolveIdentity({ channel: "email", address: "sam@example.com" })).toBe("sam");
        expect(await api.household.resolveIdentity({ channel: "telegram", address: "42" })).toBe("sam");
        const sam = logins?.[0];
        expect(sam === undefined ? null : await api.household.login({ username: sam.username, password: sam.password })).toBe("sam");
        expect(await api.household.login({ username: "sam", password: "wrong" })).toBeNull();
        expect(await api.household.rules()).toEqual([]);
      } finally {
        await rt.close();
      }
    } finally {
      await dropDatabases(url, prefix);
    }
  });
});
