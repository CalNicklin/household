/**
 * Every enumerated value in the system. `as const` objects only (CODE-1):
 * schemas, routers and the UI import these, nothing spells a value twice.
 */
import { z } from "zod";

type ValueOf<T> = T[keyof T];

export const Domain = {
  household: "household",
  calendar: "calendar",
  backlog: "backlog",
  plans: "plans",
  parcels: "parcels",
  learning: "learning",
  wellbeing: "wellbeing",
  jobs: "jobs",
  health: "health",
  shopping: "shopping",
  lists: "lists",
} as const;
export type Domain = ValueOf<typeof Domain>;

export const Channel = {
  app: "app",
  telegram: "telegram",
  email: "email",
  mcp: "mcp",
  timer: "timer",
  webhook: "webhook",
  screen: "screen",
} as const;
export type Channel = ValueOf<typeof Channel>;
export const zChannel = z.enum(Channel);

/** Channels a notification can be delivered to (CH-7 routing table targets). */
export const DeliveryChannel = {
  telegram: Channel.telegram,
  screen: Channel.screen,
} as const;
export type DeliveryChannel = ValueOf<typeof DeliveryChannel>;
export const zDeliveryChannel = z.enum(DeliveryChannel);

/** CH-2: the kinds of Telegram update the Telegram adapter handles; the webhook asks Telegram for only these. */
export const TelegramUpdateType = {
  message: "message",
  callbackQuery: "callback_query",
} as const;
export type TelegramUpdateType = ValueOf<typeof TelegramUpdateType>;

/**
 * How much a notification needs to reach someone now. `urgent` is anything the verifications call a
 * message (bins tonight, a delivery today, a hand-over, a question): the routing table sends it to the
 * messenger by default. Everything else goes to the morning screen (CH-7).
 */
export const Urgency = {
  urgent: "urgent",
  normal: "normal",
  low: "low",
} as const;
export type Urgency = ValueOf<typeof Urgency>;
export const zUrgency = z.enum(Urgency);

export const UrgencyLabel: Record<Urgency, string> = {
  [Urgency.urgent]: "Urgent",
  [Urgency.normal]: "Normal",
  [Urgency.low]: "Low",
};

export const DeliveryChannelLabel: Record<DeliveryChannel, string> = {
  [DeliveryChannel.telegram]: "Message me",
  [DeliveryChannel.screen]: "Morning screen",
};

export const ActionKind = {
  done: "done",
  notToday: "not-today",
  snooze: "snooze",
  accept: "accept",
  handOver: "hand-over",
  notHelpful: "not-helpful",
  answer: "answer",
} as const;
export type ActionKind = ValueOf<typeof ActionKind>;
export const zActionKind = z.enum(ActionKind);

export const ActionLabel: Record<ActionKind, string> = {
  [ActionKind.done]: "Done",
  [ActionKind.notToday]: "Not today",
  [ActionKind.snooze]: "Snooze",
  [ActionKind.accept]: "Pencil it in",
  [ActionKind.handOver]: "Hand over",
  [ActionKind.notHelpful]: "Not helpful",
  [ActionKind.answer]: "Answer",
};

export const BlockType = {
  context: "context",
  mode: "mode",
  event: "event",
  suggestion: "suggestion",
  alert: "alert",
  arrival: "arrival",
  backlogPick: "backlog-pick",
  composer: "composer",
} as const;
export type BlockType = ValueOf<typeof BlockType>;

export const Section = {
  header: "header",
  now: "now",
  later: "later",
  tomorrow: "tomorrow",
  arriving: "arriving",
  fits: "fits",
  focus: "focus",
  footer: "footer",
} as const;
export type Section = ValueOf<typeof Section>;
export const zSection = z.enum(Section);

export const SectionLabel: Record<Section, string> = {
  [Section.header]: "",
  [Section.now]: "Now",
  [Section.later]: "Later today",
  [Section.tomorrow]: "Tomorrow",
  [Section.arriving]: "Arriving",
  [Section.fits]: "Could fit this week",
  [Section.focus]: "",
  [Section.footer]: "",
};

/** Where the server places a section; the client maps placement to a generic slot. */
export const Placement = {
  header: "header",
  main: "main",
  aside: "aside",
  focus: "focus",
  footer: "footer",
} as const;
export type Placement = ValueOf<typeof Placement>;
export const zPlacement = z.enum(Placement);

export const Provenance = {
  calendar: "calendar",
  email: "email",
  rule: "rule",
  planner: "planner",
} as const;
export type Provenance = ValueOf<typeof Provenance>;
export const zProvenance = z.enum(Provenance);

export const ModeKind = {
  normal: "normal",
  slow: "slow",
  sick: "sick",
  away: "away",
} as const;
export type ModeKind = ValueOf<typeof ModeKind>;
export const zModeKind = z.enum(ModeKind);

export const ModeLabel: Record<ModeKind, string> = {
  [ModeKind.normal]: "Normal day",
  [ModeKind.slow]: "Slow day",
  [ModeKind.sick]: "Sick day",
  [ModeKind.away]: "Away",
};

/** CAP-2: the only attributes a backlog item can have. No due date, no priority. */
export const BacklogTag = {
  quick: "quick",
  short: "short",
  halfDay: "half-day",
  daylight: "daylight",
  dry: "dry",
  bothHome: "both-home",
  noKids: "no-kids",
  phoneCall: "phone-call",
  tripOut: "trip-out",
  officeHours: "office-hours",
} as const;
export type BacklogTag = ValueOf<typeof BacklogTag>;
export const zBacklogTag = z.enum(BacklogTag);

export const BacklogTagLabel: Record<BacklogTag, string> = {
  [BacklogTag.quick]: "15 min",
  [BacklogTag.short]: "About an hour",
  [BacklogTag.halfDay]: "Half a day",
  [BacklogTag.daylight]: "Needs daylight",
  [BacklogTag.dry]: "Dry weather",
  [BacklogTag.bothHome]: "Both of us home",
  [BacklogTag.noKids]: "No kids around",
  [BacklogTag.phoneCall]: "Needs a phone call",
  [BacklogTag.tripOut]: "A trip out",
  [BacklogTag.officeHours]: "Weekday 9–5",
};

/** Tags that describe how long a job takes; at most one applies. */
export const DurationTag = {
  quick: BacklogTag.quick,
  short: BacklogTag.short,
  halfDay: BacklogTag.halfDay,
} as const;
export type DurationTag = ValueOf<typeof DurationTag>;

export const DurationMinutes: Record<DurationTag, number> = {
  [DurationTag.quick]: 15,
  [DurationTag.short]: 60,
  [DurationTag.halfDay]: 240,
};

export const BacklogStatus = {
  active: "active",
  parked: "parked",
  done: "done",
} as const;
export type BacklogStatus = ValueOf<typeof BacklogStatus>;
export const zBacklogStatus = z.enum(BacklogStatus);

export const BacklogGroup = {
  soon: "soon",
  waiting: "waiting",
  justAdded: "just-added",
  parked: "parked",
} as const;
export type BacklogGroup = ValueOf<typeof BacklogGroup>;

export const BacklogGroupLabel: Record<BacklogGroup, string> = {
  [BacklogGroup.soon]: "Could go soon",
  [BacklogGroup.waiting]: "Waiting for the right moment",
  [BacklogGroup.justAdded]: "Just added",
  [BacklogGroup.parked]: "Parked",
};

export const PersonRole = {
  adult: "adult",
  child: "child",
} as const;
export type PersonRole = ValueOf<typeof PersonRole>;
export const zPersonRole = z.enum(PersonRole);

export const Weekday = {
  mon: "mon",
  tue: "tue",
  wed: "wed",
  thu: "thu",
  fri: "fri",
  sat: "sat",
  sun: "sun",
} as const;
export type Weekday = ValueOf<typeof Weekday>;
export const zWeekday = z.enum(Weekday);
export const WeekdayOrder: readonly Weekday[] = [
  Weekday.mon,
  Weekday.tue,
  Weekday.wed,
  Weekday.thu,
  Weekday.fri,
  Weekday.sat,
  Weekday.sun,
];
export const WeekdayLabel: Record<Weekday, string> = {
  [Weekday.mon]: "Monday",
  [Weekday.tue]: "Tuesday",
  [Weekday.wed]: "Wednesday",
  [Weekday.thu]: "Thursday",
  [Weekday.fri]: "Friday",
  [Weekday.sat]: "Saturday",
  [Weekday.sun]: "Sunday",
};

export const RuleKind = {
  bins: "bins",
  chore: "chore",
} as const;
export type RuleKind = ValueOf<typeof RuleKind>;
export const zRuleKind = z.enum(RuleKind);

export const NurseryEventKind = {
  termStart: "term-start",
  termEnd: "term-end",
  closure: "closure",
  inset: "inset",
  party: "party",
} as const;
export type NurseryEventKind = ValueOf<typeof NurseryEventKind>;
export const zNurseryEventKind = z.enum(NurseryEventKind);

export const NurseryEventLabel: Record<NurseryEventKind, string> = {
  [NurseryEventKind.termStart]: "Nursery term starts",
  [NurseryEventKind.termEnd]: "Nursery term ends",
  [NurseryEventKind.closure]: "Nursery closed",
  [NurseryEventKind.inset]: "Nursery inset day",
  [NurseryEventKind.party]: "Nursery party",
};

export const ActorKind = {
  person: "person",
  agent: "agent",
  system: "system",
} as const;
export type ActorKind = ValueOf<typeof ActorKind>;

export const JobStatus = {
  pending: "pending",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
} as const;
export type JobStatus = ValueOf<typeof JobStatus>;
export const zJobStatus = z.enum(JobStatus);

export const NotificationStatus = {
  queued: "queued",
  sent: "sent",
  deferred: "deferred",
  onScreen: "on-screen",
  dismissed: "dismissed",
  done: "done",
} as const;
export type NotificationStatus = ValueOf<typeof NotificationStatus>;
export const zNotificationStatus = z.enum(NotificationStatus);

export const TimerKind = {
  morningPlan: "morning-plan",
  hourlyRefresh: "hourly-refresh",
  bins: "bins-7pm",
  weekly: "weekly-report",
  retention: "retention-purge",
  deliveries: "delivery-morning",
  basketSummary: "basket-summary",
} as const;
export type TimerKind = ValueOf<typeof TimerKind>;
export const zTimerKind = z.enum(TimerKind);

export const AttachmentKind = {
  ref: "ref",
  audio: "audio",
  image: "image",
  email: "email",
  calendarChange: "calendar-change",
  timer: "timer",
} as const;
export type AttachmentKind = ValueOf<typeof AttachmentKind>;

export const ShoppingStatus = {
  queued: "queued",
  added: "added",
  needsChoice: "needs-choice",
  failed: "failed",
} as const;
export type ShoppingStatus = ValueOf<typeof ShoppingStatus>;
export const zShoppingStatus = z.enum(ShoppingStatus);

export const HelperKind = {
  shopping: "shopping",
} as const;
export type HelperKind = ValueOf<typeof HelperKind>;

export const LearningEventKind = {
  accept: ActionKind.accept,
  dismiss: ActionKind.notToday,
  snooze: ActionKind.snooze,
  handOver: ActionKind.handOver,
  done: ActionKind.done,
} as const;
export type LearningEventKind = ValueOf<typeof LearningEventKind>;
export const zLearningEventKind = z.enum(LearningEventKind);

export const DayPart = {
  morning: "morning",
  afternoon: "afternoon",
  evening: "evening",
} as const;
export type DayPart = ValueOf<typeof DayPart>;
export const zDayPart = z.enum(DayPart);

export const QuestionTopic = {
  choreRhythm: "chore-rhythm",
  jobLength: "job-length",
  sitterDays: "sitter-days",
} as const;
export type QuestionTopic = ValueOf<typeof QuestionTopic>;
export const zQuestionTopic = z.enum(QuestionTopic);

export const RhythmSource = {
  learned: "learned",
  answered: "answered",
  edited: "edited",
} as const;
export type RhythmSource = ValueOf<typeof RhythmSource>;
export const zRhythmSource = z.enum(RhythmSource);

export const WellbeingFactor = {
  soloKidHours: "solo-kid-hours",
  workEvents: "work-events",
  earlyStarts: "early-starts",
  hardMode: "hard-mode",
  doneCount: "done-count",
  health: "health",
} as const;
export type WellbeingFactor = ValueOf<typeof WellbeingFactor>;
export const zWellbeingFactor = z.enum(WellbeingFactor);

export const WellbeingFactorLabel: Record<WellbeingFactor, string> = {
  [WellbeingFactor.soloKidHours]: "Hours alone with the kids",
  [WellbeingFactor.workEvents]: "Work events",
  [WellbeingFactor.earlyStarts]: "Early starts",
  [WellbeingFactor.hardMode]: "Slow or sick day",
  [WellbeingFactor.doneCount]: "Things that got done",
  [WellbeingFactor.health]: "Health tracking (only if you turned it on)",
};

export const Intent = {
  capture: "capture",
  shopping: "shopping",
  setMode: "set-mode",
  oneThing: "one-thing",
  handOver: "hand-over",
  moveTomorrow: "move-tomorrow",
  respond: "respond",
  sitterBooked: "sitter-booked",
  arrival: "arrival",
  replan: "replan",
  timer: "timer",
  chat: "chat",
  answer: "answer",
} as const;
export type Intent = ValueOf<typeof Intent>;

/**
 * PLT-10: the tools whose work is too long for the agent step. Each declares one long step, which runs
 * in a child workflow of the job that asked, keyed `<job>:<tool>:<key>`.
 */
export const LongTool = {
  shop: "shop",
} as const;
export type LongTool = ValueOf<typeof LongTool>;
export const zLongTool = z.enum(LongTool);

export const ModelProvider = {
  practice: "practice",
  anthropic: "anthropic",
  openai: "openai",
} as const;
export type ModelProvider = ValueOf<typeof ModelProvider>;
export const zModelProvider = z.enum(ModelProvider);

/** CAP-6: how an item got onto a shared list. Only a person's own taps change or remove one (PRV-1). */
export const ListItemSource = {
  /** Typed on the Lists screen. */
  person: "person",
  /** Said or typed to the house; the agent added it on that person's behalf. */
  agent: "agent",
  /** Brought over once from Family Lists. */
  import: "import",
} as const;
export type ListItemSource = ValueOf<typeof ListItemSource>;
export const zListItemSource = z.enum(ListItemSource);

/** CAP-6: what adding or renaming an item did. A list never holds the same item twice (case and surrounding spaces ignored). */
export const ListWriteOutcome = {
  added: "added",
  renamed: "renamed",
  duplicate: "duplicate",
} as const;
export type ListWriteOutcome = ValueOf<typeof ListWriteOutcome>;
export const zListWriteOutcome = z.enum(ListWriteOutcome);
