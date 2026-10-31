import type { WellbeingScore } from "@household/contracts";
import { boolean, date, doublePrecision, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { at, id } from "../../db/columns.ts";

/** WB-8: the only thing kept is the daily score and what it was made from. */
export const scores = pgTable(
  "scores",
  {
    id: id(),
    person: text("person").notNull(),
    date: date("date").notNull(),
    score: doublePrecision("score").notNull(),
    heavy: boolean("heavy").notNull(),
    freeHours: doublePrecision("free_hours").notNull(),
    factors: jsonb("factors").$type<WellbeingScore["factors"]>().notNull(),
  },
  (t) => [uniqueIndex("scores_person_date").on(t.person, t.date)],
);

/** WB-5: wellbeing messages sent (twice a week at most) and "not helpful" mutes. */
export const nudges = pgTable("nudges", {
  id: id(),
  about: text("about").notNull(),
  to: text("to_person").notNull(),
  date: date("date").notNull(),
  at: at("at").notNull(),
});

export const mutes = pgTable("mutes", {
  person: text("person").primaryKey(),
  until: at("until").notNull(),
});
