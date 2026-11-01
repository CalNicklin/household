import type { ListImportInput } from "@household/contracts";
import { Client } from "pg";
import { z } from "zod";

/**
 * CAP-6: the one-off import from Family Lists (the Supabase app the household used before lists lived
 * here). This half only reads: one read-only transaction, two SELECTs, nothing else. Family Lists is
 * never changed.
 */
export const FAMILY_LISTS_ENV = "FAMILY_LISTS_DATABASE_URL";

const zRow = { position: z.number().int(), created_at: z.date() };
const zListRow = z.object({ id: z.string(), name: z.string(), emoji: z.string(), ...zRow });
const zItemRow = z.object({ list_id: z.string(), text: z.string(), checked: z.boolean(), ...zRow });

/**
 * Lists and their items in the order Family Lists shows them (position, then when they were made), as
 * the lists domain's import input. Positions are renumbered 0, 1, 2… so the order survives exactly.
 */
export async function readFamilyLists(connectionString: string): Promise<ListImportInput> {
  const client = new Client({ connectionString, application_name: "household-family-lists-import" });
  await client.connect();
  try {
    await client.query("set session characteristics as transaction read only");
    await client.query("begin isolation level repeatable read read only");
    const lists = z.array(zListRow).parse((await client.query("select id::text, name, emoji, position, created_at from public.lists order by position, created_at, id")).rows);
    const items = z.array(zItemRow).parse((await client.query("select list_id::text, text, checked, position, created_at from public.items order by position, created_at, id")).rows);
    await client.query("commit");
    return {
      lists: lists.map((l, position) => ({
        name: l.name.trim(),
        emoji: l.emoji.trim(),
        position,
        createdAt: l.created_at.toISOString(),
        items: items
          .filter((i) => i.list_id === l.id)
          .map((i, n) => ({ text: i.text.trim(), checked: i.checked, position: n, createdAt: i.created_at.toISOString() })),
      })),
    };
  } finally {
    await client.end();
  }
}

/** An error message with the connection string and its password taken out, so neither reaches a log. */
export function redacted(message: string, connectionString: string): string {
  let out = message.split(connectionString).join("[FAMILY_LISTS_DATABASE_URL]");
  try {
    const password = decodeURIComponent(new URL(connectionString).password);
    if (password !== "") out = out.split(password).join("[redacted]");
  } catch {
    // Not a URL (a keyword/value connection string): only the whole string is taken out.
  }
  return out;
}
