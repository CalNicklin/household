import { BacklogTag, type DeliveryChannel, ModeKind, NurseryEventKind, PersonRole, RuleKind, type RuleSpec, type Urgency, Weekday } from "@household/contracts";
import { relations } from "drizzle-orm";
import { boolean, date, doublePrecision, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { at, createdAt, id, values } from "../../db/columns.ts";

export const settings = pgTable("settings", {
  household: text("household").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  retainMessages: boolean("retain_messages").notNull().default(true),
  latitude: doublePrecision("latitude").notNull(),
  longitude: doublePrecision("longitude").notNull(),
  /** PRV-2: the one person whose health tracking exists at all. */
  healthOwner: text("health_owner"),
});

/** PRV-4: a child row holds a first name and nursery days, nothing else. */
export const people = pgTable("people", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role", { enum: values(PersonRole) }).notNull(),
  nurseryDays: text("nursery_days", { enum: values(Weekday) }).array().notNull().default([]),
});

/** CH-3: how a sender on a channel maps to a person. Only adults have identities. */
export const identities = pgTable(
  "identities",
  {
    id: id(),
    personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    address: text("address").notNull(),
  },
  (t) => [uniqueIndex("identities_channel_address").on(t.channel, t.address)],
);

export const logins = pgTable("logins", {
  personId: text("person_id").primaryKey().references(() => people.id, { onDelete: "cascade" }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
});

export const personSettings = pgTable("person_settings", {
  personId: text("person_id").primaryKey().references(() => people.id, { onDelete: "cascade" }),
  dailyMessageBudget: integer("daily_message_budget").notNull(),
  quietStartHour: integer("quiet_start_hour").notNull(),
  quietEndHour: integer("quiet_end_hour").notNull(),
  routing: jsonb("routing").$type<Record<(typeof Urgency)[keyof typeof Urgency], (typeof DeliveryChannel)[keyof typeof DeliveryChannel]>>().notNull(),
  wellbeingEnabled: boolean("wellbeing_enabled").notNull().default(true),
  healthInScore: boolean("health_in_score").notNull().default(false),
});

export const sitters = pgTable("sitters", {
  id: id(),
  name: text("name").notNull().unique(),
  knownFreeDays: text("known_free_days", { enum: values(Weekday) }).array().notNull().default([]),
});

/** PRV-8: the only outside people the app may message. */
export const sitterIdentities = pgTable("sitter_identities", {
  id: id(),
  sitterId: text("sitter_id").notNull().references(() => sitters.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  address: text("address").notNull(),
});

export const sitterBookings = pgTable("sitter_bookings", {
  id: id(),
  sitterId: text("sitter_id").notNull().references(() => sitters.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  recordedBy: text("recorded_by").notNull().references(() => people.id),
  createdAt: createdAt(),
});

export const modes = pgTable("modes", {
  id: id(),
  mode: text("mode", { enum: values(ModeKind) }).notNull(),
  setBy: text("set_by").notNull().references(() => people.id),
  setAt: at("set_at").notNull(),
  endsAt: at("ends_at").notNull(),
});

/** Household rules (bins, chores). Written by a person; the app can only read them (PRV-1). */
export const rules = pgTable("rules", {
  id: id(),
  kind: text("kind", { enum: values(RuleKind) }).notNull(),
  spec: jsonb("spec").$type<RuleSpec>().notNull(),
  createdBy: text("created_by").notNull().references(() => people.id),
  createdAt: createdAt(),
});

export const nurseryTerms = pgTable("nursery_terms", {
  id: id(),
  start: date("start").notNull(),
  end: date("end").notNull(),
});

export const nurseryEvents = pgTable("nursery_events", {
  id: id(),
  kind: text("kind", { enum: values(NurseryEventKind) }).notNull(),
  date: date("date").notNull(),
  title: text("title").notNull(),
  coveredBy: text("covered_by").references(() => people.id),
});

/** WB-3: the short list of small things we write ourselves. */
export const wellbeingIdeas = pgTable("wellbeing_ideas", {
  id: id(),
  text: text("text").notNull(),
  createdBy: text("created_by").notNull().references(() => people.id),
});

/** Tags that the household has taught the tagger by correcting it (CAP-3). */
export const tagHints = pgTable("tag_hints", {
  id: id(),
  word: text("word").notNull(),
  tag: text("tag", { enum: values(BacklogTag) }).notNull(),
});

export const peopleRelations = relations(people, ({ many, one }) => ({
  identities: many(identities),
  login: one(logins),
  settings: one(personSettings),
  modes: many(modes),
  rules: many(rules),
  sitterBookings: many(sitterBookings),
  coveredNurseryEvents: many(nurseryEvents),
  wellbeingIdeas: many(wellbeingIdeas),
}));
export const identitiesRelations = relations(identities, ({ one }) => ({
  person: one(people, { fields: [identities.personId], references: [people.id] }),
}));
export const loginsRelations = relations(logins, ({ one }) => ({
  person: one(people, { fields: [logins.personId], references: [people.id] }),
}));
export const personSettingsRelations = relations(personSettings, ({ one }) => ({
  person: one(people, { fields: [personSettings.personId], references: [people.id] }),
}));
export const sittersRelations = relations(sitters, ({ many }) => ({
  identities: many(sitterIdentities),
  bookings: many(sitterBookings),
}));
export const sitterIdentitiesRelations = relations(sitterIdentities, ({ one }) => ({
  sitter: one(sitters, { fields: [sitterIdentities.sitterId], references: [sitters.id] }),
}));
export const sitterBookingsRelations = relations(sitterBookings, ({ one }) => ({
  sitter: one(sitters, { fields: [sitterBookings.sitterId], references: [sitters.id] }),
  recorder: one(people, { fields: [sitterBookings.recordedBy], references: [people.id] }),
}));
export const modesRelations = relations(modes, ({ one }) => ({
  setter: one(people, { fields: [modes.setBy], references: [people.id] }),
}));
export const rulesRelations = relations(rules, ({ one }) => ({
  author: one(people, { fields: [rules.createdBy], references: [people.id] }),
}));
export const nurseryEventsRelations = relations(nurseryEvents, ({ one }) => ({
  coverer: one(people, { fields: [nurseryEvents.coveredBy], references: [people.id] }),
}));
export const wellbeingIdeasRelations = relations(wellbeingIdeas, ({ one }) => ({
  author: one(people, { fields: [wellbeingIdeas.createdBy], references: [people.id] }),
}));
