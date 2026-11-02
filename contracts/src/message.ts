import { z } from "zod";
import { AttachmentKind, zActionKind, zChannel, zDeliveryChannel, zModeKind, zNotificationStatus, zTimerKind, zUrgency } from "./enums.ts";
import { Limits } from "./limits.ts";

export const zIsoDateTime = z.iso.datetime({ offset: true });
export const zLocalDate = z.iso.date();
export type LocalDate = z.infer<typeof zLocalDate>;

export const zRefAttachment = z.object({
  kind: z.literal(AttachmentKind.ref),
  /** A block, backlog item or notification the message is about (MOM-7, CH-8). */
  ref: z.string(),
  /** Set when the message is a one-tap button press. */
  action: zActionKind.optional(),
  /** For answers to a one-tap question. */
  value: z.string().optional(),
});

export const zAudioAttachment = z.object({
  kind: z.literal(AttachmentKind.audio),
  /** Object-storage key of the recording. */
  key: z.string(),
  /** Transcript produced at the edge, so talking works the same as typing (MOM-8). */
  transcript: z.string(),
});

export const zImageAttachment = z.object({
  kind: z.literal(AttachmentKind.image),
  key: z.string(),
});

/** PRV-3: only the facts of an order confirmation cross the edge, never the email. */
export const zEmailAttachment = z.object({
  kind: z.literal(AttachmentKind.email),
  orderLike: z.boolean(),
});

/**
 * What the email webhook takes (CH-2, CAP-9): from the house's own mail receiver (HOU-150), or an
 * inbound-mail service posting JSON. `provenSenders` is set only by the receiver: the addresses it
 * proved sent the email on (SPF or DKIM aligned with their domain). When it is present, the person is
 * found among those and nothing else; From and To are then just what the email says.
 */
export const zInboundEmail = z.object({
  from: z.string(),
  to: z.union([z.string(), z.array(z.string())]),
  subject: z.string().default(""),
  text: z.string().default(""),
  messageId: z.string().min(1),
  provenSenders: z.array(z.string()).min(1).optional(),
});
export type InboundEmail = z.input<typeof zInboundEmail>;

export const zCalendarChangeAttachment = z.object({
  kind: z.literal(AttachmentKind.calendarChange),
  resourceState: z.string(),
});

export const zTimerAttachment = z.object({
  kind: z.literal(AttachmentKind.timer),
  timer: zTimerKind,
  scheduledFor: zIsoDateTime,
});

export const zAttachment = z.discriminatedUnion("kind", [
  zRefAttachment,
  zAudioAttachment,
  zImageAttachment,
  zEmailAttachment,
  zCalendarChangeAttachment,
  zTimerAttachment,
]);
export type Attachment = z.infer<typeof zAttachment>;

/**
 * CH-1: the one shape for an incoming message. Every adapter produces exactly this.
 * `person` is resolved at the edge (CH-3); `null` only for machine channels (timer, webhook).
 */
export const zInboundMessage = z.strictObject({
  household: z.string(),
  person: z.string().nullable(),
  channel: zChannel,
  // limit: maxInboundTextChars
  text: z.string().max(Limits.maxInboundTextChars.value),
  attachments: z.array(zAttachment),
  dedupeKey: z.string().min(1),
  receivedAt: zIsoDateTime,
});
export type InboundMessage = z.infer<typeof zInboundMessage>;

export const zNotifyAction = z.object({
  kind: zActionKind,
  label: z.string(),
  ref: z.string(),
  value: z.string().optional(),
});
export type NotifyAction = z.infer<typeof zNotifyAction>;

/** CH-7: notify(person, message, urgency, actions). */
export const zNotifyInput = z.object({
  person: z.string(),
  message: z.string(),
  urgency: zUrgency,
  actions: z.array(zNotifyAction),
  /** Stable key: the same nudge is never sent twice (PRO-9). */
  key: z.string(),
  /** Counts towards the person's daily budget (PRO-7, WB-5). Replies to a person do not. */
  countsTowardsBudget: z.boolean(),
});
export type NotifyInput = z.infer<typeof zNotifyInput>;

export const zNotification = z.object({
  id: z.string(),
  key: z.string(),
  person: z.string(),
  message: z.string(),
  urgency: zUrgency,
  channel: zDeliveryChannel,
  actions: z.array(zNotifyAction),
  status: zNotificationStatus,
  createdAt: zIsoDateTime,
  sentAt: zIsoDateTime.nullable(),
});
export type Notification = z.infer<typeof zNotification>;

export const zReply = z.object({
  id: z.string(),
  person: z.string().nullable(),
  channel: zChannel,
  text: z.string(),
  inReplyTo: z.string(),
  createdAt: zIsoDateTime,
});
export type Reply = z.infer<typeof zReply>;

export const zTimerFire = z.object({ timer: zTimerKind, scheduledFor: zIsoDateTime });
export type TimerFire = z.infer<typeof zTimerFire>;

export const zSetModeInput = z.object({ mode: zModeKind, until: zIsoDateTime.optional() });


/**
 * CH-8: one-tap buttons on a messenger carry `n:<notification id>:<action index>` (Telegram allows
 * 64 bytes); the adapter turns a tap back into a normal message with that action's ref.
 */
export function buttonData(notificationId: string, index: number): string {
  return `n:${notificationId}:${index}`;
}

export function parseButtonData(data: string): { notificationId: string; index: number } | null {
  const m = /^n:([0-9a-f-]{36}):(\d+)$/.exec(data);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  return { notificationId: m[1], index: Number(m[2]) };
}
