import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["contracts/**/*.test.ts", "server/**/*.test.ts", "tools/**/*.test.ts", "deploy/**/*.test.ts", "helper/**/*.test.ts", "practice/**/*.test.ts", "web/**/*.test.ts", "web/**/*.test.tsx"],
    globalSetup: ["server/testing/global-setup.ts"],
    reporters: ["./tools/reporters/vitest.ts", "default"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
