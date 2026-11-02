import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ListItemSource } from "@household/contracts";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { z } from "zod";
import { practicePorts } from "../../practice/fakes.ts";
import { databaseUrl, dropDatabases, ensureDatabase } from "../../server/db/index.ts";
import { loadEnv } from "../../server/env.ts";
import { postgresPasswordEnv } from "../../server/testing/postgres.ts";
import { createRuntime } from "../../server/runtime.ts";
import { FAMILY_LISTS_ENV, readFamilyLists } from "./read.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const run = promisify(execFile);
const url = inject("databaseUrl");
const tag = randomBytes(3).toString("hex");
/** The stand-in for Family Lists' Supabase database, reachable only through a role that can SELECT. */
const sourceDb = `fl${tag}_source`;
const reader = `fl${tag}_reader`;
const readerPassword = randomBytes(12).toString("hex");
const targetPrefix = `im${tag}`;
const sourceUrl = (() => {
  const u = new URL(databaseUrl(url, sourceDb));
  u.username = reader;
  u.password = readerPassword;
  return u.toString();
})();

async function asAdmin<T>(database: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl(url, database) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
const fingerprint = () => asAdmin(sourceDb, async (c) => (await c.query("select (select md5(string_agg(l::text, ',' order by l.id)) from lists l) || (select md5(string_agg(i::text, ',' order by i.id)) from items i) as f")).rows[0]);

/** The import script, as Cal would run it, with only these environment variables. */
async function importScript(env: Record<string, string>, args: string[] = []): Promise<{ code: number; out: string }> {
  try {
    const r = await run("node", ["scripts/import-family-lists.ts", ...args], { cwd: ROOT, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", DATABASE_URL: url, DB_PREFIX: targetPrefix, PRACTICE: "true", ...postgresPasswordEnv(), ...env } });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const err = z.object({ code: z.number(), stdout: z.string(), stderr: z.string() }).parse(e);
    return { code: err.code, out: err.stdout + err.stderr };
  }
}

beforeAll(async () => {
  await ensureDatabase(url, sourceDb);
  await asAdmin(sourceDb, async (c) => {
    await c.query(readFileSync(path.join(import.meta.dirname, "fixture.sql"), "utf8"));
    await c.query(`create role "${reader}" login password '${readerPassword}'`);
    await c.query(`grant connect on database "${sourceDb}" to "${reader}"`);
    await c.query(`grant usage on schema public to "${reader}"`);
    await c.query(`grant select on lists, items to "${reader}"`);
  });
});
afterAll(async () => {
  await dropDatabases(url, `fl${tag}`);
  await dropDatabases(url, targetPrefix);
  await asAdmin("postgres", (c) => c.query(`drop role if exists "${reader}"`));
});

describe("Family Lists import (CAP-6)", () => {
  test("[CAP-6] reads Family Lists in the order it shows them, with ticks and emoji, needing nothing but SELECT", async () => {
    const snapshot = await readFamilyLists(sourceUrl);
    expect(snapshot.lists.map((l) => [l.position, l.emoji, l.name])).toEqual([
      [0, "🛒", "To Buy"],
      [1, "🏖️", "Holiday"],
      [2, "✅", "To Do"],
      [3, "📝", "Empty one"],
    ]);
    expect(snapshot.lists[0]?.items.map((i) => [i.position, i.text, i.checked])).toEqual([
      [0, "Oat milk", false],
      [1, "Bread", true],
      [2, "Eggs", false],
      [3, "Crème fraîche", false],
    ]);
    expect(snapshot.lists[3]?.items).toEqual([]);
  });

  test("[CAP-6][PRV-1] the script copies it into the lists domain once, never writes to Family Lists, and never prints the connection string", async () => {
    const before = await fingerprint();
    const dry = await importScript({ [FAMILY_LISTS_ENV]: sourceUrl }, ["--dry-run"]);
    expect(dry).toMatchObject({ code: 0 });
    expect(dry.out).toContain('"lists":4,"items":7');

    // Without the house's own settings it would land in the practice household, so it refuses.
    const unaimed = await importScript({ [FAMILY_LISTS_ENV]: sourceUrl });
    expect(unaimed.code).toBe(2);
    expect(unaimed.out).toContain("family-lists-import-refused");

    const first = await importScript({ [FAMILY_LISTS_ENV]: sourceUrl }, ["--practice"]);
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain('"event":"family-lists-imported"');
    const again = await importScript({ [FAMILY_LISTS_ENV]: sourceUrl }, ["--practice"]);
    expect(again.code).toBe(1);
    expect(again.out).toContain("only runs once");
    for (const r of [dry, unaimed, first, again]) {
      expect(r.out).not.toContain(readerPassword);
      expect(r.out).not.toContain(sourceUrl);
    }
    expect(await fingerprint()).toEqual(before);

    const rt = await createRuntime(loadEnv({ DATABASE_URL: url, DB_PREFIX: targetPrefix }), practicePorts());
    try {
      const lists = await rt.system("test").lists.list();
      expect(lists.map((l) => `${l.emoji} ${l.name}`)).toEqual(["🛒 To Buy", "🏖️ Holiday", "✅ To Do", "📝 Empty one"]);
      expect(lists[0]?.items.map((i) => [i.text, i.checked])).toEqual([
        ["Oat milk", false],
        ["Bread", true],
        ["Eggs", false],
        ["Crème fraîche", false],
      ]);
      expect(lists[2]?.items.map((i) => [i.text, i.checked])).toEqual([
        ["Book the MOT", false],
        ["Fix the gate", true],
      ]);
      expect(new Set(lists.flatMap((l) => l.items.map((i) => `${i.source}:${String(i.createdBy)}`)))).toEqual(new Set([`${ListItemSource.import}:null`]));
    } finally {
      await rt.close();
    }
  });

  test("[CAP-6] with no connection string it says which variable to set; when the connection fails it does not print the password", async () => {
    const missing = await importScript({});
    expect(missing.code).toBe(2);
    expect(missing.out).toContain(FAMILY_LISTS_ENV);
    const wrong = sourceUrl.replace(readerPassword, "not-the-password-123");
    const failed = await importScript({ [FAMILY_LISTS_ENV]: wrong }, ["--practice"]);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("family-lists-import-failed");
    expect(failed.out).not.toContain("not-the-password-123");
  });
});
