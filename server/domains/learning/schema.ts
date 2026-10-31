import { DayPart, LearningEventKind, ModeKind, type Question, QuestionTopic, RhythmSource, Weekday } from "@household/contracts";
import { relations } from "drizzle-orm";
import { date, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { at, id, values } from "../../db/columns.ts";

/** LRN-1: every accept, dismiss, snooze, hand-over and Done, with its context. */
export const events = pgTable("events", {
  id: id(),
  kind: text("kind", { enum: values(LearningEventKind) }).notNull(),
  subject: text("subject").notNull(),
  ref: text("ref").notNull(),
  person: text("person").notNull(),
  date: date("date").notNull(),
  dayPart: text("day_part", { enum: values(DayPart) }).notNull(),
  weekday: text("weekday", { enum: values(Weekday) }).notNull(),
  hour: integer("hour").notNull(),
  weather: text("weather").notNull(),
  dayMode: text("day_mode", { enum: values(ModeKind) }).notNull(),
  at: at("at").notNull(),
});

/** LRN-2: how often an unscheduled chore happens. Delete a row and it forgets (LRN-7). */
export const rhythms = pgTable("rhythms", {
  id: id(),
  subject: text("subject").notNull().unique(),
  everyDays: integer("every_days").notNull(),
  usualWeekday: text("usual_weekday", { enum: values(Weekday) }),
  source: text("source", { enum: values(RhythmSource) }).notNull(),
});

/** LRN-3/4: one-tap questions; the same subject is never asked twice. */
export const questions = pgTable(
  "questions",
  {
    id: id(),
    topic: text("topic", { enum: values(QuestionTopic) }).notNull(),
    subject: text("subject").notNull(),
    text: text("text").notNull(),
    options: jsonb("options").$type<Question["options"]>().notNull(),
    askedOn: date("asked_on").notNull(),
    answer: text("answer"),
    rhythmId: text("rhythm_id").references(() => rhythms.id, { onDelete: "set null" }),
  },
  (t) => [uniqueIndex("questions_topic_subject").on(t.topic, t.subject), uniqueIndex("questions_asked_on").on(t.askedOn)],
);

/** LRN-5/6: learned preferences ("evening washing suggestions land badly", "offer to Chloe"). */
export const preferences = pgTable(
  "preferences",
  {
    id: id(),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    value: text("value").notNull(),
    sentence: text("sentence").notNull(),
  },
  (t) => [uniqueIndex("preferences_kind_subject").on(t.kind, t.subject)],
);

/** LRN-7: things the household told it to forget, so they are not relearned. */
export const forgotten = pgTable("forgotten", {
  id: id(),
  kind: text("kind").notNull(),
  subject: text("subject").notNull(),
  at: at("at").notNull(),
});

export const rhythmsRelations = relations(rhythms, ({ many }) => ({ questions: many(questions) }));
export const questionsRelations = relations(questions, ({ one }) => ({
  rhythm: one(rhythms, { fields: [questions.rhythmId], references: [rhythms.id] }),
}));
