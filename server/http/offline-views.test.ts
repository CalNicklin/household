import { NO_STORE_VIEWS, VIEW_PERSON_HEADER } from "@household/contracts";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { HttpEnv } from "../adapters/registry.ts";
import type { TestHousehold } from "../testing/household.ts";
import { householdWithApp, loginCookie } from "../testing/http.ts";
import { viewsRouter } from "../views/router.ts";
import { noStore } from "./app.ts";

let h: TestHousehold;
let app: Hono<HttpEnv>;

beforeAll(async () => {
  ({ h, app } = await householdWithApp());
});
afterAll(async () => h.close());

describe("offline views are per person (HOU-165)", () => {
  test("[HOME-6] (HOU-165) every view answer names its person; private views are no-store, the plan is not", async () => {
    const cookie = await loginCookie(app, "tom");
    const screen = await app.request("/api/trpc/screen", { headers: { cookie } });
    expect(screen.headers.get(VIEW_PERSON_HEADER)).toBe("tom");
    expect(screen.headers.get("cache-control") ?? "").not.toMatch(/no-store/);
    const conversation = await app.request("/api/trpc/conversation", { headers: { cookie } });
    expect(conversation.headers.get(VIEW_PERSON_HEADER)).toBe("tom");
    expect(conversation.headers.get("cache-control")).toBe("no-store");
  });

  test("(HOU-165) every no-store view is a real view, and a batch holding one is no-store", () => {
    const names = Object.keys(viewsRouter(h.rt, { planToday: async () => undefined }));
    for (const v of NO_STORE_VIEWS) expect(names).toContain(v);
    expect(noStore("/api/trpc/screen,conversation")).toBe(true);
    expect(noStore("/api/trpc/screen")).toBe(false);
  });
});
