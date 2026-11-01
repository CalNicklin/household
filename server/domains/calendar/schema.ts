import { relations } from "drizzle-orm";
import { boolean, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { at, id } from "../../db/columns.ts";

/**
 * A read-only copy of every Google calendar the house reads: one row per calendar's copy of an event,
 * read back merged by `uid` (merge.ts). The app never writes back (PRV-1).
 */
export const events = pgTable("events", {
  id: id(),
  /** `<calendarId>/<Google event id>`: the same invite on two calendars is two rows. */
  externalId: text("external_id").notNull().unique(),
  /** The calendar this copy came from; rows from a calendar the house no longer reads are dropped. */
  calendarId: text("calendar_id").notNull().default(""),
  /** A person ID, or `shared` (CalendarOwnerKind). */
  owner: text("owner").notNull().default("shared"),
  uid: text("uid"),
  busy: boolean("busy").notNull().default(false),
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
  /** Each calendar's next sync token, by calendar ID. A calendar with none is read in full. */
  syncTokens: jsonb("sync_tokens").$type<Record<string, string>>().notNull().default({}),
  at: at("at").notNull().defaultNow(),
  changedDates: text("changed_dates").array().notNull().default([]),
});

export const eventsRelations = relations(events, ({ one }) => ({
  sync: one(syncs, { fields: [events.syncId], references: [syncs.id] }),
}));
export const syncsRelations = relations(syncs, ({ many }) => ({ events: many(events) }));

/**
 * CH-6: every Google push channel the house has opened, one in use per calendar it reads (the newest
 * not closed). Not an event (PRV-1).
 */
export const watches = pgTable("watches", {
  id: id(),
  channelId: text("channel_id").notNull().unique(),
  calendarId: text("calendar_id").notNull(),
  resourceId: text("resource_id").notNull(),
  address: text("address").notNull(),
  expiresAt: at("expires_at").notNull(),
  openedAt: at("opened_at").notNull(),
  closedAt: at("closed_at"),
});
