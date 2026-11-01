import { boolean, date, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, id } from "../../db/columns.ts";

/** PRV-2: Chloe's health tracking, in its own database. Only its owner can add to it. */
export const entries = pgTable("entries", {
  id: id(),
  owner: text("owner").notNull(),
  date: date("date").notNull(),
  heavy: boolean("heavy").notNull(),
  createdAt: createdAt(),
});
