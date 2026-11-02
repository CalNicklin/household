import { type ProductOption, ShoppingStatus } from "@household/contracts";
import { relations } from "drizzle-orm";
import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { at, createdAt, id, values } from "../../db/columns.ts";

export const requests = pgTable("requests", {
  id: id(),
  item: text("item").notNull(),
  person: text("person").notNull(),
  status: text("status", { enum: values(ShoppingStatus) }).notNull(),
  chosen: jsonb("chosen").$type<ProductOption>(),
  options: jsonb("options").$type<ProductOption[]>().notNull().default([]),
  sourceMessage: text("source_message").notNull(),
  createdAt: createdAt(),
});

/**
 * AUT-6: every run keeps a log and screenshots (object-storage keys, PLT-7). A person deleting the
 * request it ran for (HOU-158) keeps the run, with no request; `person` is whose request it was, so
 * PRV-7 can still delete everything about them.
 */
export const runs = pgTable("runs", {
  id: id(),
  requestId: text("request_id").references(() => requests.id, { onDelete: "set null" }),
  person: text("person"),
  log: jsonb("log").$type<{ at: string; line: string }[]>().notNull().default([]),
  screenshots: text("screenshots").array().notNull().default([]),
  createdAt: createdAt(),
});

/** What the helper added to the basket, so it can only ever remove its own (AUT-4). */
export const basketAdds = pgTable("basket_adds", {
  id: id(),
  requestId: text("request_id").notNull().references(() => requests.id, { onDelete: "cascade" }),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  at: at("at").notNull(),
});

export const summaries = pgTable("summaries", {
  id: id(),
  person: text("person").notNull(),
  deliveryDate: text("delivery_date").notNull(),
  at: at("at").notNull(),
});

export const requestsRelations = relations(requests, ({ many }) => ({ runs: many(runs), basketAdds: many(basketAdds) }));
export const runsRelations = relations(runs, ({ one }) => ({
  request: one(requests, { fields: [runs.requestId], references: [requests.id] }),
}));
export const basketAddsRelations = relations(basketAdds, ({ one }) => ({
  request: one(requests, { fields: [basketAdds.requestId], references: [requests.id] }),
}));
