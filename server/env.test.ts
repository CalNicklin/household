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
