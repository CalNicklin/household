import { CalendarOwnerKind, type HouseCalendar, ModelProvider, zModelProvider } from "@household/contracts";
import { z } from "zod";

// The app reads the same POSTGRES_PASSWORD the database container gets from .env, and hands it to
// every Postgres client here (DBOS included) as PGPASSWORD. It never goes inside a URL.
if (process.env["PGPASSWORD"] === undefined && process.env["POSTGRES_PASSWORD"] !== undefined) process.env["PGPASSWORD"] = process.env["POSTGRES_PASSWORD"];

const zEnv = z.object({
  HOUSEHOLD_ID: z.string().default("practice"),
  /** Postgres server; each domain gets its own database on it (CODE-4). */
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/postgres"),
  /** Prefix for every database name, so a practice household never touches ours (QA-9). */
  DB_PREFIX: z.string().default("practice"),
  PORT: z.coerce.number().default(3001),
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  MODEL_PROVIDER: zModelProvider.default(ModelProvider.practice),
  MODEL_ID: z.string().default("practice-1"),
  /** Practice mode wires fake calendar, weather, Telegram and supermarket (QA-9). */
  PRACTICE: z.stringbool().default(true),
  SESSION_SECRET: z.string().default("practice-only-session-secret-change-me"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().default("practice-telegram-secret"),
  TELEGRAM_API_BASE: z.string().default("https://api.telegram.org"),
  EMAIL_WEBHOOK_SECRET: z.string().default("practice-email-secret"),
  CALENDAR_WEBHOOK_TOKEN: z.string().default("practice-calendar-token"),
  /**
   * HOME-1: the calendars the house reads and whose each is, `owner:calendarId` separated by commas,
   * e.g. `cal:cal@gmail.com,chloe:chloe@gmail.com,shared:abc@group.calendar.google.com`. An owner is a
   * person's ID in the household, or `shared`.
   */
  GOOGLE_CALENDARS: z.string().optional(),
  /** Before GOOGLE_CALENDARS: the shared calendar only. Ignored when GOOGLE_CALENDARS is set. */
  GOOGLE_CALENDAR_ID: z.string().optional(),
  GOOGLE_ACCESS_TOKEN_FILE: z.string().optional(),
  /** Google Calendar API v3; only tests point it elsewhere (a stand-in Google). */
  GOOGLE_CALENDAR_API: z.string().default("https://www.googleapis.com/calendar/v3"),
  MCP_TOKEN: z.string().default("practice-mcp-token"),
  HINDSIGHT_URL: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().default("household"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** 32-byte hex key; objects are encrypted before they leave the process (PLT-7). */
  STORAGE_KEY: z.string().default("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"),
  OBJECT_DIR: z.string().default(".data/objects"),
  HELPER_URL: z.string().optional(),
  HELPER_TOKEN: z.string().default("practice-helper-token"),
  WEB_DIST: z.string().default("web/dist/client"),
});
export type Env = z.infer<typeof zEnv>;

/**
 * Settings whose practice defaults are public (they are in this file). PRV-6: the real house must set
 * every one of them; with any left at its practice value the server refuses to start.
 */
const MUST_BE_SET_FOR_REAL = ["SESSION_SECRET", "STORAGE_KEY", "TELEGRAM_WEBHOOK_SECRET", "EMAIL_WEBHOOK_SECRET", "CALENDAR_WEBHOOK_TOKEN", "MCP_TOKEN", "HELPER_TOKEN"] as const;

/**
 * HOME-1: the Google calendars the house reads, each with its owner: GOOGLE_CALENDARS, or else
 * GOOGLE_CALENDAR_ID as the shared calendar alone (the setup before personal calendars), or none.
 */
export function houseCalendars(env: Pick<Env, "GOOGLE_CALENDARS" | "GOOGLE_CALENDAR_ID">): HouseCalendar[] {
  if (env.GOOGLE_CALENDARS === undefined) return env.GOOGLE_CALENDAR_ID === undefined ? [] : [{ calendarId: env.GOOGLE_CALENDAR_ID, owner: CalendarOwnerKind.shared }];
  const out: HouseCalendar[] = [];
  for (const raw of env.GOOGLE_CALENDARS.split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const colon = entry.indexOf(":");
    const owner = entry.slice(0, colon).trim().toLowerCase();
    const calendarId = entry.slice(colon + 1).trim();
    if (colon < 1 || !/^[a-z0-9_-]+$/.test(owner) || calendarId === "") throw new Error(`HOME-1: GOOGLE_CALENDARS entry "${entry}" is not owner:calendarId (e.g. chloe:chloe@gmail.com)`);
    if (out.some((c) => c.calendarId === calendarId)) throw new Error(`HOME-1: GOOGLE_CALENDARS lists ${calendarId} twice; each calendar has one owner`);
    out.push({ calendarId, owner });
  }
  if (out.length === 0) throw new Error("HOME-1: GOOGLE_CALENDARS is set but names no calendar");
  return out;
}

/** HOME-1: calendar owners in GOOGLE_CALENDARS that are neither `shared` nor one of these people (a typo). */
export function unknownCalendarOwners(calendars: readonly HouseCalendar[], personIds: readonly string[]): string[] {
  return calendars.map((c) => c.owner).filter((o) => o !== CalendarOwnerKind.shared && !personIds.includes(o));
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // A setting written as `NAME=` is unset, not an empty URL or token (compose's HELPER_URL: "" says "no helper").
  const env = zEnv.parse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== "")));
  houseCalendars(env);
  if (env.PRACTICE) return env;
  const practice = zEnv.parse({});
  const unset = MUST_BE_SET_FOR_REAL.filter((name) => env[name] === practice[name]);
  if (unset.length > 0) throw new Error(`PRV-6: the real house needs its own ${unset.join(", ")} (set them in .env; \`pnpm env:init\` generates them)`);
  return env;
}
