import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { HttpEnv } from "../adapters/registry.ts";
import type { TestHousehold } from "../testing/household.ts";
import { householdWithApp } from "../testing/http.ts";

let h: TestHousehold;
let app: Hono<HttpEnv>;

beforeAll(async () => {
  ({ h, app } = await householdWithApp());
});
afterAll(async () => h.close());

/** Routes anyone may reach: logging in, a health check with no data, and the static shell's assets. */
// HOU-154: /sw.js is the static shell's service worker (PUBLIC_FILES), now served with the build id.
const PUBLIC = new Set(["/healthz", "/api/login", "/api/logout", "/sw.js"]);
/** Webhooks are public paths that check their own secret. */
const WEBHOOKS = new Set(["/webhooks/telegram", "/webhooks/email", "/webhooks/calendar", "/mcp"]);

const concrete = (path: string) => path.replace(/\*/g, "probe").replace(/:[a-z]+/gi, "x");

describe("nothing is reachable from the internet without a login", () => {
  test("[PRV-6] every registered route refuses a request with no login or secret", async () => {
    const routes = [...new Map(app.routes.map((r) => [`${r.method} ${r.path}`, r])).values()];
    expect(routes.length).toBeGreaterThan(10);
    const open: string[] = [];
    for (const r of routes) {
      if (PUBLIC.has(r.path)) continue;
      const method = r.method === "ALL" ? "POST" : r.method;
      const path = concrete(r.path);
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
      const refused = WEBHOOKS.has(r.path) ? res.status === 401 : res.status === 401 || (res.status === 302 && (res.headers.get("location") ?? "").startsWith("/login"));
      if (!refused) open.push(`${method} ${r.path} → ${res.status}`);
    }
    expect(open).toEqual([]);
  });

  test("[PRV-6] the login page and assets load without a login, data does not", async () => {
    expect((await app.request("/api/trpc/screen")).status).toBe(401);
    expect((await app.request("/api/live")).status).toBe(401);
    expect((await app.request("/api/objects/runs/x.png")).status).toBe(401);
    expect((await app.request("/")).status).toBe(302);
    expect((await app.request("/login")).status).not.toBe(302);
  });
});
