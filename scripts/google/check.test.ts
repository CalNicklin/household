import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CalendarWatch } from "@household/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadEnv } from "../../server/env.ts";
import { fakeServer, json } from "../../server/integrations/fake-http.ts";
import { googleCheck } from "./check.ts";

/** HOU-147: `household-google check` against a stand-in Google; it must never print a token or secret. */
let dir: string;
let closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "google-check-"));
});
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
  rmSync(dir, { recursive: true, force: true });
});

const clock = { now: () => new Date("2026-11-02T08:00:00Z") };
const SECRET = "csecret-never-printed";
const REFRESH = "1//refresh-never-printed";
const openWatch: CalendarWatch = { channelId: "c1", calendarId: "family123@group.calendar.google.com", resourceId: "r1", address: "https://house.example/webhooks/calendar", expiresAt: "2026-11-08T11:00:00.000Z", openedAt: "2026-11-01T11:00:00.000Z" };

async function check(options: { tokenStatus?: number; calendarId?: string; watch?: CalendarWatch | null; creds?: unknown }) {
  const google = await fakeServer((req, res) => {
    if (req.path === "/token") return options.tokenStatus === undefined ? json(res, 200, { access_token: "ya29.secret-access", expires_in: 3600 }) : json(res, options.tokenStatus, { error: "invalid_grant" });
    if (req.path.startsWith("/users/me/calendarList"))
      return json(res, 200, {
        items: [
          { id: "cal@example.com", summary: "cal@example.com", primary: true, accessRole: "owner" },
          { id: "family123@group.calendar.google.com", summary: "Family", accessRole: "writer" },
        ],
      });
    return json(res, 404, {});
  });
  closers.push(google.close);
  const file = path.join(dir, "google.json");
  writeFileSync(file, JSON.stringify(options.creds ?? { client_id: "cid", client_secret: SECRET, refresh_token: REFRESH, token_url: `${google.url}/token` }));
  const env = loadEnv({ PUBLIC_URL: "https://house.example", GOOGLE_ACCESS_TOKEN_FILE: file, GOOGLE_CALENDAR_API: google.url, ...(options.calendarId === undefined ? {} : { GOOGLE_CALENDAR_ID: options.calendarId }) });
  const lines: string[] = [];
  const code = await googleCheck({ env, clock, watch: async () => (options.watch === undefined ? openWatch : options.watch), out: (l) => lines.push(l) });
  const text = lines.join("\n");
  for (const secret of [SECRET, REFRESH, "ya29.secret-access"]) expect(text).not.toContain(secret);
  expect(google.requests.filter((r) => r.path !== "/token" && r.method !== "GET")).toEqual([]);
  return { code, text, google };
}

describe("household-google check (HOU-147)", () => {
  test("refreshes a token, lists calendars by name and ID, marks the one the house reads, and shows the watch", async () => {
    const { code, text } = await check({ calendarId: "family123@group.calendar.google.com" });
    expect(code).toBe(0);
    expect(text).toContain("✓ token: refreshed from the refresh token");
    expect(text).toContain("  → Family  family123@group.calendar.google.com  [writer]");
    expect(text).toContain("    cal@example.com (primary)  cal@example.com  [owner]");
    expect(text).toContain("✓ watch: open since 2026-11-01T11:00:00.000Z, sending to https://house.example/webhooks/calendar; Google ends it 2026-11-08T11:00:00.000Z (in 6d 3h)");
    expect(text).toMatch(/All good\.$/);
  });

  test("before GOOGLE_CALENDAR_ID is set it lists the IDs to choose from and says what to do", async () => {
    const { code, text } = await check({ watch: null });
    expect(code).toBe(1);
    expect(text).toContain("family123@group.calendar.google.com");
    expect(text).toContain("✗ GOOGLE_CALENDAR_ID is not set");
    expect(text).toContain("✗ watch: none open yet");
    expect(text).toContain("2 things to fix");
  });

  test("a wrong calendar ID, an ended watch or one at another address is a problem", async () => {
    expect((await check({ calendarId: "nope@group.calendar.google.com" })).text).toContain("is not one of them");
    expect((await check({ calendarId: "family123@group.calendar.google.com", watch: { ...openWatch, expiresAt: "2026-11-02T07:00:00.000Z" } })).text).toContain("✗ watch: ended");
    expect((await check({ calendarId: "family123@group.calendar.google.com", watch: { ...openWatch, address: "https://old.example/webhooks/calendar" } })).code).toBe(1);
    expect((await check({ calendarId: "family123@group.calendar.google.com", watch: { ...openWatch, calendarId: "cal@example.com" } })).text).toContain("✗ watch: on cal@example.com, not GOOGLE_CALENDAR_ID");
  });

  test("an expired or revoked refresh token says to connect again, and lists nothing", async () => {
    const { code, text, google } = await check({ tokenStatus: 400, calendarId: "family123@group.calendar.google.com" });
    expect(code).toBe(1);
    expect(text).toContain("Google refused the refresh token (HTTP 400)");
    expect(text).toContain("pnpm google:connect");
    expect(google.requests.some((r) => r.path.startsWith("/users"))).toBe(false);
  });

  test("a fixed access token is flagged: it dies within the hour", async () => {
    const { code, text } = await check({ creds: { access_token: "ya29.secret-access" }, calendarId: "family123@group.calendar.google.com" });
    expect(code).toBe(1);
    expect(text).toContain("holds a fixed access token");
  });

  test("the server command takes `check` only, and runs it in the deployed image as the production project", () => {
    const srv = path.join(dir, "srv");
    const bin = path.join(dir, "bin");
    mkdirSync(srv);
    mkdirSync(bin);
    writeFileSync(path.join(srv, ".env"), "HOUSEHOLD_DOMAIN=house.example\n");
    writeFileSync(path.join(dir, "household.conf"), `HOUSEHOLD_DIR=${srv}\n`);
    writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash\necho "$COMPOSE_PROJECT_NAME $HOUSEHOLD_IMAGE $*" > "${path.join(dir, "docker.log")}"\n`);
    chmodSync(path.join(bin, "docker"), 0o755);
    const script = path.join(import.meta.dirname, "../../deploy/household-google.sh");
    const run = (...args: string[]) => spawnSync("bash", [script, ...args], { env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOUSEHOLD_CONF: path.join(dir, "household.conf") }, encoding: "utf8" });
    expect(run().status).toBe(2);
    expect(run("check", "; rm -rf /").status).toBe(2);
    expect(run("deploy").status).toBe(2);
    expect(run("check").stderr).toContain("nothing deployed yet");
    writeFileSync(path.join(srv, "image"), "ghcr.io/calnicklin/household@sha256:abc\n");
    expect(run("check").status).toBe(0);
    expect(readFileSync(path.join(dir, "docker.log"), "utf8").trim()).toBe("household ghcr.io/calnicklin/household@sha256:abc compose run --rm -T --no-deps app node scripts/google-check.ts");
  });
});
