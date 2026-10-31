import { defineConfig, devices } from "@playwright/test";

/** FB-3: journeys against the real app and the practice household, headless, in CI. */
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  reporter: [["./e2e/reporter.ts"], ["list"]],
  use: { baseURL: "http://localhost:3101", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "ipad", use: { ...devices["iPad (gen 7) landscape"], viewport: { width: 1180, height: 820 }, browserName: "chromium" } },
  ],
  webServer: { command: "node e2e/stack.ts", url: "http://localhost:3101/healthz", reuseExistingServer: !process.env["CI"] },
});
