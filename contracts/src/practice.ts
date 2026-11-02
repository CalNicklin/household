/**
 * HOU-168: the practice household's public values, in one home. They are published on purpose (the
 * practice logins are posted on every PR, FB-5) and nothing behind them is real. Each is spelt from the
 * household's own name, so neither a reader nor a secret scanner takes one for a leaked credential, and
 * PRV-6 refuses every setting below in the real house (server/env.ts).
 */
const PRACTICE = "practice";

export const Practice = {
  /** The app login every practice person shares. */
  login: PRACTICE,
  /** Practice-mode defaults for the settings in server/env.ts's MUST_BE_SET_FOR_REAL. */
  settings: {
    SESSION_SECRET: `${PRACTICE}-only-session-secret-change-me`,
    TELEGRAM_WEBHOOK_SECRET: `${PRACTICE}-telegram-secret`,
    EMAIL_WEBHOOK_SECRET: `${PRACTICE}-email-secret`,
    CALENDAR_WEBHOOK_TOKEN: `${PRACTICE}-calendar-token`,
    MCP_TOKEN: `${PRACTICE}-mcp-token`,
    HELPER_TOKEN: `${PRACTICE}-helper-token`,
    /** 32 bytes of hex counting up: plainly not a key. */
    STORAGE_KEY: "00112233445566778899aabbccddeeff".repeat(2),
  },
} as const;
