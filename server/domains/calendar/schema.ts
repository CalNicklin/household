import { relations } from "drizzle-orm";
import { boolean, pgTable, text } from "drizzle-orm/pg-core";
import { at, id } from "../../db/columns.ts";

/** A read-only copy of the shared Google Calendar. The app never writes back (PRV-1). */
export const events = pgTable("events", {
  id: id(),
  externalId: text("external_id").notNull().unique(),
  title: text("title").notNull(),
  start: at("start").notNull(),
  end: at("end").notNull(),
  allDay: boolean("all_day").notNull().default(false),
  attendees: text("attendees").array().notNull().default([]),
  away: text("away").array().notNull().default([]),
  work: boolean("work").notNull().default(false),
  soloWithKids: text("solo_with_kids"),
  syncId: text("sync_id").references(() => syncs.id),
});

export const syncs = pgTable("syncs", {
  id: id(),
  syncToken: text("sync_token"),
  at: at("at").notNull().defaultNow(),
  changedDates: text("changed_dates").array().notNull().default([]),
});

export const eventsRelations = relations(events, ({ one }) => ({
  sync: one(syncs, { fields: [events.syncId], references: [syncs.id] }),
}));
export const syncsRelations = relations(syncs, ({ many }) => ({ events: many(events) }));

/** CH-6: every Google push channel the house has opened; the newest is the one in use. Not an event (PRV-1). */
export const watches = pgTable("watches", {
  id: id(),
  channelId: text("channel_id").notNull().unique(),
  calendarId: text("calendar_id").notNull(),
  resourceId: text("resource_id").notNull(),
  address: text("address").notNull(),
  expiresAt: at("expires_at").notNull(),
  openedAt: at("opened_at").notNull(),
});
