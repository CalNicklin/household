import { ActionKind, Limits, Practice, Urgency } from "@household/contracts";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { notify } from "../../notify/notify.ts";
import type { TestHousehold } from "../../testing/household.ts";
import { householdWithApp, jobForKey, loginCookie, messageByKey, poll, storedShape } from "../../testing/http.ts";
import type { HttpEnv } from "../registry.ts";

let h: TestHousehold;
let app: Hono<HttpEnv>;
let updateId = 5000;

beforeAll(async () => {
  ({ h, app } = await householdWithApp());
});
afterAll(async () => h.close());

const post = (body: unknown, secret: string = Practice.settings.TELEGRAM_WEBHOOK_SECRET) =>
  app.request("/webhooks/telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(body) });

const textUpdate = (text: string, from = "1001", id = (updateId += 1)) => ({ update_id: id, message: { chat: { id: Number(from) }, from: { id: Number(from) }, text } });

describe("telegram adapter", () => {
  test("[CH-2][CH-1] a Telegram message lands as one job, in the one message shape", async () => {
    const update = textUpdate("we need to oil the squeaky door");
    expect((await post(update)).status).toBe(200);
    const { messageId, job } = await jobForKey(h.rt, `telegram:update:${update.update_id}`);
    expect(job.status).toBe("succeeded");
    const shape = await storedShape(h.rt, messageId);
    expect(Object.keys(shape).sort()).toEqual(["attachments", "channel", "dedupeKey", "household", "person", "receivedAt", "text"]);
    expect(shape).toMatchObject({ person: "priya", channel: "telegram", text: "we need to oil the squeaky door" });
  });

  test("[CH-3] an unknown Telegram chat is dropped and logged, and nothing is stored", async () => {
    const update = textUpdate("hello, who is this", "9999");
    expect((await post(update)).status).toBe(200);
    expect(await messageByKey(h.rt, `telegram:update:${update.update_id}`)).toBeNull();
    const dropped = await h.rt.system("test").jobs.dropped();
    expect(dropped).toContainEqual({ channel: "telegram", address: "9999", reason: "unknown sender" });
  });

  test("[CH-4] Telegram delivering the same update twice creates one job", async () => {
    const update = textUpdate("defrost the freezer");
    await post(update);
    await post(update);
    const { messageId } = await jobForKey(h.rt, `telegram:update:${update.update_id}`);
    const jobs = (await h.rt.system("test").jobs.recentJobs()).filter((j) => j.messageId === messageId);
    expect(jobs).toHaveLength(1);
    const items = (await h.rt.system("test").backlog.list()).filter((i) => i.text === "Defrost the freezer");
    expect(items).toHaveLength(1);
  });

  test("[PRV-6] the Telegram webhook rejects a missing or wrong secret", async () => {
    expect((await post(textUpdate("x"), "wrong")).status).toBe(401);
    const bare = await app.request("/webhooks/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(textUpdate("x")) });
    expect(bare.status).toBe(401);
  });

  test("[CH-8] buttons go out with the message, and a tap comes back in as a normal message", async () => {
    const ref = "bins:2026-11-03";
    const sent = await notify(h.rt, { person: "priya", message: "Bins out tonight", urgency: Urgency.urgent, actions: [{ kind: ActionKind.done, label: "Done", ref }, { kind: ActionKind.notToday, label: "Not today", ref }], key: "test:ch8", countsTowardsBudget: false }, null);
    expect(sent.status).toBe("sent");
    const phone = h.ports.messenger.sent.find((m) => m.text === "Bins out tonight");
    expect(phone?.buttons.map((b) => b.label)).toEqual(["Done", "Not today"]);
    const done = phone?.buttons[0];
    if (done === undefined) throw new Error("no button");
    const tap = { update_id: (updateId += 1), callback_query: { id: "cq-1", from: { id: 1001 }, message: { chat: { id: 1001 } }, data: done.data } };
    expect((await post(tap)).status).toBe(200);
    const { messageId } = await jobForKey(h.rt, `telegram:update:${tap.update_id}`);
    const shape = await storedShape(h.rt, messageId);
    expect(shape.text).toBe("Done");
    expect(shape.attachments).toEqual([{ kind: "ref", ref, action: "done" }]);
    const responses = await h.rt.system("test").plans.responsesForRef({ ref });
    expect(responses.map((r) => [r.action, r.channel, r.person])).toContainEqual(["done", "telegram", "priya"]);
    const after = await h.rt.system("test").jobs.notification({ id: sent.id });
    expect(after?.status).toBe("done");
  });

  test("[CH-10] something said on Telegram shows in the app within two seconds", async () => {
    const cookie = await loginCookie(app);
    const t0 = Date.now();
    await post(textUpdate("we need to clear the gutters before winter"));
    await poll(async () => {
      const res = await app.request("/api/trpc/backlog", { headers: { cookie } });
      const body: unknown = await res.json();
      return JSON.stringify(body).includes("Clear the gutters before winter");
    });
    // limit: liveUpdateBudgetMs
    expect(Date.now() - t0).toBeLessThan(Limits.liveUpdateBudgetMs.value);
  });

  test("[MOM-8] a voice note does exactly what typing the same words does", async () => {
    const typed = textUpdate("we're out of bananas");
    await post(typed);
    const voice = { update_id: (updateId += 1), message: { chat: { id: 1002 }, from: { id: 1002 }, voice: { file_id: "practice-voice" }, voice_transcript: "we're out of bananas" } };
    await post(voice);
    const a = await jobForKey(h.rt, `telegram:update:${typed.update_id}`);
    const b = await jobForKey(h.rt, `telegram:update:${voice.update_id}`);
    expect(a.job.toolCalls.map((c) => [c.tool, c.input])).toEqual([["shop", { items: ["bananas"] }]]);
    expect(b.job.toolCalls.map((c) => [c.tool, c.input])).toEqual(a.job.toolCalls.map((c) => [c.tool, c.input]));
    const stored = await storedShape(h.rt, b.messageId);
    expect(stored.attachments[0]).toMatchObject({ kind: "audio", key: `audio/${voice.update_id}.ogg`, transcript: "we're out of bananas" });
    expect(await h.ports.objects.get(`audio/${voice.update_id}.ogg`)).not.toBeNull();
  });

  test("[QA-9] the practice phone shows what was sent to an address", async () => {
    const cookie = await loginCookie(app);
    const res = await app.request("/api/practice/phone?address=1001", { headers: { cookie } });
    const sent: unknown = await res.json();
    expect(JSON.stringify(sent)).toContain("Bins out tonight");
    expect((await app.request("/api/practice/phone?address=1001")).status).toBe(401);
  });
});
