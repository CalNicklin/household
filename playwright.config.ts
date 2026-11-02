import { existsSync } from "node:fs";
import { defineConfig, devices, webkit } from "@playwright/test";
import { READY_PORT, STACKS } from "./e2e/stacks.ts";

/**
 * FB-3: journeys against the real app and the practice household, headless, in CI. FB-2: one worker
 * per stack, each against its own household (e2e/stacks.ts), so the journeys run side by side.
 */
export default defineConfig({
  testDir: "e2e",
  workers: STACKS,
  fullyParallel: true,
  reporter: [["./e2e/reporter.ts"], ["list"]],
  // baseURL comes from each worker's own stack (e2e/fixtures.ts).
  // FB-2 (HOU-164): a failed journey keeps its trace's actions, network and console, plus the failure
  // screenshot; DOM snapshots and screencast frames for every journey cost about a fifth of the e2e run.
  use: { trace: { mode: "retain-on-failure", snapshots: false, screenshots: false }, screenshot: "only-on-failure" },
  projects: [
    { name: "ipad", use: { ...devices["iPad (gen 7) landscape"], viewport: { width: 1180, height: 820 }, browserName: "chromium" } },
    // HOU-159: the composer journeys again in WebKit, Safari's engine, wherever it is installed (CI installs it).
    ...(existsSync(webkit.executablePath()) ? [{ name: "webkit", testMatch: /conversation\.spec\.ts/, use: { browserName: "webkit" as const } }] : []),
  ],
  webServer: { command: "node e2e/stack.ts", url: `http://localhost:${READY_PORT}/`, reuseExistingServer: !process.env["CI"] },
});
