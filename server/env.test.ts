import { describe, expect, test } from "vitest";
import { houseCalendars, loadEnv, unknownCalendarOwners } from "./env.ts";

const real = {
  PRACTICE: "false",
  SESSION_SECRET: "a",
  STORAGE_KEY: "b",
  TELEGRAM_WEBHOOK_SECRET: "c",
  EMAIL_WEBHOOK_SECRET: "d",
  CALENDAR_WEBHOOK_TOKEN: "e",
  MCP_TOKEN: "f",
  HELPER_TOKEN: "g",
  MODEL_PROVIDER: "anthropic",
  MODEL_ID: "claude-opus-5-5",
  ANTHROPIC_API_KEY: "placeholder-not-a-key",
};

describe("Settings", () => {
  test("[PRV-6] the real house will not start with a secret left at its public practice default", () => {
    expect(() => loadEnv({ PRACTICE: "false" })).toThrow(/PRV-6: the real house needs its own SESSION_SECRET, STORAGE_KEY/);
    expect(loadEnv(real).PRACTICE).toBe(false);
    expect(() => loadEnv({ ...real, MCP_TOKEN: undefined })).toThrow(/MCP_TOKEN/);
    expect(loadEnv({}).PRACTICE).toBe(true);
  });

  test("[PLT-8] a setting written empty is unset: no helper, and an empty secret still stops the real house", () => {
    expect(loadEnv({ ...real, HELPER_URL: "", HINDSIGHT_URL: "" })).not.toHaveProperty("HELPER_URL");
    expect(() => loadEnv({ ...real, SESSION_SECRET: "" })).toThrow(/PRV-6: the real house needs its own SESSION_SECRET/);
  });

  test("[HOU-160] the real house refuses the practice model, and a real model without its key, at startup", () => {
    const practiceModel = /HOU-160: the real house will not run on the practice model: set MODEL_PROVIDER=anthropic/;
    expect(() => loadEnv({ ...real, MODEL_PROVIDER: undefined, MODEL_ID: undefined })).toThrow(practiceModel);
    expect(() => loadEnv({ ...real, MODEL_PROVIDER: "" })).toThrow(practiceModel);
    expect(() => loadEnv({ ...real, MODEL_PROVIDER: "practice" })).toThrow(practiceModel);
    expect(() => loadEnv({ ...real, ANTHROPIC_API_KEY: undefined })).toThrow("HOU-160: MODEL_PROVIDER=anthropic needs ANTHROPIC_API_KEY: set it in .env");
    expect(() => loadEnv({ ...real, ANTHROPIC_API_KEY: "" })).toThrow(/needs ANTHROPIC_API_KEY/);
    expect(() => loadEnv({ ...real, MODEL_PROVIDER: "openai", MODEL_ID: "gpt" })).toThrow(/MODEL_PROVIDER=openai needs OPENAI_API_KEY/);
    expect(loadEnv(real)).toMatchObject({ MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5" });
    expect(loadEnv(real)).not.toHaveProperty("ANTHROPIC_API_KEY");
    // The practice household still runs on the practice model, with no key.
    expect(loadEnv({}).MODEL_PROVIDER).toBe("practice");
  });

  test("[HOME-1] GOOGLE_CALENDARS names each calendar's owner; GOOGLE_CALENDAR_ID alone is the shared one; a bad entry or an unknown owner is caught", () => {
    expect(houseCalendars(loadEnv({ GOOGLE_CALENDARS: "cal:cal@gmail.com, Chloe:chloe@gmail.com,shared:abc@group.calendar.google.com", GOOGLE_CALENDAR_ID: "ignored" }))).toEqual([
      { calendarId: "cal@gmail.com", owner: "cal" },
      { calendarId: "chloe@gmail.com", owner: "chloe" },
      { calendarId: "abc@group.calendar.google.com", owner: "shared" },
    ]);
    expect(houseCalendars(loadEnv({ GOOGLE_CALENDAR_ID: "abc@group.calendar.google.com" }))).toEqual([{ calendarId: "abc@group.calendar.google.com", owner: "shared" }]);
    expect(houseCalendars(loadEnv({}))).toEqual([]);
    expect(() => loadEnv({ GOOGLE_CALENDARS: "cal@gmail.com" })).toThrow(/is not owner:calendarId/);
    expect(() => loadEnv({ GOOGLE_CALENDARS: "cal:a@x.com,chloe:a@x.com" })).toThrow(/twice/);
    expect(unknownCalendarOwners(houseCalendars(loadEnv({ GOOGLE_CALENDARS: "cal:a@x.com,chole:b@x.com,shared:c@x.com" })), ["cal", "chloe"])).toEqual(["chole"]);
  });
});
