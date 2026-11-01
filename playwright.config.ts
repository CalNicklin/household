import { defineConfig, devices } from "@playwright/test";
import { READY_PORT, stack, STACKS } from "./e2e/stacks.ts";

/**
 * FB-3: journeys against the real app and the practice household, headless, in CI. FB-2: one worker
 * per stack, each against its own household (e2e/stacks.ts), so the journeys run side by side.
 */
export default defineConfig({
  testDir: "e2e",
  workers: STACKS,
  fullyParallel: true,
  reporter: [["./e2e/reporter.ts"], ["list"]],
  use: { baseURL: `http://localhost:${stack(0).server}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "ipad", use: { ...devices["iPad (gen 7) landscape"], viewport: { width: 1180, height: 820 }, browserName: "chromium" } },
  ],
  webServer: { command: "node e2e/stack.ts", url: `http://localhost:${READY_PORT}/`, reuseExistingServer: !process.env["CI"] },
});
