import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

/**
 * FB-1: with `pnpm dev` running, change a design-system component and time how long until the
 * browser shows it (Vite HMR). Prints the milliseconds; fails above two seconds.
 */
const file = "web/src/design-system/layout.tsx";
const original = readFileSync(file, "utf8");
const marker = `hmr-${Date.now()}`;
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await page.goto("http://localhost:3000/login");
  await page.waitForSelector("main");
  const t0 = Date.now();
  writeFileSync(file, original.replace('<main className="ds-page" aria-label={label}>', `<main className="ds-page" aria-label={label} data-probe="${marker}">`));
  await page.waitForSelector(`[data-probe="${marker}"]`);
  const ms = Date.now() - t0;
  console.log(JSON.stringify({ event: "hmr", ms }));
  if (ms > 2000) process.exitCode = 1;
} finally {
  writeFileSync(file, original);
  await browser.close();
}
