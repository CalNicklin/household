/**
 * The query layer the app reads (PLT-11). Every screen is one of these views; none needs the
 * agent to compute it, and the home screen is a list of typed blocks (HOME-7).
 */
import { z } from "zod";
import { zBlock } from "./blocks.ts";
import {
  zArrival,
  zBacklogItem,
  zHouseholdSettings,
  zJob,
  zJobTrace,
  zLearnedSentence,
  zList,
  zPersonSettings,
  zProductOption,
  zQuestion,
  zRule,
  zShoppingRequest,
  zSpendMonth,
  zTimerRun,
  zWellbeingIdea,
  zWellbeingScore,
} from "./domain.ts";
import { zIsoDateTime, zLocalDate } from "./message.ts";

export const zMe = z.object({ person: z.string(), name: z.string(), healthOwner: z.boolean() });
export type Me = z.infer<typeof zMe>;

export const zScreenView = z.object({
  date: zLocalDate,
  version: z.number().int(),
  generatedAt: zIsoDateTime,
  blocks: z.array(zBlock),
});
export type ScreenView = z.infer<typeof zScreenView>;

export const zBacklogScreen = z.object({
  count: z.number().int(),
  soon: z.array(z.object({ item: zBacklogItem, slot: z.string() })),
  waiting: z.array(z.object({ item: zBacklogItem, waitingFor: z.string() })),
  justAdded: z.array(z.object({ item: zBacklogItem, byline: z.string() })),
  parked: z.array(zBacklogItem),
});
export type BacklogScreen = z.infer<typeof zBacklogScreen>;

/** HOU-153: `today` says which day is today, so the screen labels "Now" only there. */
export const zWeekDay = z.object({ date: zLocalDate, label: z.string(), today: z.boolean(), blocks: z.array(zBlock) });
export const zWeekView = z.object({ days: z.array(zWeekDay) });
export type WeekView = z.infer<typeof zWeekView>;

export const zShopView = z.object({
  basket: z.array(z.object({ sku: z.string(), name: z.string(), quantity: z.number().int() })),
  deliveryDate: zLocalDate.nullable(),
  changeUrl: z.string(),
  requests: z.array(zShoppingRequest),
});
export type ShopView = z.infer<typeof zShopView>;

/** CAP-6: every shared list, in order, with its items in order. */
export const zListsView = z.array(zList);
export type ListsView = z.infer<typeof zListsView>;

export const zSettingsView = z.object({
  me: zPersonSettings,
  household: zHouseholdSettings,
  learned: z.array(zLearnedSentence),
  questions: z.array(zQuestion),
  wellbeing: z.object({ enabled: z.boolean(), recent: z.array(zWellbeingScore) }),
  ideas: z.array(zWellbeingIdea),
  rules: z.array(zRule),
});
export type SettingsView = z.infer<typeof zSettingsView>;

export const zRunView = z.object({
  id: z.string(),
  item: z.string(),
  status: z.string(),
  chosen: zProductOption.nullable(),
  log: z.array(z.object({ at: zIsoDateTime, line: z.string() })),
  screenshots: z.array(z.object({ name: z.string(), url: z.string() })),
});
export type RunView = z.infer<typeof zRunView>;

export const zRunLogView = z.object({ jobs: z.array(zJob), timers: z.array(zTimerRun) });
export type RunLogView = z.infer<typeof zRunLogView>;

export const zTraceView = zJobTrace;
export const zSpendView = z.object({ months: z.array(zSpendMonth) });
export type SpendView = z.infer<typeof zSpendView>;

export const zArrivalsView = z.array(zArrival);

/** MOM-2: the one thing a `what_now` answer named, so the screen can show it as the thing plus its reason. */
export const zAnswerPick = z.object({ title: z.string(), why: z.string() });
export type AnswerPick = z.infer<typeof zAnswerPick>;

export const zConversationView = z.array(z.object({ id: z.string(), text: z.string(), createdAt: zIsoDateTime, pick: zAnswerPick.nullable() }));
export type ConversationView = z.infer<typeof zConversationView>;

/** What the app posts to say something to the house (same ingress as WhatsApp, CH-1). */
export const zAppMessageInput = z.object({
  text: z.string(),
  /** A block or item the person tapped before speaking (MOM-7), or a one-tap button press (CH-8). */
  ref: z.string().optional(),
  action: z.string().optional(),
  value: z.string().optional(),
  /** Set when the text came from speech (MOM-8). */
  spoken: z.boolean().optional(),
  /** Client-generated id: a retried POST is the same message (CH-4). */
  clientId: z.string(),
});
export type AppMessageInput = z.infer<typeof zAppMessageInput>;
export const zAppMessageOutput = z.object({ messageId: z.string(), jobId: z.string(), duplicate: z.boolean() });

/** Server-sent change events (`GET /api/live`). The client refetches the views that topic touches. */
export const LiveTopic = {
  plan: "plan",
  backlog: "backlog",
  arrivals: "arrivals",
  notifications: "notifications",
  replies: "replies",
  mode: "mode",
  shopping: "shopping",
  lists: "lists",
  learning: "learning",
  settings: "settings",
} as const;
export type LiveTopic = (typeof LiveTopic)[keyof typeof LiveTopic];
