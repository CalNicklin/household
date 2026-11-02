import { BacklogStatus, BacklogTag, Channel, ReminderStatus } from "@household/contracts";
import { relations } from "drizzle-orm";
import { boolean, date, integer, pgTable, text } from "drizzle-orm/pg-core";
import { at, createdAt, id, values } from "../../db/columns.ts";

/** CAP-2: no due date, no priority. Only tags. */
export const items = pgTable("items", {
  id: id(),
  text: text("text").notNull(),
  tags: text("tags", { enum: values(BacklogTag) }).array().notNull().default([]),
  confirmedTags: boolean("confirmed_tags").notNull().default(false),
  status: text("status", { enum: values(BacklogStatus) }).notNull().default(BacklogStatus.active),
  notNowCount: integer("not_now_count").notNull().default(0),
  createdBy: text("created_by").notNull(),
  createdVia: text("created_via", { enum: values(Channel) }).notNull(),
  sourceMessage: text("source_message").notNull(),
  createdAt: createdAt(),
  doneAt: at("done_at"),
});

/** Every "not now" against an item, for CAP-5. */
export const notNows = pgTable("not_nows", {
  id: id(),
  itemId: text("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  person: text("person").notNull(),
  createdAt: createdAt(),
});

/**
 * CAP-10: a reminder one of us asked for. With no time, one left open at the end of its day becomes a
 * backlog item (`itemId`) with the same text and author.
 */
export const reminders = pgTable("reminders", {
  id: id(),
  text: text("text").notNull(),
  for: text("for").array().notNull(),
  date: date("date").notNull(),
  time: text("time"),
  askedBy: text("asked_by").notNull(),
  createdVia: text("created_via", { enum: values(Channel) }).notNull(),
  sourceMessage: text("source_message").notNull().unique(),
  status: text("status", { enum: values(ReminderStatus) }).notNull().default(ReminderStatus.open),
  itemId: text("item_id").references(() => items.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  doneAt: at("done_at"),
});

export const remindersRelations = relations(reminders, ({ one }) => ({
  item: one(items, { fields: [reminders.itemId], references: [items.id] }),
}));

export const itemsRelations = relations(items, ({ many }) => ({ notNows: many(notNows) }));
export const notNowsRelations = relations(notNows, ({ one }) => ({
  item: one(items, { fields: [notNows.itemId], references: [items.id] }),
}));
