/** Router inputs (CODE-5). Outputs are the records in domain.ts and blocks.ts. */
import { z } from "zod";
import { zBlock } from "./blocks.ts";
import { zArrival, zCalendarEvent, zJob, zLearningEvent, zNurseryEvent, zPersonSettings, zProductOption, zQuestion, zRhythm, zRuleSpec } from "./domain.ts";
import { LongTool, zActionKind, zBacklogTag, zChannel, zDeliveryChannel, zLongTool, zModeKind, zModelProvider, zNotificationStatus, zShoppingStatus, zTimerKind } from "./enums.ts";
import { zInboundMessage, zNotifyInput } from "./message.ts";

export const zIdInput = z.object({ id: z.string() });
export const zPersonInput = z.object({ person: z.string() });
export const zBacklogCreateInput = z.object({ text: z.string().min(1), tags: z.array(zBacklogTag), createdVia: zChannel, sourceMessage: z.string() });
export const zBacklogSetTagsInput = z.object({ id: z.string(), tags: z.array(zBacklogTag) });
export const zPersonExport = z.record(z.string(), z.unknown());

export const zResolveIdentityInput = z.object({ channel: zChannel, address: z.string() });
export const zLoginInput = z.object({ username: z.string(), password: z.string() });
export const zSetModeRequest = z.object({ mode: zModeKind, endsAt: z.iso.datetime({ offset: true }) });
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
/** QA-8 / QA-10: model usage a job's child workflow (a long step's replan) adds after the job has finished. */
export const zJobUsageInput = zJob.pick({ id: true, inputTokens: true, outputTokens: true, costMicros: true });
/**
 * PLT-10: what a tool hands its long step. One variant per `LongTool`; the job starts a child workflow
 * for each and never waits on it.
 */
const zLongStep = z.discriminatedUnion("tool", [
  /** AUT-1 / AUT-3: add one shopping request through the sealed helper; `sku` is the answer to the question. */
  z.object({ tool: z.literal(LongTool.shop), requestId: z.string(), sku: z.string().nullable() }),
]);
export type LongStep = z.infer<typeof zLongStep>;
/** PLT-10: what a long step reports back to the job that started it. */
const zLongStepReport = z.object({ tool: zLongTool, key: z.string(), outcome: z.string(), runId: z.string().nullable() });
export type LongStepReport = z.infer<typeof zLongStepReport>;
export const zDropInput = z.object({ channel: zChannel, address: z.string(), reason: z.string() });
export const zEnqueueNotificationInput = zNotifyInput.extend({ channel: zDeliveryChannel, status: zNotificationStatus, jobId: z.string().nullable() });
export const zMarkNotificationInput = z.object({ id: z.string(), status: zNotificationStatus, externalId: z.string().optional() });
export const zNotificationsForInput = z.object({ person: z.string().optional(), statuses: z.array(zNotificationStatus) });
export const zReplyInput = z.object({ person: z.string().nullable(), channel: zChannel, text: z.string(), inReplyTo: z.string() });
export const zRepliesForInput = z.object({ person: z.string(), since: z.iso.datetime({ offset: true }).optional() });
export const zTimerRunInput = z.object({ timer: zTimerKind, scheduledFor: z.iso.datetime({ offset: true }), missed: z.boolean() });

export const zDateInput = z.object({ date: z.iso.date() });
export const zSavePlanInput = z.object({ date: z.iso.date(), blocks: z.array(zBlock), inputs: z.record(z.string(), z.unknown()), trigger: z.string(), jobId: z.string().nullable() });
export const zRespondInput = z.object({ ref: z.string(), action: zActionKind, channel: zChannel, date: z.iso.date(), value: z.string().nullable() });
export const zHandOverInput = z.object({ ref: z.string(), title: z.string(), to: z.string() });
export const zOfferInput = z.object({ itemId: z.string(), date: z.iso.date(), person: z.string().nullable() });
export const zExternalEvent = zCalendarEvent.omit({ id: true });
export const zCalendarSyncInput = z.object({ upserts: z.array(zExternalEvent), deletedExternalIds: z.array(z.string()), syncToken: z.string().nullable() });
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
export const zShoppingRunInput = z.object({ requestId: z.string(), log: z.array(z.object({ at: z.iso.datetime({ offset: true }), line: z.string() })), screenshots: z.array(z.string()) });
export const zBasketAddInput = z.object({ requestId: z.string(), sku: z.string(), name: z.string() });
export const zSummaryInput = z.object({ person: z.string(), deliveryDate: z.iso.date() });

export const zScreenInput = z.object({ date: z.iso.date().optional() });
export const zEditRhythmInput = z.object({ id: z.string(), everyDays: z.number().int().min(1) });
export const zForgetSentenceInput = z.object({ id: z.string(), kind: z.string() });
