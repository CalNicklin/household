/**
 * Records each domain exposes through its tRPC router (CODE-5). Routers take their
 * input and output types from here; the UI reads the same shapes.
 */
import { z } from "zod";
import {
  zActionKind,
  zBacklogStatus,
  zBacklogTag,
  zChannel,
  zDayPart,
  zDeliveryChannel,
  zJobStatus,
  zLearningEventKind,
  zListItemSource,
  zModeKind,
  zModelProvider,
  zNurseryEventKind,
  zPersonRole,
  zQuestionTopic,
  zRhythmSource,
  zRuleKind,
  zShoppingStatus,
  zTimerKind,
  zUrgency,
  zWeekday,
  zWellbeingFactor,
} from "./enums.ts";
import { zIsoDateTime, zLocalDate } from "./message.ts";

// ── household ────────────────────────────────────────────────────────────────

/** PRV-4: a child is a first name and nursery days, nothing else. */
export const zPerson = z.object({
  id: z.string(),
  name: z.string(),
  role: zPersonRole,
  nurseryDays: z.array(zWeekday),
});
export type Person = z.infer<typeof zPerson>;

export const zSitter = z.object({ id: z.string(), name: z.string(), knownFreeDays: z.array(zWeekday) });
export type Sitter = z.infer<typeof zSitter>;

export const zRouting = z.record(zUrgency, zDeliveryChannel);
export type Routing = z.infer<typeof zRouting>;

export const zPersonSettings = z.object({
  person: z.string(),
  dailyMessageBudget: z.number().int().min(0),
  quietStartHour: z.number().int().min(0).max(23),
  quietEndHour: z.number().int().min(0).max(23),
  routing: zRouting,
  wellbeingEnabled: z.boolean(),
  healthInScore: z.boolean(),
});
export type PersonSettings = z.infer<typeof zPersonSettings>;

export const zHouseholdSettings = z.object({
  household: z.string(),
  name: z.string(),
  timezone: z.string(),
  retainMessages: z.boolean(),
  latitude: z.number(),
  longitude: z.number(),
  healthOwner: z.string().nullable(),
});
export type HouseholdSettings = z.infer<typeof zHouseholdSettings>;

export const zMode = z.object({
  id: z.string(),
  mode: zModeKind,
  setBy: z.string(),
  setAt: zIsoDateTime,
  /** MOM-4: ends at midnight unless extended. */
  endsAt: zIsoDateTime,
});
export type Mode = z.infer<typeof zMode>;

export const zBinsRule = z.object({
  kind: z.literal("bins"),
  collectionDay: zWeekday,
  /** Bins alternate by ISO week parity: `even` weeks and `odd` weeks. */
  evenWeeks: z.array(z.string()),
  oddWeeks: z.array(z.string()),
});
export const zChoreRule = z.object({
  kind: z.literal("chore"),
  title: z.string(),
  everyDays: z.number().int().min(1),
  anchorDate: zLocalDate,
});
export const zRuleSpec = z.discriminatedUnion("kind", [zBinsRule, zChoreRule]);
export type RuleSpec = z.infer<typeof zRuleSpec>;

export const zRule = z.object({
  id: z.string(),
  kind: zRuleKind,
  spec: zRuleSpec,
  createdBy: z.string(),
  createdAt: zIsoDateTime,
});
export type Rule = z.infer<typeof zRule>;

export const zNurseryTerm = z.object({ id: z.string(), start: zLocalDate, end: zLocalDate });
export type NurseryTerm = z.infer<typeof zNurseryTerm>;

export const zNurseryEvent = z.object({
  id: z.string(),
  kind: zNurseryEventKind,
  date: zLocalDate,
  title: z.string(),
  /** Who is covering childcare that day, if anyone. */
  coveredBy: z.string().nullable(),
});
export type NurseryEvent = z.infer<typeof zNurseryEvent>;

export const zSitterBooking = z.object({ id: z.string(), sitter: z.string(), date: zLocalDate, recordedBy: z.string() });
export type SitterBooking = z.infer<typeof zSitterBooking>;

export const zWellbeingIdea = z.object({ id: z.string(), text: z.string(), createdBy: z.string() });
export type WellbeingIdea = z.infer<typeof zWellbeingIdea>;

// ── calendar ─────────────────────────────────────────────────────────────────

export const zCalendarEvent = z.object({
  id: z.string(),
  externalId: z.string(),
  title: z.string(),
  start: zIsoDateTime,
  end: zIsoDateTime,
  allDay: z.boolean(),
  /** Household people attending. */
  attendees: z.array(z.string()),
  /** People this event takes out of the house. */
  away: z.array(z.string()),
  /** Work commitment (for WB-1). */
  work: z.boolean(),
  /** Someone has the kids alone during this event (for WB-1). */
  soloWithKids: z.string().nullable(),
});
export type CalendarEvent = z.infer<typeof zCalendarEvent>;

// ── backlog ──────────────────────────────────────────────────────────────────

export const zBacklogItem = z.object({
  id: z.string(),
  text: z.string(),
  tags: z.array(zBacklogTag),
  /** Tags a person confirmed or corrected; the rest are the app's guesses (CAP-3). */
  confirmedTags: z.boolean(),
  status: zBacklogStatus,
  notNowCount: z.number().int(),
  createdBy: z.string(),
  createdVia: zChannel,
  createdAt: zIsoDateTime,
});
export type BacklogItem = z.infer<typeof zBacklogItem>;

export const zBacklogView = z.object({
  soon: z.array(z.object({ item: zBacklogItem, slot: z.string() })),
  waiting: z.array(z.object({ item: zBacklogItem, waitingFor: z.string() })),
  justAdded: z.array(zBacklogItem),
  parked: z.array(zBacklogItem),
});
export type BacklogView = z.infer<typeof zBacklogView>;

// ── plans ────────────────────────────────────────────────────────────────────

export const zResponse = z.object({
  id: z.string(),
  ref: z.string(),
  action: zActionKind,
  person: z.string(),
  channel: zChannel,
  date: zLocalDate,
  value: z.string().nullable(),
  at: zIsoDateTime,
});
export type Response = z.infer<typeof zResponse>;

export const zHandOver = z.object({ id: z.string(), ref: z.string(), from: z.string(), to: z.string(), title: z.string(), at: zIsoDateTime });
export type HandOver = z.infer<typeof zHandOver>;

export const zOffer = z.object({ id: z.string(), itemId: z.string(), date: zLocalDate, person: z.string().nullable() });
export type Offer = z.infer<typeof zOffer>;

// ── parcels ──────────────────────────────────────────────────────────────────

/** PRV-3: the shop and the date, never the email. */
export const zArrival = z.object({
  id: z.string(),
  shop: z.string(),
  expectedDate: zLocalDate,
  window: z.string().nullable(),
  needsSomeoneIn: z.boolean(),
  person: z.string().nullable(),
  createdAt: zIsoDateTime,
});
export type Arrival = z.infer<typeof zArrival>;

// ── learning ─────────────────────────────────────────────────────────────────

/** LRN-1: every response with its context. */
export const zLearningEvent = z.object({
  id: z.string(),
  kind: zLearningEventKind,
  subject: z.string(),
  ref: z.string(),
  person: z.string(),
  date: zLocalDate,
  dayPart: zDayPart,
  weekday: zWeekday,
  hour: z.number().int(),
  weather: z.string(),
  dayMode: zModeKind,
  at: zIsoDateTime,
});
export type LearningEvent = z.infer<typeof zLearningEvent>;

export const zRhythm = z.object({
  id: z.string(),
  subject: z.string(),
  everyDays: z.number().int().min(1),
  usualWeekday: zWeekday.nullable(),
  source: zRhythmSource,
});
export type Rhythm = z.infer<typeof zRhythm>;

export const zQuestion = z.object({
  id: z.string(),
  topic: zQuestionTopic,
  subject: z.string(),
  text: z.string(),
  options: z.array(z.object({ label: z.string(), value: z.string() })),
  askedOn: zLocalDate,
  answer: z.string().nullable(),
});
export type Question = z.infer<typeof zQuestion>;

export const zLearnedSentence = z.object({ id: z.string(), kind: z.string(), text: z.string() });
export type LearnedSentence = z.infer<typeof zLearnedSentence>;

// ── wellbeing ────────────────────────────────────────────────────────────────

export const zWellbeingScore = z.object({
  person: z.string(),
  date: zLocalDate,
  score: z.number(),
  heavy: z.boolean(),
  freeHours: z.number(),
  factors: z.array(z.object({ factor: zWellbeingFactor, value: z.number(), points: z.number() })),
});
export type WellbeingScore = z.infer<typeof zWellbeingScore>;

// ── health (PRV-2, stored separately) ────────────────────────────────────────

export const zHealthEntry = z.object({ id: z.string(), date: zLocalDate, heavy: z.boolean(), createdAt: zIsoDateTime });
export type HealthEntry = z.infer<typeof zHealthEntry>;

// ── shopping ─────────────────────────────────────────────────────────────────

export const zProductOption = z.object({ sku: z.string(), name: z.string(), price: z.string() });
export type ProductOption = z.infer<typeof zProductOption>;

export const zShoppingRequest = z.object({
  id: z.string(),
  item: z.string(),
  person: z.string(),
  status: zShoppingStatus,
  chosen: zProductOption.nullable(),
  options: z.array(zProductOption),
  runId: z.string().nullable(),
  createdAt: zIsoDateTime,
});
export type ShoppingRequest = z.infer<typeof zShoppingRequest>;

export const zShoppingRun = z.object({
  id: z.string(),
  requestId: z.string(),
  log: z.array(z.object({ at: zIsoDateTime, line: z.string() })),
  screenshots: z.array(z.string()),
  createdAt: zIsoDateTime,
});
export type ShoppingRun = z.infer<typeof zShoppingRun>;

// ── jobs ─────────────────────────────────────────────────────────────────────

export const zToolCallRecord = z.object({ tool: z.string(), input: z.unknown(), output: z.unknown() });

export const zJob = z.object({
  id: z.string(),
  messageId: z.string(),
  channel: zChannel,
  person: z.string().nullable(),
  intent: z.string(),
  status: zJobStatus,
  provider: zModelProvider,
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costMicros: z.number().int(),
  durationMs: z.number().int(),
  toolCalls: z.array(zToolCallRecord),
  error: z.string().nullable(),
  createdAt: zIsoDateTime,
});
export type Job = z.infer<typeof zJob>;

export const zJobTrace = z.object({
  job: zJob,
  steps: z.array(z.object({ name: z.string(), startedAt: zIsoDateTime.nullable(), completedAt: zIsoDateTime.nullable(), error: z.string().nullable(), childWorkflowId: z.string().nullable() })),
});
export type JobTrace = z.infer<typeof zJobTrace>;

export const zTimerRun = z.object({
  id: z.string(),
  timer: zTimerKind,
  scheduledFor: zIsoDateTime,
  firedAt: zIsoDateTime.nullable(),
  missed: z.boolean(),
});
export type TimerRun = z.infer<typeof zTimerRun>;

export const zSpendMonth = z.object({ month: z.string(), costMicros: z.number().int(), jobs: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int() });
export type SpendMonth = z.infer<typeof zSpendMonth>;

export const zWeeklyReport = z.object({
  weekStart: zLocalDate,
  suggested: z.number().int(),
  accepted: z.number().int(),
  dismissed: z.number().int(),
  costMicros: z.number().int(),
});
export type WeeklyReport = z.infer<typeof zWeeklyReport>;

// ── lists ────────────────────────────────────────────────────────────────────

/** CAP-6: one item on a shared list. Ticked items stay on the list, struck through. */
export const zListItem = z.object({
  id: z.string(),
  listId: z.string(),
  text: z.string(),
  checked: z.boolean(),
  position: z.number().int(),
  /** The person who wrote it, or who said it to the house; null when it came over from Family Lists. */
  createdBy: z.string().nullable(),
  source: zListItemSource,
  createdAt: zIsoDateTime,
});
export type ListItem = z.infer<typeof zListItem>;

/** CAP-6: a shared list (shopping, presents, a packing list), with its items in order. */
export const zList = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string(),
  position: z.number().int(),
  createdAt: zIsoDateTime,
  items: z.array(zListItem),
});
export type List = z.infer<typeof zList>;

/** CH-3: a Telegram user's numeric ID, as the house matches senders by it. */
export const zTelegramUserId = z.string().regex(/^[1-9]\d{0,15}$/, "a Telegram user ID is digits only, e.g. 123456789");

/**
 * PLT-8: the real house, described once on the server (`pnpm house:setup < house.json`). It holds no
 * secret: each adult's app password is generated on the server and printed once.
 */
export const zHouseSetup = z.object({
  name: z.string().min(1),
  timezone: z.string().min(1),
  latitude: z.number(),
  longitude: z.number(),
  adults: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), name: z.string().min(1), email: z.email().optional(), telegram: zTelegramUserId.optional() })).min(1),
  children: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), name: z.string().min(1), nurseryDays: z.array(zWeekday) })).default([]),
  /** PRV-2: the one adult whose health tracking may exist at all (her own yes); omitted, nobody's does. */
  healthOwner: z.string().optional(),
}).refine((h) => h.healthOwner === undefined || h.adults.some((a) => a.id === h.healthOwner), { message: "healthOwner must be one of the adults", path: ["healthOwner"] });
export type HouseSetup = z.infer<typeof zHouseSetup>;
