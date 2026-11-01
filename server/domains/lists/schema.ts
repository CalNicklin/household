import { ListItemSource } from "@household/contracts";
import { relations, sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, id, values } from "../../db/columns.ts";

/** CAP-6: the household's shared lists (shopping, presents, packing), brought in from Family Lists. */
export const lists = pgTable("lists", {
  id: id(),
  name: text("name").notNull(),
  emoji: text("emoji").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: createdAt(),
});

export const items = pgTable(
  "items",
  {
    id: id(),
    listId: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    checked: boolean("checked").notNull().default(false),
    position: integer("position").notNull().default(0),
    createdBy: text("created_by"),
    source: text("source", { enum: values(ListItemSource) }).notNull(),
    /** The message a job was handling when the house added it (PRV-1); null for the Lists screen and the import. */
    sourceMessage: text("source_message"),
    /**
     * PLT-2 / PRV-1: what a job added, as `<message>:<lower(trim(text))>`. A job step re-run after a crash
     * finds its own item by this, even if a person has renamed it since; null for people and the import.
     */
    sourceKey: text("source_key"),
    createdAt: createdAt(),
  },
  (t) => [
    // CAP-6: an item is on a list once, ignoring case and surrounding spaces. The router checks first;
    // this makes a duplicate impossible even when two phones add the same thing at the same moment.
    uniqueIndex("items_list_text_ci_uniq").on(t.listId, sql`lower(btrim(${t.text}))`),
    index("items_created_by_idx").on(t.createdBy),
    uniqueIndex("items_list_source_key_uniq").on(t.listId, t.sourceKey),
  ],
);

export const listsRelations = relations(lists, ({ many }) => ({ items: many(items) }));
export const itemsRelations = relations(items, ({ one }) => ({
  list: one(lists, { fields: [items.listId], references: [lists.id] }),
}));
