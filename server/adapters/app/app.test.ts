import type { Hono } from "hono";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestHousehold } from "../../testing/household.ts";
import { householdWithApp, jobForKey, loginCookie, storedShape } from "../../testing/http.ts";
import type { HttpEnv } from "../registry.ts";

let h: TestHousehold;
let app: Hono<HttpEnv>;

beforeAll(async () => {
  ({ h, app } = await householdWithApp());
});
afterAll(async () => h.close());

describe("app adapter", () => {
  test("[CH-2][CH-1][CH-3] the app's composer posts one message, from the logged-in person, as one job", async () => {
    const cookie = await loginCookie(app, "tom");
    const res = await app.request("/api/messages", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "re-seal the bath", clientId: "c-1" }) });
    expect(res.status).toBe(200);
    const { messageId, job } = await jobForKey(h.rt, "app:tom:c-1");
    expect(job.status).toBe("succeeded");
    const shape = await storedShape(h.rt, messageId);
    expect(Object.keys(shape).sort()).toEqual(["attachments", "channel", "dedupeKey", "household", "person", "receivedAt", "text"]);
    expect(shape).toMatchObject({ person: "tom", channel: "app" });
  });

  test("[CH-4] a retried POST with the same client id is the same message", async () => {
    const cookie = await loginCookie(app, "tom");
    const send = () => app.request("/api/messages", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "re-grout the shower", clientId: "c-2" }) });
    const zOut = z.object({ jobId: z.string(), duplicate: z.boolean() });
    const a = zOut.parse(await (await send()).json());
    const b = zOut.parse(await (await send()).json());
    expect(b).toMatchObject({ jobId: a.jobId, duplicate: true });
  });

  test("[PRV-6] the app adapter needs a login", async () => {
    const res = await app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x", clientId: "c-3" }) });
    expect(res.status).toBe(401);
  });
});
