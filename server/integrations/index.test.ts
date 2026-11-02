import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PracticeCalendar, PracticeMessenger } from "../../practice/fakes.ts";
import { loadEnv } from "../env.ts";
import { fakeServer, json } from "./fake-http.ts";
import { GoogleCalendarPush, GoogleCalendarSource } from "./google-calendar.ts";
import { googleTokenFromFile, realPorts } from "./index.ts";
import { HindsightMemory } from "./hindsight-memory.ts";
import { S3ObjectStore } from "./s3-object-store.ts";
import { NoShoppingHelper } from "./shopping-helper.ts";
import { TelegramTransport } from "./telegram.ts";
import { OpenMeteoWeather } from "./weather-open-meteo.ts";

/** HOU-168: every credential here is made up per run, so no literal one is in the repo. */
const made = () => randomBytes(12).toString("base64url");
const ACCESS = made();

const clock = { now: () => new Date("2026-11-02T07:00:00Z") };
const options = { timeZone: "Europe/London", personForEmail: () => null };
// HOU-160: the real house always runs on a real model, with its key.
const realModel = { MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5", ANTHROPIC_API_KEY: made() };

describe("real ports", () => {
  it("[QA-9] with nothing configured, every credentialed port falls back to the practice household and says so", () => {
    const { ports, missing } = realPorts(loadEnv({}), clock, options);
    expect(ports.calendar).toBeInstanceOf(PracticeCalendar);
    expect(ports.calendarPush).toBeUndefined();
    expect(ports.messenger).toBeInstanceOf(PracticeMessenger);
    expect(ports.weather).toBeInstanceOf(OpenMeteoWeather);
    expect(missing).toEqual(expect.arrayContaining(["calendar", "messenger", "objects", "memory", "shopping", "transcriber"]));
  });

  it("uses the real adapters once their settings are present", () => {
    const env = loadEnv({
      PRACTICE: "false",
      GOOGLE_CALENDAR_ID: "family@group.calendar.google.com",
      GOOGLE_ACCESS_TOKEN_FILE: "/run/secrets/google.json",
      TELEGRAM_BOT_TOKEN: `123:${made()}`,
      HINDSIGHT_URL: "http://hindsight:8888",
      S3_ENDPOINT: "http://minio:9000",
      S3_ACCESS_KEY_ID: "minio",
      S3_SECRET_ACCESS_KEY: made(),
      // PRV-6: the real house will not start on the practice defaults of these.
      SESSION_SECRET: made(),
      STORAGE_KEY: "ab".repeat(32),
      TELEGRAM_WEBHOOK_SECRET: made(),
      EMAIL_WEBHOOK_SECRET: made(),
      CALENDAR_WEBHOOK_TOKEN: made(),
      MCP_TOKEN: made(),
      HELPER_TOKEN: made(),
      ...realModel,
    });
    const { ports, missing } = realPorts(env, clock, options);
    expect(ports.calendar).toBeInstanceOf(GoogleCalendarSource);
    expect(ports.calendarPush).toBeInstanceOf(GoogleCalendarPush);
    expect(ports.messenger).toBeInstanceOf(TelegramTransport);
    expect(ports.memory).toBeInstanceOf(HindsightMemory);
    expect(ports.objects).toBeInstanceOf(S3ObjectStore);
    expect(missing).not.toContain("calendar");
    expect(missing).not.toContain("lists");
  });

  it("[PLT-8] the real house with no shopping helper runs, and saves each request (nothing looked for) instead of using a practice basket", async () => {
    const real = { PRACTICE: "false", SESSION_SECRET: "s", STORAGE_KEY: "ab".repeat(32), TELEGRAM_WEBHOOK_SECRET: "t", EMAIL_WEBHOOK_SECRET: "e", CALENDAR_WEBHOOK_TOKEN: "c", MCP_TOKEN: "m", HELPER_TOKEN: "h", ...realModel };
    const { ports, missing } = realPorts(loadEnv(real), clock, options);
    expect(ports.shopping).toBeInstanceOf(NoShoppingHelper);
    expect(missing).toContain("shopping (no helper: nothing is added)");
    expect(ports.shopping.connected).toBe(false);
    const result = await ports.shopping.addItem("oat milk");
    expect(result.kind).toBe("not-connected");
    expect(result.kind === "not-connected" ? result.reason : "").toContain("not connected");
    expect(await ports.shopping.basket()).toEqual({ items: [], deliveryDate: null, changeUrl: "" });
  });

  it("[PLT-9][HOU-160] the real house never reaches its ports on the practice model: its settings are refused first", () => {
    const real = { PRACTICE: "false", SESSION_SECRET: "s", STORAGE_KEY: "ab".repeat(32), TELEGRAM_WEBHOOK_SECRET: "t", EMAIL_WEBHOOK_SECRET: "e", CALENDAR_WEBHOOK_TOKEN: "c", MCP_TOKEN: "m", HELPER_TOKEN: "h" };
    expect(() => loadEnv(real)).toThrow(/will not run on the practice model/);
    expect(realPorts(loadEnv({ ...real, ...realModel }), clock, options).missing.some((m) => m.startsWith("model"))).toBe(false);
  });

  it("[HOU-147] after Google refuses the refresh token, a newly copied google.json is read without a restart", async () => {
    const google = await fakeServer((req, res) => {
      const form = new URLSearchParams(req.body.toString());
      if (form.get("refresh_token") === "old") json(res, 400, { error: "invalid_grant" });
      else json(res, 200, { access_token: ACCESS, expires_in: 3600 });
    });
    const dir = mkdtempSync(path.join(tmpdir(), "google-file-"));
    const file = path.join(dir, "google.json");
    const write = (refresh: string) => writeFileSync(file, JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: refresh, token_url: `${google.url}/token` }));
    try {
      write("old");
      const get = googleTokenFromFile(file, clock);
      await expect(get()).rejects.toThrow(/HTTP 400/);
      write("new");
      expect(await get()).toBe(ACCESS);
    } finally {
      await google.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
