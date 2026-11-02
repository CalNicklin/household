/**
 * CODE-13/14/15: every limit the system imposes, in one place, each with the reason
 * that justifies it. A limit at a call site must read `Limits.<name>.value` and carry an
 * adjacent `// limit: <name>` comment; the custom oxlint rule rejects anything else.
 */
export const LimitReason = {
  /** OWASP Top 10 for LLM Applications 2025 — LLM10: Unbounded Consumption. */
  OWASP_LLM10: "https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/",
  /** OWASP Top 10 for LLM Applications 2025 — LLM01: Prompt Injection. */
  OWASP_LLM01: "https://genai.owasp.org/llmrisk/llm01-prompt-injection/",
  /** OWASP Top 10 for LLM Applications 2025 — LLM06: Excessive Agency. */
  OWASP_LLM06: "https://genai.owasp.org/llmrisk/llm062025-excessive-agency/",
  /** OWASP API Security Top 10 2023 — API4: Unrestricted Resource Consumption. */
  OWASP_API4: "https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/",
  /** A provider's documented hard limit (link in `note`). */
  PROVIDER_HARD_LIMIT: "provider documentation",
  /** A line in VERIFICATIONS.md (ID in `note`). */
  VERIFICATION: "VERIFICATIONS.md",
} as const;
export type LimitReason = keyof typeof LimitReason;

type Limit = { readonly value: number; readonly reason: LimitReason; readonly note: string };

export const Limits = {
  maxInboundTextChars: { value: 4000, reason: "OWASP_LLM10", note: "An inbound message is a thought, not a document; bounds prompt size per message." },
  agentMaxSteps: { value: 6, reason: "OWASP_LLM06", note: "Bounds how many tool calls one job can make (excessive agency, unbounded consumption)." },
  replyMaxSentences: { value: 3, reason: "VERIFICATION", note: "MOM-9: never more than three sentences unless you ask for more." },
  notNowParkThreshold: { value: 3, reason: "VERIFICATION", note: "CAP-5: \"not now\" three times moves an item to Parked." },
  backlogOffersPerDay: { value: 1, reason: "VERIFICATION", note: "PRO-6: at most one backlog item a day." },
  defaultDailyMessageBudget: { value: 3, reason: "VERIFICATION", note: "PRO-7: three messages a day to start." },
  defaultQuietStartHour: { value: 21, reason: "VERIFICATION", note: "PRO-7: quiet hours 9pm to 7am to start." },
  defaultQuietEndHour: { value: 7, reason: "VERIFICATION", note: "PRO-7: quiet hours 9pm to 7am to start." },
  messageRetentionDays: { value: 30, reason: "VERIFICATION", note: "PRV-5: messages are kept for 30 days." },
  questionsPerDay: { value: 1, reason: "VERIFICATION", note: "LRN-3: at most one question a day for the whole house." },
  wellbeingMessagesPerWeek: { value: 2, reason: "VERIFICATION", note: "WB-5: at most twice a week." },
  wellbeingMuteDays: { value: 30, reason: "VERIFICATION", note: "WB-5: \"not helpful\" stops them for a month." },
  wellbeingHeavyStreak: { value: 3, reason: "VERIFICATION", note: "WB-2: three heavy days in a row." },
  shoppingMaxOptions: { value: 3, reason: "VERIFICATION", note: "AUT-3: two or three options to tap." },
  sitterWarnDays: { value: 7, reason: "VERIFICATION", note: "PRO-1: a warning appears a week before." },
  sitterRemindDays: { value: 5, reason: "VERIFICATION", note: "PRO-1: a reminder five days before." },
  washingDryHours: { value: 3, reason: "VERIFICATION", note: "PRO-4: dry for three hours or more." },
  learningTimingWindowDays: { value: 14, reason: "VERIFICATION", note: "LRN-5: evening ones stop within two weeks." },
  learningTimingMinSamples: { value: 3, reason: "VERIFICATION", note: "LRN-5: dismissals in a day part before it is avoided (the smallest pattern that fits in two weeks)." },
  liveUpdateBudgetMs: { value: 2000, reason: "VERIFICATION", note: "MOM-3 / CH-10: other screens show a change within two seconds." },
  captureBudgetMs: { value: 5000, reason: "VERIFICATION", note: "CAP-1: appears for both of us within five seconds." },
  shoppingBudgetMs: { value: 600_000, reason: "VERIFICATION", note: "AUT-1: within ten minutes it is in our supermarket basket." },
  calendarRefreshMs: { value: 60_000, reason: "VERIFICATION", note: "HOME-1: updates within a minute of a calendar change." },
  inboundEmailMaxBytes: { value: 5 * 1024 * 1024, reason: "OWASP_API4", note: "HOU-150: the mail receiver holds a whole message in memory to check and parse it; order confirmations are well under 1 MB, and four at 5 MB fit its 128 MB cap." },
  inboundEmailMaxClients: { value: 4, reason: "OWASP_API4", note: "HOU-150: SMTP sessions at once. Two people forward a few orders a week; more than four at once is a flood, refused before it can fill the receiver's memory." },
  inboundEmailClientsPerAddress: { value: 2, reason: "OWASP_API4", note: "HOU-150: SMTP sessions at once from one address, so one sender can't hold every seat (Gmail delivers one message per connection)." },
  inboundEmailSessionMs: { value: 600_000, reason: "OWASP_API4", note: "HOU-150: an SMTP session is closed after ten minutes however busy it keeps itself, so NOOPs can't hold a seat for ever." },
  inboundEmailMessagesPerSession: { value: 10, reason: "OWASP_API4", note: "HOU-150: messages in one SMTP session; a forward is one message, so ten is generous and bounds what one connection can make the receiver check." },
  inboundEmailMaxSignatures: { value: 10, reason: "OWASP_API4", note: "HOU-150: DKIM and ARC headers one message may carry before it is dropped unchecked; each costs a DNS lookup and a body hash, and a real forward has about five." },
  inboundEmailCheckMs: { value: 30_000, reason: "OWASP_API4", note: "HOU-150: one message's SPF, DKIM and ARC checks and parse; past this the receiver answers 451 and moves on, so a slow DNS server can't stall the queue." },
  inboundEmailSocketMs: { value: 60_000, reason: "OWASP_API4", note: "HOU-150: an idle SMTP session is closed after a minute (RFC 5321 4.5.3.2 asks a sender to wait minutes, a receiver need not), so slow clients cannot hold the four seats." },
  inboundEmailWebhookMs: { value: 10_000, reason: "OWASP_API4", note: "HOU-150: the receiver waits this long for the app to take an email, then answers 451 so the sending server tries again later." },
  reviewMaxSteps: { value: 30, reason: "OWASP_LLM06", note: "HOU-151: model calls (read-only tool rounds) one review stage may make; the last one has no tools and must answer." },
  reviewMaxOutputTokens: { value: 32_000, reason: "OWASP_LLM10", note: "HOU-151: output (thinking included) per model call in a review stage." },
  reviewMaxStageTokens: { value: 1_000_000, reason: "OWASP_LLM10", note: "HOU-151: tokens (input, cached or not, plus output) one review stage may spend before it must answer; about $4 at Opus 5.5's uncached rate, far less cached." },
  reviewMaxDiffChars: { value: 400_000, reason: "OWASP_LLM10", note: "HOU-151: the reviewed diff (lockfile, evidence and design excluded); a bigger PR fails the review and should be split." },
  reviewMaxReadChars: { value: 40_000, reason: "OWASP_LLM10", note: "HOU-151: what one read-only tool call returns to the reviewer." },
  reviewMaxTextChars: { value: 4000, reason: "OWASP_LLM10", note: "HOU-151: one field of a finding (summary, failure scenario, reason), and so one comment's size." },
  reviewMaxFindings: { value: 10, reason: "OWASP_LLM10", note: "HOU-151: findings one stage may raise per run, which bounds the comments one push can post." },
  reviewStateTextChars: { value: 500, reason: "PROVIDER_HARD_LIMIT", note: "HOU-151: a finding's text as the summary comment's state keeps it (the full text is on its own comment), so the state of every open finding fits GitHub's 65,536-character comment." },
  reviewJobMinutes: { value: 20, reason: "OWASP_LLM10", note: "HOU-151: the review job's timeout-minutes in .github/workflows/agent-review.yml." },
  reviewMaxCommentChars: { value: 65_000, reason: "PROVIDER_HARD_LIMIT", note: "GitHub rejects a comment body over 65,536 characters (https://docs.github.com/en/rest/issues/comments); the summary drops its oldest settled findings to fit." },
} as const satisfies Record<string, Limit>;
export type LimitName = keyof typeof Limits;
