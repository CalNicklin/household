import { ModelProvider, zModelProvider } from "@household/contracts";
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
  GOOGLE_CALENDAR_ID: z.string().optional(),
  GOOGLE_ACCESS_TOKEN_FILE: z.string().optional(),
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

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const env = zEnv.parse(source);
  if (env.PRACTICE) return env;
  const practice = zEnv.parse({});
  const unset = MUST_BE_SET_FOR_REAL.filter((name) => env[name] === practice[name]);
  if (unset.length > 0) throw new Error(`PRV-6: the real house needs its own ${unset.join(", ")} (set them in .env; \`pnpm env:init\` generates them)`);
  return env;
}
