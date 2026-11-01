import {
  AttachmentKind,
  Channel,
  type Job,
  type Notification,
  NotificationStatus,
  zAcceptMessageInput,
  zAcceptMessageOutput,
  zDropInput,
  zDroppedSender,
  zDroppedSendersInput,
  zEnqueueNotificationInput,
  zExchange,
  zExchangesForInput,
  zIdInput,
  zInboundMessage,
  zJob,
  zJobFinishInput,
  zJobStartInput,
  zJobUsageInput,
  zMarkNotificationInput,
  zNotification,
  zNotificationsForInput,
  zPersonInput,
  zRepliesForInput,
  zReply,
  zReplyInput,
  zSpendMonth,
  zTimerRun,
  zTimerRunInput,
} from "@household/contracts";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso, isoOrNull } from "../../db/map.ts";
import { readProcedure, router, systemProcedure } from "../../trpc.ts";
import * as schema from "./schema.ts";

export type JobsDb = DomainDb<typeof schema>;

const toJob = (r: typeof schema.jobs.$inferSelect): Job => ({ ...r, createdAt: iso(r.createdAt) });
const toNotification = (r: typeof schema.notifications.$inferSelect): Notification => ({
  id: r.id,
  key: r.key,
  person: r.person,
  message: r.message,
  urgency: r.urgency,
  channel: r.channel,
  actions: r.actions,
  status: r.status,
  createdAt: iso(r.createdAt),
  sentAt: isoOrNull(r.sentAt),
});

export function jobsRouter(db: JobsDb) {
  return router({
    /**
     * CH-4: the duplicate-check key is unique; a retried delivery returns the original message.
     * PRV-5: with retention off, nothing but the key is kept. PRV-3: email bodies are never kept.
     */
    acceptMessage: systemProcedure
      .input(zAcceptMessageInput)
      .output(zAcceptMessageOutput)
      .mutation(async ({ input }) => {
        const inserted = await db
          .insert(schema.messages)
          .values({
            dedupeKey: input.dedupeKey,
            channel: input.channel,
            person: input.person,
            text: input.text,
            attachments: input.attachments,
            receivedAt: new Date(input.receivedAt),
          })
          .onConflictDoNothing({ target: schema.messages.dedupeKey })
          .returning({ id: schema.messages.id });
        const first = inserted[0];
        if (first !== undefined) return { messageId: first.id, duplicate: false };
        const existing = await db.query.messages.findFirst({ where: eq(schema.messages.dedupeKey, input.dedupeKey) });
        if (existing === undefined) throw new Error("dedupe race");
        return { messageId: existing.id, duplicate: true };
      }),
    message: readProcedure.input(zIdInput).output(zInboundMessage.extend({ id: z.string(), redacted: z.boolean() }).nullable()).query(async ({ input }) => {
      const m = await db.query.messages.findFirst({ where: eq(schema.messages.id, input.id) });
      if (m === undefined) return null;
      return { id: m.id, household: "", person: m.person, channel: m.channel, text: m.text, attachments: m.attachments, dedupeKey: m.dedupeKey, receivedAt: iso(m.receivedAt), redacted: m.redacted };
    }),
    /**
     * PRV-3 / PRV-5: once its job is done, an email's text is dropped (we keep the shop and date,
     * not the email), and with retention off every message's text is dropped.
     */
    redactMessage: systemProcedure.input(zIdInput).mutation(async ({ input }) => {
      await db.update(schema.messages).set({ text: "", attachments: [], redacted: true }).where(eq(schema.messages.id, input.id));
    }),
    messageCount: readProcedure.output(z.number()).query(async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.messages))[0]?.n ?? 0),
    messages: readProcedure.output(z.array(z.object({ id: z.string(), channel: z.string(), person: z.string().nullable(), text: z.string(), redacted: z.boolean(), receivedAt: z.string() }))).query(async () =>
      (await db.select().from(schema.messages).orderBy(desc(schema.messages.receivedAt))).map((m) => ({ id: m.id, channel: m.channel, person: m.person, text: m.text, redacted: m.redacted, receivedAt: iso(m.receivedAt) })),
    ),
    /** PRV-5: messages are kept for 30 days to fix problems. */
    purgeMessagesBefore: systemProcedure.input(z.object({ before: z.iso.datetime({ offset: true }) })).output(z.number()).mutation(async ({ input }) => {
      const rows = await db.delete(schema.messages).where(lt(schema.messages.receivedAt, new Date(input.before))).returning({ id: schema.messages.id });
      return rows.length;
    }),
    redactAll: systemProcedure.mutation(async () => {
      await db.update(schema.messages).set({ text: "", attachments: [], redacted: true });
    }),

    /** CH-3: unknown senders are dropped at the edge and logged. */
    drop: systemProcedure.input(zDropInput).mutation(async ({ ctx, input }) => {
      await db.insert(schema.dropped).values({ ...input, at: ctx.now });
    }),
    dropped: readProcedure.output(z.array(z.object({ channel: z.string(), address: z.string(), reason: z.string() }))).query(async () =>
      db.select({ channel: schema.dropped.channel, address: schema.dropped.address, reason: schema.dropped.reason }).from(schema.dropped),
    ),
    /** CH-3: each sender dropped on a channel, newest first, so an adult can find their own ID on the server. */
    droppedSenders: readProcedure.input(zDroppedSendersInput).output(z.array(zDroppedSender)).query(async ({ input }) => {
      const lastAt = sql<Date>`max(${schema.dropped.at})`.mapWith(schema.dropped.at);
      const rows = await db
        .select({ address: schema.dropped.address, lastAt, times: sql<number>`count(*)`.mapWith(Number) })
        .from(schema.dropped)
        .where(eq(schema.dropped.channel, input.channel))
        .groupBy(schema.dropped.address)
        .orderBy(desc(lastAt));
      return rows.map((r) => ({ address: r.address, lastAt: iso(r.lastAt), times: r.times }));
    }),

    startJob: systemProcedure.input(zJobStartInput).mutation(async ({ ctx, input }) => {
      const message = await db.query.messages.findFirst({ where: eq(schema.messages.id, input.messageId) });
      await db
        .insert(schema.jobs)
        .values({ id: input.id, messageId: input.messageId, channel: message?.channel ?? Channel.app, person: message?.person ?? null, status: "running", provider: input.provider, model: input.model, createdAt: ctx.now })
        .onConflictDoNothing();
    }),
    finishJob: systemProcedure.input(zJobFinishInput).mutation(async ({ ctx, input }) => {
      const { id, ...rest } = input;
      await db.update(schema.jobs).set(rest).where(eq(schema.jobs.id, id));
      // HOU-149: the reply's answer (the one thing) is read from the finished job's tool calls.
      ctx.publish("replies");
    }),
    /**
     * QA-8 / QA-10: adds to a job's totals rather than replacing them, so a child workflow can report after
     * the job finished. Once per source, atomically: a re-run step adds nothing the second time.
     */
    addJobUsage: systemProcedure.input(zJobUsageInput).mutation(async ({ ctx, input }) => {
      await db.transaction(async (tx) => {
        // A job purged with its message (PRV-5) has no totals left to add to.
        const job = await tx.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.id, input.id)).for("update");
        if (job.length === 0) return;
        const added = await tx
          .insert(schema.jobUsage)
          .values({ jobId: input.id, source: input.source, inputTokens: input.inputTokens, outputTokens: input.outputTokens, costMicros: input.costMicros, createdAt: ctx.now })
          .onConflictDoNothing()
          .returning({ id: schema.jobUsage.id });
        if (added.length === 0) return;
        await tx
          .update(schema.jobs)
          .set({
            inputTokens: sql`${schema.jobs.inputTokens} + ${input.inputTokens}`,
            outputTokens: sql`${schema.jobs.outputTokens} + ${input.outputTokens}`,
            costMicros: sql`${schema.jobs.costMicros} + ${input.costMicros}`,
          })
          .where(eq(schema.jobs.id, input.id));
      });
    }),
    job: readProcedure.input(zIdInput).output(zJob.nullable()).query(async ({ input }) => {
      const row = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, input.id) });
      return row === undefined ? null : toJob(row);
    }),
    jobForMessage: readProcedure.input(zIdInput).output(zJob.nullable()).query(async ({ input }) => {
      const row = await db.query.jobs.findFirst({ where: eq(schema.jobs.messageId, input.id) });
      return row === undefined ? null : toJob(row);
    }),
    recentJobs: readProcedure.output(z.array(zJob)).query(async () => (await db.select().from(schema.jobs).orderBy(desc(schema.jobs.createdAt)).limit(200)).map(toJob)),
    jobsBetween: readProcedure.input(z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })).output(z.array(zJob)).query(async ({ input }) =>
      (await db.select().from(schema.jobs).where(and(gte(schema.jobs.createdAt, new Date(input.from)), lt(schema.jobs.createdAt, new Date(input.to))))).map(toJob),
    ),
    /** QA-8: monthly AI spend. */
    spendByMonth: readProcedure.output(z.array(zSpendMonth)).query(async () => {
      const rows = await db
        .select({
          month: sql<string>`to_char(${schema.jobs.createdAt}, 'YYYY-MM')`,
          costMicros: sql<number>`coalesce(sum(${schema.jobs.costMicros}),0)::int`,
          jobs: sql<number>`count(*)::int`,
          inputTokens: sql<number>`coalesce(sum(${schema.jobs.inputTokens}),0)::int`,
          outputTokens: sql<number>`coalesce(sum(${schema.jobs.outputTokens}),0)::int`,
        })
        .from(schema.jobs)
        .groupBy(sql`1`)
        .orderBy(sql`1 desc`);
      return rows;
    }),

    /** CH-7 / PRO-9: one row per (key, person); the same nudge is never queued twice. */
    enqueueNotification: systemProcedure.input(zEnqueueNotificationInput).output(z.object({ notification: zNotification, created: z.boolean() })).mutation(async ({ ctx, input }) => {
      const inserted = await db
        .insert(schema.notifications)
        .values({ ...input, createdAt: ctx.now })
        .onConflictDoNothing({ target: [schema.notifications.key, schema.notifications.person] })
        .returning();
      const created = inserted[0];
      if (created !== undefined) {
        ctx.publish("notifications");
        return { notification: toNotification(created), created: true };
      }
      const existing = await db.query.notifications.findFirst({ where: and(eq(schema.notifications.key, input.key), eq(schema.notifications.person, input.person)) });
      if (existing === undefined) throw new Error("notification race");
      return { notification: toNotification(existing), created: false };
    }),
    markNotification: systemProcedure.input(zMarkNotificationInput).output(zNotification).mutation(async ({ ctx, input }) => {
      const sent = input.status === NotificationStatus.sent ? { sentAt: ctx.now } : {};
      const ext = input.externalId === undefined ? {} : { externalId: input.externalId };
      const [row] = await db.update(schema.notifications).set({ status: input.status, ...sent, ...ext }).where(eq(schema.notifications.id, input.id)).returning();
      if (row === undefined) throw new Error("no notification");
      ctx.publish("notifications");
      return toNotification(row);
    }),
    /** PRO-9: dismissing a nudge anywhere dismisses every copy keyed to the same thing. */
    closeNotificationsForRef: systemProcedure.input(z.object({ ref: z.string(), status: z.enum({ dismissed: NotificationStatus.dismissed, done: NotificationStatus.done }) })).output(z.array(zNotification)).mutation(async ({ ctx, input }) => {
      const open = await db.select().from(schema.notifications).where(inArray(schema.notifications.status, [NotificationStatus.queued, NotificationStatus.sent, NotificationStatus.deferred, NotificationStatus.onScreen]));
      const matching = open.filter((n) => n.key === input.ref || n.key.startsWith(`${input.ref}:`) || n.actions.some((a) => a.ref === input.ref));
      if (matching.length === 0) return [];
      const rows = await db.update(schema.notifications).set({ status: input.status }).where(inArray(schema.notifications.id, matching.map((m) => m.id))).returning();
      ctx.publish("notifications");
      return rows.map(toNotification);
    }),
    notification: readProcedure.input(zIdInput).output(zNotification.nullable()).query(async ({ input }) => {
      const row = await db.query.notifications.findFirst({ where: eq(schema.notifications.id, input.id) });
      return row === undefined ? null : toNotification(row);
    }),
    notificationByExternalId: readProcedure.input(zIdInput).output(zNotification.nullable()).query(async ({ input }) => {
      const row = await db.query.notifications.findFirst({ where: eq(schema.notifications.externalId, input.id) });
      return row === undefined ? null : toNotification(row);
    }),
    notifications: readProcedure.input(zNotificationsForInput).output(z.array(zNotification)).query(async ({ input }) => {
      const byStatus = inArray(schema.notifications.status, input.statuses);
      const where = input.person === undefined ? byStatus : and(byStatus, eq(schema.notifications.person, input.person));
      return (await db.select().from(schema.notifications).where(where).orderBy(desc(schema.notifications.createdAt))).map(toNotification);
    }),
    /** PRO-7: how many budgeted messages a person has been sent since a time. */
    sentCountSince: readProcedure.input(z.object({ person: z.string(), since: z.iso.datetime({ offset: true }), until: z.iso.datetime({ offset: true }) })).output(z.number()).query(async ({ input }) => {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.person, input.person), eq(schema.notifications.countsTowardsBudget, true), gte(schema.notifications.sentAt, new Date(input.since)), lt(schema.notifications.sentAt, new Date(input.until))));
      return rows[0]?.n ?? 0;
    }),

    addReply: systemProcedure.input(zReplyInput).output(zReply).mutation(async ({ ctx, input }) => {
      const [row] = await db.insert(schema.replies).values({ ...input, createdAt: ctx.now }).returning();
      if (row === undefined) throw new Error("insert failed");
      ctx.publish("replies");
      return { ...row, createdAt: iso(row.createdAt) };
    }),
    replies: readProcedure.input(zRepliesForInput).output(z.array(zReply)).query(async ({ input }) => {
      const where = input.since === undefined ? eq(schema.replies.person, input.person) : and(eq(schema.replies.person, input.person), gte(schema.replies.createdAt, new Date(input.since)));
      return (await db.select().from(schema.replies).where(where).orderBy(desc(schema.replies.createdAt)).limit(20)).map((r) => ({ ...r, createdAt: iso(r.createdAt) }));
    }),
    /**
     * HOU-159: what a person said in the app since a time, oldest first, each with the house's reply.
     * Person-scoped: only their own messages and the replies to them.
     */
    exchanges: readProcedure.input(zExchangesForInput).output(z.array(zExchange)).query(async ({ input }) => {
      const rows = await db.query.messages.findMany({
        where: and(eq(schema.messages.person, input.person), eq(schema.messages.channel, Channel.app), gte(schema.messages.receivedAt, new Date(input.since))),
        with: { replies: { where: eq(schema.replies.person, input.person), orderBy: desc(schema.replies.createdAt) } },
        orderBy: schema.messages.receivedAt,
      });
      return rows.map((m) => {
        const r = m.replies[0];
        return {
          id: m.id,
          text: m.text,
          redacted: m.redacted,
          receivedAt: iso(m.receivedAt),
          tap: m.attachments.some((a) => a.kind === AttachmentKind.ref && a.action !== undefined),
          reply: r === undefined ? null : { id: r.id, text: r.text, createdAt: iso(r.createdAt) },
        };
      });
    }),
    replyFor: readProcedure.input(zIdInput).output(zReply.nullable()).query(async ({ input }) => {
      const row = await db.query.replies.findFirst({ where: eq(schema.replies.inReplyTo, input.id) });
      return row === undefined ? null : { ...row, createdAt: iso(row.createdAt) };
    }),

    /** CH-5: fires and misses, for the run log. */
    recordTimer: systemProcedure.input(zTimerRunInput).mutation(async ({ ctx, input }) => {
      await db
        .insert(schema.timerRuns)
        .values({ timer: input.timer, scheduledFor: new Date(input.scheduledFor), firedAt: input.missed ? null : ctx.now, missed: input.missed })
        .onConflictDoNothing();
    }),
    timerRuns: readProcedure.output(z.array(zTimerRun)).query(async () =>
      (await db.select().from(schema.timerRuns).orderBy(desc(schema.timerRuns.scheduledFor)).limit(500)).map((r) => ({ id: r.id, timer: r.timer, scheduledFor: iso(r.scheduledFor), firedAt: isoOrNull(r.firedAt), missed: r.missed })),
    ),

    exportPerson: systemProcedure.input(zPersonInput).query(async ({ input }) => ({
      messages: await db.select().from(schema.messages).where(eq(schema.messages.person, input.person)),
      notifications: await db.select().from(schema.notifications).where(eq(schema.notifications.person, input.person)),
      replies: await db.select().from(schema.replies).where(eq(schema.replies.person, input.person)),
    })),
    deletePerson: systemProcedure.input(zPersonInput).mutation(async ({ input }) => {
      await db.delete(schema.notifications).where(eq(schema.notifications.person, input.person));
      await db.delete(schema.replies).where(eq(schema.replies.person, input.person));
      await db.delete(schema.messages).where(eq(schema.messages.person, input.person));
    }),
  });
}
