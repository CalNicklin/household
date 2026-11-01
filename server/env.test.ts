import { describe, expect, test } from "vitest";
import { loadEnv } from "./env.ts";

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
});
