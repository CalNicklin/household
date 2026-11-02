import { ActionKind, type Block, Channel, type HourlyForecast } from "@household/contracts";
import { relations } from "drizzle-orm";
import { date, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { at, createdAt, id, values } from "../../db/columns.ts";

/** PLT-4: one row per version of a day's plan, with the inputs that made it. */
export const plans = pgTable(
  "plans",
  {
    id: id(),
    date: date("date").notNull(),
    version: integer("version").notNull(),
    blocks: jsonb("blocks").$type<Block[]>().notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
    trigger: text("trigger").notNull(),
    jobId: text("job_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("plans_date_version").on(t.date, t.version)],
);

/** Every tap: Done, Not today, Snooze, hand-over. Planner items are never "overdue". */
export const responses = pgTable("responses", {
  id: id(),
  ref: text("ref").notNull(),
  action: text("action", { enum: values(ActionKind) }).notNull(),
  person: text("person").notNull(),
  channel: text("channel", { enum: values(Channel) }).notNull(),
  date: date("date").notNull(),
  value: text("value"),
  planId: text("plan_id").references(() => plans.id),
  at: at("at").notNull(),
});

/** MOM-6: an item handed to the other person. */
export const handOvers = pgTable("hand_overs", {
  id: id(),
  ref: text("ref").notNull(),
  title: text("title").notNull(),
  from: text("from_person").notNull(),
  to: text("to_person").notNull(),
  responseId: text("response_id").references(() => responses.id),
  at: at("at").notNull(),
});

/** PRO-6: which backlog item was offered on which day (at most one, and only once). */
export const offers = pgTable(
  "offers",
  {
    id: id(),
    itemId: text("item_id").notNull(),
    date: date("date").notNull(),
    person: text("person"),
    planId: text("plan_id").references(() => plans.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("offers_item").on(t.itemId), uniqueIndex("offers_date").on(t.date)],
);

/** PLT-3 / HOU-170: the last good forecast for each date, so a weather outage plans with it. */
export const forecasts = pgTable("forecasts", {
  date: date("date").primaryKey(),
  hours: jsonb("hours").$type<HourlyForecast[]>().notNull(),
  fetchedAt: at("fetched_at").notNull(),
});

export const plansRelations = relations(plans, ({ many }) => ({ responses: many(responses), offers: many(offers) }));
export const responsesRelations = relations(responses, ({ one, many }) => ({
  plan: one(plans, { fields: [responses.planId], references: [plans.id] }),
  handOvers: many(handOvers),
}));
export const handOversRelations = relations(handOvers, ({ one }) => ({
  response: one(responses, { fields: [handOvers.responseId], references: [responses.id] }),
}));
export const offersRelations = relations(offers, ({ one }) => ({
  plan: one(plans, { fields: [offers.planId], references: [plans.id] }),
}));
