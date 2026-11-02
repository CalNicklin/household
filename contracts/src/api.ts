/** Router inputs (CODE-5). Outputs are the records in domain.ts and blocks.ts. */
import { z } from "zod";
import { zBlock } from "./blocks.ts";
import { zArrival, zCalendarCopy, zCalendarWatch, zHourlyForecast, zJob, zLearningEvent, zListItem, zLocalTime, zNurseryEvent, zPersonSettings, zProductOption, zQuestion, zRhythm, zRuleSpec, zTelegramUserId } from "./domain.ts";
import { LongTool, zActionKind, zBacklogTag, zChannel, zDayPart, zDeliveryChannel, zListWriteOutcome, zLongTool, zModeKind, zModelProvider, zNotificationStatus, zShoppingStatus, zTimerKind } from "./enums.ts";
import { zInboundMessage, zNotifyInput } from "./message.ts";

export const zIdInput = z.object({ id: z.string() });
export const zPersonInput = z.object({ person: z.string() });
/** `index`: which capture of its message this is (0 = the first), so a retried job finds each item again (HOU-148). */
export const zBacklogCreateInput = z.object({ text: z.string().min(1), tags: z.array(zBacklogTag), createdVia: zChannel, sourceMessage: z.string(), index: z.number().int().min(0).optional() });
/** CAP-10: a reminder from the message being handled; `index` as for a capture (HOU-148). */
export const zRemindInput = z.object({
  text: z.string().min(1),
  for: z.array(z.string()).min(1),
  date: z.iso.date(),
  time: zLocalTime.nullable(),
  createdVia: zChannel,
  sourceMessage: z.string(),
  index: z.number().int().min(0).optional(),
});
export const zLocalDateRangeInput = z.object({ from: z.iso.date(), to: z.iso.date() });
/**
 * HOU-174: a person moves or re-times a reminder, or cancels it, when they ask. A job may do it only
 * from the message it is handling (PRV-1), like setting one.
 */
export const zReminderChangeInput = z.object({ id: z.string(), date: z.iso.date(), time: zLocalTime.nullable(), sourceMessage: z.string() });
export const zReminderCancelInput = z.object({ id: z.string(), sourceMessage: z.string() });
/**
 * HOU-174: open reminders on `from` or later, the ones a person could still change or cancel. HOU-177:
 * with `closed`, those already done, moved to the Backlog or cancelled instead, to say what became of one.
 */
export const zUpcomingRemindersInput = z.object({ from: z.iso.date(), closed: z.boolean().optional() });
/**
 * CAP-10: "Not now" or "Later" moves a reminder to another day, keeping its time. HOU-177: only from the
 * message of the person who tapped it (PRV-1), like a change or cancel.
 */
export const zReminderMoveInput = z.object({ id: z.string(), date: z.iso.date(), sourceMessage: z.string() });
/** CAP-10: Done on a reminder. HOU-177: only from the message of the person who tapped it (PRV-1). */
export const zReminderDoneInput = z.object({ id: z.string(), sourceMessage: z.string() });
/** CAP-10: open reminders with no time from before `today` become backlog items. */
export const zRemindersToBacklogInput = z.object({ today: z.iso.date() });
export const zBacklogSetTagsInput = z.object({ id: z.string(), tags: z.array(zBacklogTag) });
export const zPersonExport = z.record(z.string(), z.unknown());

export const zResolveIdentityInput = z.object({ channel: zChannel, address: z.string() });
export const zLoginInput = z.object({ username: z.string(), password: z.string() });
/**
 * HOU-156: a mode starts now unless `startsAt` names a later time ("we're away this weekend"). For
 * `normal`, the span from start to `endsAt` is cleared of other modes, and the row recorded for it
 * lasts no time (it ends where it starts), so it never shows as a day's mode.
 */
export const zSetModeRequest = z.object({ mode: zModeKind, startsAt: z.iso.datetime({ offset: true }).optional(), endsAt: z.iso.datetime({ offset: true }) });
export const zPersonSettingsPatch = zPersonSettings.omit({ person: true }).partial();
export const zHouseholdSettingsPatch = z.object({ retainMessages: z.boolean() }).partial();
export const zRuleCreateInput = z.object({ spec: zRuleSpec });
export const zRuleUpdateInput = z.object({ id: z.string(), spec: zRuleSpec });
export const zSitterBookingInput = z.object({ sitter: z.string(), date: z.iso.date() });
export const zNurseryEventInput = zNurseryEvent.omit({ id: true });
export const zWellbeingIdeaInput = z.object({ text: z.string().min(1) });
export const zDateRangeInput = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) });

export const zAcceptMessageInput = zInboundMessage;
export const zAcceptMessageOutput = z.object({ messageId: z.string(), duplicate: z.boolean() });
export const zJobStartInput = z.object({ id: z.string(), messageId: z.string(), provider: zModelProvider, model: z.string() });
export const zJobFinishInput = zJob.pick({ id: true, intent: true, status: true, inputTokens: true, outputTokens: true, costMicros: true, durationMs: true, toolCalls: true, error: true });
/**
 * QA-8 / QA-10: model usage a job's child workflow (a long step's replan) adds after the job has finished.
 * `source` is the child workflow's ID: one source adds once, however often its step re-runs.
 */
export const zJobUsageInput = zJob.pick({ id: true, inputTokens: true, outputTokens: true, costMicros: true }).extend({ source: z.string() });
/**
 * PLT-10: what a tool hands its long step. One variant per `LongTool`; the job starts a child workflow
 * for each and never waits on it.
 */
export const zLongStep = z.discriminatedUnion("tool", [
  /** AUT-1 / AUT-3: add one shopping request through the sealed helper; `sku` is the answer to the question. */
  z.object({ tool: z.literal(LongTool.shop), requestId: z.string(), sku: z.string().nullable() }),
]);
export type LongStep = z.infer<typeof zLongStep>;
/** PLT-10: what a long step reports back to the job that started it. */
export const zLongStepReport = z.object({ tool: zLongTool, key: z.string(), outcome: z.string(), runId: z.string().nullable() });
export type LongStepReport = z.infer<typeof zLongStepReport>;
export const zDropInput = z.object({ channel: zChannel, address: z.string(), reason: z.string() });
/** CH-3: who was dropped on a channel, newest first, so an adult can find their own ID (never any message text). */
export const zDroppedSendersInput = z.object({ channel: zChannel });
export const zDroppedSender = z.object({ address: z.string(), lastAt: z.iso.datetime({ offset: true }), times: z.number().int() });
export type DroppedSender = z.infer<typeof zDroppedSender>;
/** CH-3: an adult's Telegram user ID, set (or replaced) on the server after setup. */
export const zSetTelegramIdInput = z.object({ person: z.string(), telegram: zTelegramUserId });
export const zSetTelegramIdResult = z.object({ person: z.string(), telegram: z.string(), replaced: z.array(z.string()) });
export const zEnqueueNotificationInput = zNotifyInput.extend({ channel: zDeliveryChannel, status: zNotificationStatus, jobId: z.string().nullable() });
export const zMarkNotificationInput = z.object({ id: z.string(), status: zNotificationStatus, externalId: z.string().optional() });
export const zNotificationsForInput = z.object({ person: z.string().optional(), statuses: z.array(zNotificationStatus) });
export const zReplyInput = z.object({ person: z.string().nullable(), channel: zChannel, text: z.string(), inReplyTo: z.string() });
export const zRepliesForInput = z.object({ person: z.string(), since: z.iso.datetime({ offset: true }).optional() });
/** HOU-159: a person's own app messages since a time (the start of today), each with the house's reply. */
export const zExchangesForInput = z.object({ person: z.string(), since: z.iso.datetime({ offset: true }) });
export const zExchange = z.object({
  id: z.string(),
  text: z.string(),
  redacted: z.boolean(),
  receivedAt: z.iso.datetime({ offset: true }),
  /**
   * True for a one-tap button press (CH-8): a tap, not something said. Read from the attachments or,
   * once they are redacted (PRV-5), from the job's `tap:` intent.
   */
  tap: z.boolean(),
  /** HOU-173: for a tap, which button it was (read the same way as `tap`); null for something said. */
  action: zActionKind.nullable(),
  reply: z.object({ id: z.string(), text: z.string(), createdAt: z.iso.datetime({ offset: true }) }).nullable(),
  /** The message's job, if it has started: how it stands, and what its tools returned. */
  job: zJob.pick({ status: true, toolCalls: true }).nullable(),
});
export const zTimerRunInput = z.object({ timer: zTimerKind, scheduledFor: z.iso.datetime({ offset: true }), missed: z.boolean() });

export const zDateInput = z.object({ date: z.iso.date() });
export const zSavePlanInput = z.object({ date: z.iso.date(), blocks: z.array(zBlock), inputs: z.record(z.string(), z.unknown()), trigger: z.string(), jobId: z.string().nullable() });
/**
 * HOU-173: where "Pencil it in" puts a backlog pick — the day and part of day its slot was found in.
 * It travels as the accept action's value and is kept as the response's, written "2026-11-04 morning".
 */
export const zPencilSlot = z.object({ date: z.iso.date(), dayPart: zDayPart });
export type PencilSlot = z.infer<typeof zPencilSlot>;
export const zRespondInput = z.object({ ref: z.string(), action: zActionKind, channel: zChannel, date: z.iso.date(), value: z.string().nullable() });
export const zHandOverInput = z.object({ ref: z.string(), title: z.string(), to: z.string() });
export const zSaveForecastInput = z.object({ date: z.iso.date(), hours: z.array(zHourlyForecast) });
export const zOfferInput = z.object({ itemId: z.string(), date: z.iso.date(), person: z.string().nullable() });
/**
 * HOME-1 / CH-6: one sync of every calendar the house reads. `calendarIds` are the calendars read now;
 * copies from any other calendar are dropped. `syncTokens` holds each calendar's next sync token.
 */
export const zCalendarSyncInput = z.object({
  upserts: z.array(zCalendarCopy),
  deletedExternalIds: z.array(z.string()),
  syncTokens: z.record(z.string(), z.string()),
  calendarIds: z.array(z.string()).min(1),
  /**
   * Whether the shared calendar was read this time (or the house reads none). Copies from before
   * calendars were recorded all came from it, so they go only then.
   */
  sharedRead: z.boolean(),
});
/** CH-6: record a push channel the house just opened (it is in use until closed). */
export const zRecordWatchInput = zCalendarWatch.omit({ closedAt: true });
export const zCalendarSyncOutput = z.object({ changedDates: z.array(z.iso.date()) });
export const zArrivalInput = zArrival.omit({ id: true, createdAt: true }).extend({ sourceKey: z.string() });

export const zLearningEventInput = zLearningEvent.omit({ id: true });
export const zRhythmInput = zRhythm.omit({ id: true });
export const zSubjectInput = z.object({ subject: z.string() });
export const zAskQuestionInput = zQuestion.omit({ id: true, answer: true });
export const zAnswerQuestionInput = z.object({ id: z.string(), answer: z.string() });
export const zPreferenceInput = z.object({ kind: z.string(), subject: z.string(), value: z.string(), sentence: z.string() });
export const zForgetInput = z.object({ kind: z.string(), subject: z.string() });
export const zScoreRangeInput = z.object({ person: z.string(), from: z.iso.date(), to: z.iso.date() });
export const zWellbeingNudgeInput = z.object({ about: z.string(), to: z.string(), date: z.iso.date() });
export const zMuteInput = z.object({ person: z.string(), until: z.iso.datetime({ offset: true }) });
export const zHealthEntryInput = z.object({ date: z.iso.date(), heavy: z.boolean() });
export const zShoppingRequestInput = z.object({ item: z.string().min(1), sourceMessage: z.string() });
export const zShoppingRequestUpdate = z.object({ id: z.string(), status: zShoppingStatus, chosen: zProductOption.nullable(), options: z.array(zProductOption) });
/** `person` is whose request it ran for, kept on the run for PRV-7 once the request is deleted (HOU-158). */
export const zShoppingRunInput = z.object({ requestId: z.string(), person: z.string(), log: z.array(z.object({ at: z.iso.datetime({ offset: true }), line: z.string() })), screenshots: z.array(z.string()) });
export const zBasketAddInput = z.object({ requestId: z.string(), sku: z.string(), name: z.string() });
export const zSummaryInput = z.object({ person: z.string(), deliveryDate: z.iso.date() });

export const zScreenInput = z.object({ date: z.iso.date().optional() });
export const zEditRhythmInput = z.object({ id: z.string(), everyDays: z.number().int().min(1) });
export const zForgetSentenceInput = z.object({ id: z.string(), kind: z.string() });

/** CAP-6: the lists domain. Names and items are trimmed; an empty one is refused. */
export const zListCreateInput = z.object({ name: z.string().trim().min(1), emoji: z.string().trim().min(1) });
export const zListUpdateInput = z.object({ id: z.string(), name: z.string().trim().min(1).optional(), emoji: z.string().trim().min(1).optional() });
/** `sourceMessage` is the message a job is handling when the house adds it (PRV-1); null when a person types it on the Lists screen. */
export const zListItemAddInput = z.object({ listId: z.string(), text: z.string().trim().min(1), sourceMessage: z.string().nullable() });
export const zListItemCheckInput = z.object({ id: z.string(), checked: z.boolean() });
export const zListItemRenameInput = z.object({ id: z.string(), text: z.string().trim().min(1) });
/** The item as it now stands; on `duplicate` it is the one already on the list, unchanged. */
export const zListWriteResult = z.object({ outcome: zListWriteOutcome, item: zListItem });
export type ListWriteResult = z.infer<typeof zListWriteResult>;
/** A one-off copy of Family Lists (order, ticks and emoji kept). */
export const zListImportInput = z.object({
  lists: z.array(
    z.object({
      name: z.string().trim().min(1),
      emoji: z.string().trim().min(1),
      position: z.number().int(),
      createdAt: z.iso.datetime({ offset: true }),
      items: z.array(z.object({ text: z.string().trim().min(1), checked: z.boolean(), position: z.number().int(), createdAt: z.iso.datetime({ offset: true }) })),
    }),
  ),
});
export type ListImportInput = z.infer<typeof zListImportInput>;
export const zListImportOutput = z.object({ lists: z.number().int(), items: z.number().int() });
