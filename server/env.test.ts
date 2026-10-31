import { describe, expect, test } from "vitest";
import { loadEnv } from "./env.ts";

describe("Settings", () => {
  test("[PRV-6] the real house will not start with a secret left at its public practice default", () => {
    expect(() => loadEnv({ PRACTICE: "false" })).toThrow(/PRV-6: the real house needs its own SESSION_SECRET, STORAGE_KEY/);
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
    expect(loadEnv(real).PRACTICE).toBe(false);
    expect(() => loadEnv({ ...real, MCP_TOKEN: undefined })).toThrow(/MCP_TOKEN/);
    expect(loadEnv({}).PRACTICE).toBe(true);
  });
});
