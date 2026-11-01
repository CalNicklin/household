import { randomUUID } from "node:crypto";
import { text, timestamp } from "drizzle-orm/pg-core";

/** Values of an `as const` enum object, for Drizzle's TS-only text enums (no Postgres enums, CODE-1). */
export function values<T extends Record<string, string>>(obj: T): [T[keyof T], ...T[keyof T][]] {
  const list: T[keyof T][] = Object.keys(obj).map((k: keyof T) => obj[k]);
  const [first, ...rest] = list;
  if (first === undefined) throw new Error("empty enum");
  return [first, ...rest];
}

export const id = () => text("id").primaryKey().$defaultFn(() => randomUUID());
export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const at = (name: string) => timestamp(name, { withTimezone: true });
