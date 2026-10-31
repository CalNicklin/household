import { describe, expect, it } from "vitest";
import { PracticeCalendar, PracticeMessenger } from "../../practice/fakes.ts";
import { loadEnv } from "../env.ts";
import { GoogleCalendarSource } from "./google-calendar.ts";
import { realPorts } from "./index.ts";
import { HindsightMemory } from "./hindsight-memory.ts";
import { S3ObjectStore } from "./s3-object-store.ts";
import { TelegramTransport } from "./telegram.ts";
import { OpenMeteoWeather } from "./weather-open-meteo.ts";

const clock = { now: () => new Date("2026-11-02T07:00:00Z") };
const options = { timeZone: "Europe/London", personForEmail: () => null };

describe("real ports", () => {
  it("[QA-9] with nothing configured, every credentialed port falls back to the practice household and says so", () => {
    const { ports, missing } = realPorts(loadEnv({}), clock, options);
    expect(ports.calendar).toBeInstanceOf(PracticeCalendar);
    expect(ports.messenger).toBeInstanceOf(PracticeMessenger);
    expect(ports.weather).toBeInstanceOf(OpenMeteoWeather);
    expect(missing).toEqual(expect.arrayContaining(["calendar", "messenger", "objects", "memory", "shopping", "transcriber", "lists"]));
  });

  it("uses the real adapters once their settings are present", () => {
    const env = loadEnv({
      PRACTICE: "false",
      GOOGLE_CALENDAR_ID: "family@group.calendar.google.com",
      GOOGLE_ACCESS_TOKEN_FILE: "/run/secrets/google.json",
      TELEGRAM_BOT_TOKEN: "123:abc",
      HINDSIGHT_URL: "http://hindsight:8888",
      S3_ENDPOINT: "http://minio:9000",
      S3_ACCESS_KEY_ID: "minio",
      S3_SECRET_ACCESS_KEY: "minio-secret",
      // PRV-6: the real house will not start on the practice defaults of these.
      SESSION_SECRET: "test-session",
      STORAGE_KEY: "ab".repeat(32),
      TELEGRAM_WEBHOOK_SECRET: "test-telegram",
      EMAIL_WEBHOOK_SECRET: "test-email",
      CALENDAR_WEBHOOK_TOKEN: "test-calendar",
      MCP_TOKEN: "test-mcp",
      HELPER_TOKEN: "test-helper",
    });
    const { ports, missing } = realPorts(env, clock, options);
    expect(ports.calendar).toBeInstanceOf(GoogleCalendarSource);
    expect(ports.messenger).toBeInstanceOf(TelegramTransport);
    expect(ports.memory).toBeInstanceOf(HindsightMemory);
    expect(ports.objects).toBeInstanceOf(S3ObjectStore);
    expect(missing).not.toContain("calendar");
    expect(missing).toContain("lists");
  });
});
