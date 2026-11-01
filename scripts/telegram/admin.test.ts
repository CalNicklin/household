import { execFile } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import type { HttpEnv } from "../../server/adapters/registry.ts";
import { TelegramTransport } from "../../server/integrations/telegram.ts";
import type { TestHousehold } from "../../server/testing/household.ts";
import { householdWithApp, jobForKey, messageByKey, storedShape } from "../../server/testing/http.ts";
import { connect, parseTelegramCommand, redact, settingsProblem, showSenders, showStatus, TELEGRAM_USAGE, webhookUrl } from "./admin.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const run = promisify(execFile);
const TOKEN = "123456:stand-in-bot-token-AAAA";
const SECRET = "stand-in-webhook-secret_0123";
const PUBLIC_URL = "https://house.example.test";

/**
 * A stand-in for api.telegram.org: it keeps the webhook it is given, answers getMe and getWebhookInfo,
 * and, when asked to, refuses with a description that repeats the token and the secret, to prove
 * nothing secret is ever printed.
 */
function answerJson(res: ServerResponse, status: number, answer: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(answer));
}

type StandIn = { base: string; calls: { method: string; token: string; body: Record<string, unknown> }[]; webhook: { url: string; allowed: string[] | undefined }; refuseWith: string | null; close(): Promise<void> };
async function standIn(): Promise<StandIn> {
  const state: Omit<StandIn, "base" | "close"> = { calls: [], webhook: { url: "", allowed: undefined }, refuseWith: null };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
      const body = z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      if (match === null) return answerJson(res, 404, { ok: false, description: "Not Found" });
      const [, token = "", method = ""] = match;
      state.calls.push({ method, token, body });
      if (token !== TOKEN) return answerJson(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
      if (state.refuseWith !== null) return answerJson(res, 400, { ok: false, error_code: 400, description: state.refuseWith });
      if (method === "getMe") return answerJson(res, 200, { ok: true, result: { id: 123456, is_bot: true, username: "house_test_bot" } });
      if (method === "setWebhook") {
        state.webhook = { url: String(body["url"]), allowed: z.array(z.string()).parse(body["allowed_updates"]) };
        return answerJson(res, 200, { ok: true, result: true, description: "Webhook was set" });
      }
      if (method === "getWebhookInfo") {
        const result: Record<string, unknown> = { url: state.webhook.url, has_custom_certificate: false, pending_update_count: 0 };
        if (state.webhook.allowed !== undefined) result["allowed_updates"] = state.webhook.allowed;
        return answerJson(res, 200, { ok: true, result });
      }
      return answerJson(res, 404, { ok: false, description: "Not Found: method not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.custom<AddressInfo>((a) => typeof a === "object" && a !== null).parse(server.address());
  return Object.assign(state, { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
}

describe("household-telegram: the command line", () => {
  test("[CH-2] accepts exactly connect, status, senders, and set <person> <telegram user id>", () => {
    expect(parseTelegramCommand(["connect"])).toEqual({ kind: "connect" });
    expect(parseTelegramCommand(["status"])).toEqual({ kind: "status" });
    expect(parseTelegramCommand(["senders"])).toEqual({ kind: "senders" });
    expect(parseTelegramCommand(["set", "cal", "123456789"])).toEqual({ kind: "set", person: "cal", telegram: "123456789" });
    for (const bad of [[], [""], ["connect", "now"], ["status", "--token", TOKEN], ["senders", "all"], ["set"], ["set", "cal"], ["set", "cal", "123", "x"], ["--help"], ["setWebhook"], ["CONNECT"]]) expect(parseTelegramCommand(bad), JSON.stringify(bad)).toEqual({ error: TELEGRAM_USAGE });
    for (const [person, id] of [["Cal", "1"], ["cal;id", "1"], ["../cal", "1"], ["cal", "0123"], ["cal", "12a"], ["cal", "-100123"], ["cal", "@cal"], ["cal", "12345678901234567"], ["cal", ""]]) {
      const parsed = parseTelegramCommand(["set", person ?? "", id ?? ""]);
      expect("error" in parsed && parsed.error !== TELEGRAM_USAGE, `${person} ${id}`).toBe(true);
    }
  });

  test("[PRV-6] the token and the secret are redacted wherever they appear", () => {
    expect(redact(`POST https://api.telegram.org/bot${TOKEN}/setWebhook secret=${SECRET} again ${TOKEN}`, [TOKEN, SECRET])).toBe("POST https://api.telegram.org/bot[redacted]/setWebhook secret=[redacted] again [redacted]");
    expect(redact("nothing secret here", [undefined, ""])).toBe("nothing secret here");
  });

  test("[CH-2] the webhook is the house's own address; connect refuses a missing token, an unusable secret or http", () => {
    expect(webhookUrl("https://house.tracesknown.com")).toBe("https://house.tracesknown.com/webhooks/telegram");
    expect(settingsProblem({ token: TOKEN, secret: SECRET, publicUrl: PUBLIC_URL })).toBeNull();
    expect(settingsProblem({ token: undefined, secret: SECRET, publicUrl: PUBLIC_URL })).toMatch(/TELEGRAM_BOT_TOKEN is not set/);
    expect(settingsProblem({ token: TOKEN, secret: "has+slash/and=", publicUrl: PUBLIC_URL })).toMatch(/TELEGRAM_WEBHOOK_SECRET/);
    expect(settingsProblem({ token: TOKEN, secret: SECRET, publicUrl: "http://house.example.test" })).toMatch(/not https/);
  });
});

describe("household-telegram against a stand-in for api.telegram.org", () => {
  let api: StandIn;
  beforeAll(async () => {
    api = await standIn();
  });
  afterAll(async () => api.close());

  test("[CH-2][PRV-6] connect sets the webhook with the secret and only the updates the adapter handles, then shows it", async () => {
    const lines: string[] = [];
    const bot = new TelegramTransport({ token: TOKEN, apiBase: api.base });
    expect(await showStatus({ token: TOKEN, secret: SECRET, publicUrl: PUBLIC_URL }, bot, (l) => lines.push(l))).toBe(1);
    expect(lines).toContain("webhook: not set");
    lines.length = 0;
    expect(await connect({ token: TOKEN, secret: SECRET, publicUrl: PUBLIC_URL }, bot, (l) => lines.push(l))).toBe(0);
    const set = api.calls.find((c) => c.method === "setWebhook");
    expect(set?.body).toEqual({ url: `${PUBLIC_URL}/webhooks/telegram`, secret_token: SECRET, allowed_updates: ["message", "callback_query"] });
    expect(lines).toEqual(["bot: @house_test_bot", `webhook: ${PUBLIC_URL}/webhooks/telegram (this house)`, "updates: message, callback_query", "waiting to be delivered: 0", "connected"]);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  test("[PRV-6] the real command, run as the server runs it: token and secret only in the environment, never in its output", async () => {
    const env = { PATH: process.env["PATH"] ?? "", PRACTICE: "true", TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_API_BASE: api.base, PUBLIC_URL };
    const ok = await run("node", ["scripts/telegram.ts", "connect"], { cwd: ROOT, env });
    expect(ok.stdout).toContain(`webhook: ${PUBLIC_URL}/webhooks/telegram (this house)`);
    expect(ok.stdout).toContain("connected");
    const status = await run("node", ["scripts/telegram.ts", "status"], { cwd: ROOT, env });
    expect(status.stdout).toContain("bot: @house_test_bot");
    // Telegram refusing, and (as a worst case) repeating the token and the secret in its reason.
    api.refuseWith = `Bad Request: bad webhook for bot${TOKEN} with ${SECRET}`;
    const refused = await run("node", ["scripts/telegram.ts", "connect"], { cwd: ROOT, env }).then(() => null, (e: unknown) => z.object({ code: z.number(), stdout: z.string(), stderr: z.string() }).parse(e));
    api.refuseWith = null;
    expect(refused?.code).toBe(1);
    expect(refused?.stderr).toContain("Telegram setWebhook failed with HTTP 400: Bad Request: bad webhook for bot[redacted] with [redacted]");
    for (const out of [ok.stdout, ok.stderr, status.stdout, status.stderr, refused?.stdout ?? "", refused?.stderr ?? ""]) {
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain(SECRET);
    }
    const noToken = await run("node", ["scripts/telegram.ts", "connect"], { cwd: ROOT, env: { ...env, TELEGRAM_BOT_TOKEN: "" } }).then(() => null, (e: unknown) => z.object({ code: z.number(), stdout: z.string() }).parse(e));
    expect(noToken?.code).toBe(1);
    expect(noToken?.stdout).toMatch(/TELEGRAM_BOT_TOKEN is not set/);
    const usage = await run("node", ["scripts/telegram.ts", "connect", TOKEN], { cwd: ROOT, env }).then(() => null, (e: unknown) => z.object({ code: z.number(), stderr: z.string() }).parse(e));
    expect(usage?.code).toBe(2);
    expect(usage?.stderr).not.toContain(TOKEN);
  });
});

describe("finding and adding an adult's Telegram ID", () => {
  let h: TestHousehold;
  let app: Hono<HttpEnv>;
  let updateId = 9000;
  beforeAll(async () => {
    ({ h, app } = await householdWithApp());
  });
  afterAll(async () => h.close());

  const post = async (from: number, text: string, chat = from) => {
    const update = { update_id: (updateId += 1), message: { chat: { id: chat }, from: { id: from }, text } };
    const res = await app.request("/webhooks/telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "practice-telegram-secret" }, body: JSON.stringify(update) });
    expect(res.status).toBe(200);
    return update.update_id;
  };
  const fail = (args: string[]) => cli(args).then(() => null, (e: unknown) => z.object({ code: z.number(), stderr: z.string() }).parse(e));
  const cli = (args: string[]) => run("node", ["scripts/telegram.ts", ...args], { cwd: ROOT, env: { PATH: process.env["PATH"] ?? "", PRACTICE: "true", DATABASE_URL: h.env.DATABASE_URL, DB_PREFIX: h.env.DB_PREFIX } });

  test("[CH-3] an unknown sender is dropped and stays unanswered; senders shows their user ID, never their words", async () => {
    const id = await post(555000111, "hi, this is Cal's new phone");
    expect(await messageByKey(h.rt, `telegram:update:${id}`)).toBeNull();
    // In a group the sender's own ID is recorded, not the group's. A minute later, so it is the newest.
    h.ports.clock.set(new Date(h.ports.clock.now().getTime() + 60_000));
    await post(555000222, "hello from a group", -1001234);
    expect(h.ports.messenger.sent.filter((m) => m.address === "555000111" || m.address === "-1001234")).toEqual([]);
    const senders = await h.rt.system("test").jobs.droppedSenders({ channel: "telegram" });
    expect(senders.map((s) => s.address).slice(0, 2)).toEqual(["555000222", "555000111"]);
    const out = (await cli(["senders"])).stdout;
    expect(out).toMatch(/^ {2}555000222 {2}last \S+ {2}once$/m);
    expect(out).toContain("555000111");
    expect(out).not.toContain("-1001234");
    expect(out).not.toContain("Cal's new phone");
    const lines: string[] = [];
    showSenders([{ address: "1001", lastAt: "2026-11-01T09:00:00.000Z", times: 1 }], new Set(["1001"]), (l) => lines.push(l));
    expect(lines[0]).toMatch(/nobody unknown has messaged the bot yet/);
  });

  test("[CH-3] set gives an adult the ID: their next message reaches the house as them", async () => {
    const out = (await cli(["set", "priya", "555000111"])).stdout;
    expect(out).toContain("priya's Telegram ID is now 555000111 (was 1001)");
    const id = await post(555000111, "we need to descale the kettle");
    const { messageId, job } = await jobForKey(h.rt, `telegram:update:${id}`);
    expect(job.status).toBe("succeeded");
    expect(await storedShape(h.rt, messageId)).toMatchObject({ person: "priya", channel: "telegram", text: "we need to descale the kettle" });
    // Her ID is known now, so senders no longer lists it; the other stranger is still there.
    const senders = (await cli(["senders"])).stdout;
    expect(senders).not.toContain("555000111");
    expect(senders).toContain("555000222");
    // A sitter's ID (Jess, 2001) can be messaged by the house but is dropped when it writes, so it is still listed.
    await post(2001, "can I do friday?");
    expect((await cli(["senders"])).stdout).toContain("2001");
    // The old ID is no longer hers: it is dropped like any stranger's.
    const old = await post(1001, "still me?");
    expect(await messageByKey(h.rt, `telegram:update:${old}`)).toBeNull();
  });

  test("[CH-3] set refuses an ID that is someone else's, anyone who isn't an adult, and bad arguments", async () => {
    expect((await fail(["set", "tom", "555000111"]))?.stderr).toMatch(/already priya's/);
    const set = (person: string, telegram: string) => h.rt.system("test").household.setTelegramId({ person, telegram });
    await expect(set("nobody", "555000999")).rejects.toThrow(/nobody is not one of the adults/);
    await expect(set("ivy", "555000999")).rejects.toThrow(/ivy is not one of the adults/);
    const bad = await fail(["set", "tom", "not-a-number"]);
    expect(bad?.code).toBe(2);
    expect(await h.rt.system("test").household.addressesFor({ person: "tom" })).toContainEqual({ channel: "telegram", address: "1002" });
  });
});
