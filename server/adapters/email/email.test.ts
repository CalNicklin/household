import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestHousehold } from "../../testing/household.ts";
import { householdWithApp, jobForKey, messageByKey, poll, storedShape } from "../../testing/http.ts";
import type { HttpEnv } from "../registry.ts";

let h: TestHousehold;
let app: Hono<HttpEnv>;

beforeAll(async () => {
  ({ h, app } = await householdWithApp());
});
afterAll(async () => h.close());

const post = (body: unknown, secret = "practice-email-secret") =>
  app.request("/webhooks/email", { method: "POST", headers: { "content-type": "application/json", "x-webhook-secret": secret }, body: JSON.stringify(body) });

const screwfix = {
  from: "Screwfix <orders@screwfix.com>",
  to: "priya@practice.home",
  subject: "Your Screwfix order is confirmed",
  text: "Thanks for your order SF-88231.\nArriving Thursday 5 November between 8am and 1pm. Someone needs to be in to sign for it.\n2x LED bulbs, 1x drill bits",
  messageId: "<sf-88231@screwfix.com>",
};

describe("email adapter", () => {
  test("[CAP-9][CH-2][CH-1] an order confirmation becomes an Arriving row with the shop and day; nobody types anything", async () => {
    expect((await post(screwfix)).status).toBe(200);
    const { messageId, job } = await jobForKey(h.rt, `email:${screwfix.messageId}`);
    expect(job.status).toBe("succeeded");
    const arrival = await poll(async () => (await h.rt.system("test").parcels.all()).find((a) => a.shop === "Screwfix" && a.expectedDate === "2026-11-05"));
    expect(arrival).toMatchObject({ needsSomeoneIn: true, window: "8am–1pm", person: "priya" });
    const shape = await storedShape(h.rt, messageId);
    expect(Object.keys(shape).sort()).toEqual(["attachments", "channel", "dedupeKey", "household", "person", "receivedAt", "text"]);
  });

  test("[PRV-3] the app keeps the shop and the date, not the email", async () => {
    const messageId = await poll(() => messageByKey(h.rt, `email:${screwfix.messageId}`));
    const stored = await h.rt.system("test").jobs.message({ id: messageId });
    expect(stored).toMatchObject({ text: "", attachments: [], redacted: true });
    const job = await poll(() => h.rt.system("test").jobs.jobForMessage({ id: messageId }));
    expect(JSON.stringify(job.toolCalls)).not.toContain("drill bits");
    expect(JSON.stringify(job.toolCalls)).not.toContain("SF-88231");
  });

  test("[PRV-3] an email that is not an order confirmation is never stored at all", async () => {
    const before = await h.rt.system("test").jobs.messageCount();
    const res = await post({ from: "Garden Centre <news@garden.example>", to: "priya@practice.home", subject: "Our autumn newsletter", text: "Bulbs are in! Come and see the new range.", messageId: "<news-1@garden.example>" });
    expect(await res.json()).toEqual({ outcome: "ignored" });
    expect(await h.rt.system("test").jobs.messageCount()).toBe(before);
  });

  test("[CH-3] an order email for nobody in the house is dropped and logged", async () => {
    const res = await post({ ...screwfix, to: "stranger@example.com", messageId: "<sf-other@screwfix.com>" });
    expect(await res.json()).toEqual({ outcome: "dropped" });
    expect(await messageByKey(h.rt, "email:<sf-other@screwfix.com>")).toBeNull();
    expect(await h.rt.system("test").jobs.dropped()).toContainEqual({ channel: "email", address: "orders@screwfix.com", reason: "unknown sender" });
  });

  test("[CH-4] the same email delivered twice is one job", async () => {
    await post(screwfix);
    const messageId = await poll(() => messageByKey(h.rt, `email:${screwfix.messageId}`));
    const jobs = (await h.rt.system("test").jobs.recentJobs()).filter((j) => j.messageId === messageId);
    expect(jobs).toHaveLength(1);
  });

  test("[CH-3] from the house's mail receiver, only the proven forwarder counts, never what To claims", async () => {
    // A forwarded order's From is the shop, and its To is whatever the email says.
    const forwarded = { ...screwfix, to: "orders@orders.practice.home", messageId: "<sf-fwd@screwfix.com>", provenSenders: ["priya@practice.home", "orders@screwfix.com"] };
    expect(await (await post(forwarded)).json()).toEqual({ outcome: "accepted" });
    const { job } = await jobForKey(h.rt, "email:<sf-fwd@screwfix.com>");
    expect(job.person).toBe("priya");

    const claimsPriya = { ...screwfix, to: "priya@practice.home", messageId: "<sf-spoof@screwfix.com>", provenSenders: ["mallory@evil.test"] };
    expect(await (await post(claimsPriya)).json()).toEqual({ outcome: "dropped" });
    expect(await messageByKey(h.rt, "email:<sf-spoof@screwfix.com>")).toBeNull();
    expect(await h.rt.system("test").jobs.dropped()).toContainEqual({ channel: "email", address: "mallory@evil.test", reason: "unknown sender" });
  });

  test("[PRV-6] the email webhook rejects a missing or wrong secret", async () => {
    expect((await post(screwfix, "nope")).status).toBe(401);
    expect((await app.request("/webhooks/email", { method: "POST", body: "{}" })).status).toBe(401);
  });
});
