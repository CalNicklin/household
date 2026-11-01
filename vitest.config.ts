import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["contracts/**/*.test.ts", "server/**/*.test.ts", "tools/**/*.test.ts", "helper/**/*.test.ts", "practice/**/*.test.ts", "scripts/**/*.test.ts", "web/**/*.test.ts", "web/**/*.test.tsx"],
    globalSetup: ["server/testing/global-setup.ts"],
    reporters: ["./tools/reporters/vitest.ts", "default"],
    pool: "forks",
    // FB-2: the test files in a worker share one module graph instead of importing everything again
    // per file (that was over 40% of the run). Each test still gets its own household (QA-9).
    isolate: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
