import { type Attachment, Channel, DeliveryChannel, JobStatus, ModelProvider, NotificationStatus, type NotifyAction, TimerKind, Urgency } from "@household/contracts";
import { relations } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { at, createdAt, id, values } from "../../db/columns.ts";

/**
 * Every inbound message. CH-4: the duplicate-check key is unique, so a retry is one row.
 * PRV-5: kept 30 days; with retention off, text and attachments are blanked on arrival.
 */
export const messages = pgTable(
  "messages",
  {
    id: id(),
    dedupeKey: text("dedupe_key").notNull(),
    channel: text("channel", { enum: values(Channel) }).notNull(),
    person: text("person"),
    text: text("text").notNull(),
    attachments: jsonb("attachments").$type<Attachment[]>().notNull(),
    receivedAt: at("received_at").notNull(),
    redacted: boolean("redacted").notNull().default(false),
  },
  (t) => [uniqueIndex("messages_dedupe").on(t.dedupeKey)],
);

/** PLT-2 / QA-8: one row per job, joined to its DBOS workflow by id. */
export const jobs = pgTable("jobs", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  channel: text("channel", { enum: values(Channel) }).notNull(),
  person: text("person"),
  intent: text("intent").notNull().default(""),
  status: text("status", { enum: values(JobStatus) }).notNull(),
  provider: text("provider", { enum: values(ModelProvider) }).notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costMicros: integer("cost_micros").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  toolCalls: jsonb("tool_calls").$type<{ tool: string; input: unknown; output: unknown }[]>().notNull().default([]),
  error: text("error"),
  createdAt: createdAt(),
});

/** CH-3: senders we could not identify, dropped at the edge and logged here. */
export const dropped = pgTable("dropped", {
  id: id(),
  channel: text("channel", { enum: values(Channel) }).notNull(),
  address: text("address").notNull(),
  reason: text("reason").notNull(),
  at: at("at").notNull(),
});

/** CH-7: every outgoing message, whichever channel the routing table chose. */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    key: text("key").notNull(),
    person: text("person").notNull(),
    message: text("message").notNull(),
    urgency: text("urgency", { enum: values(Urgency) }).notNull(),
    channel: text("channel", { enum: values(DeliveryChannel) }).notNull(),
    actions: jsonb("actions").$type<NotifyAction[]>().notNull(),
    status: text("status", { enum: values(NotificationStatus) }).notNull(),
    countsTowardsBudget: boolean("counts_towards_budget").notNull(),
    externalId: text("external_id"),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    sentAt: at("sent_at"),
  },
  (t) => [uniqueIndex("notifications_key_person").on(t.key, t.person)],
);

/** Conversational replies to a message, on the channel it came from. */
export const replies = pgTable("replies", {
  id: id(),
  person: text("person"),
  channel: text("channel", { enum: values(Channel) }).notNull(),
  text: text("text").notNull(),
  inReplyTo: text("in_reply_to").notNull().references(() => messages.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

/** CH-5: each timer fire, and each one that should have fired but did not. */
export const timerRuns = pgTable(
  "timer_runs",
  {
    id: id(),
    timer: text("timer", { enum: values(TimerKind) }).notNull(),
    scheduledFor: at("scheduled_for").notNull(),
    firedAt: at("fired_at"),
    missed: boolean("missed").notNull().default(false),
  },
  (t) => [uniqueIndex("timer_runs_timer_scheduled").on(t.timer, t.scheduledFor)],
);

/**
 * QA-8 / QA-10: usage a child workflow added to its job after the job finished, once per source (the
 * child workflow's ID), so a step that re-runs after a crash does not count it twice.
 */
export const jobUsage = pgTable(
  "job_usage",
  {
    id: id(),
    jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costMicros: integer("cost_micros").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("job_usage_job_source").on(t.jobId, t.source)],
);

export const messagesRelations = relations(messages, ({ many }) => ({ jobs: many(jobs), replies: many(replies) }));
export const jobsRelations = relations(jobs, ({ one, many }) => ({
  message: one(messages, { fields: [jobs.messageId], references: [messages.id] }),
  notifications: many(notifications),
  usage: many(jobUsage),
}));
export const jobUsageRelations = relations(jobUsage, ({ one }) => ({
  job: one(jobs, { fields: [jobUsage.jobId], references: [jobs.id] }),
}));
export const notificationsRelations = relations(notifications, ({ one }) => ({
  job: one(jobs, { fields: [notifications.jobId], references: [jobs.id] }),
}));
export const repliesRelations = relations(replies, ({ one }) => ({
  message: one(messages, { fields: [replies.inReplyTo], references: [messages.id] }),
}));
