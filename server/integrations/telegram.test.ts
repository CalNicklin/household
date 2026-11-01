import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeServer, json } from "./fake-http.ts";
import { parseTelegramUpdate, TelegramTransport } from "./telegram.ts";

const TOKEN = "123456:SECRET-bot-token";
const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  vi.restoreAllMocks();
});

describe("Telegram transport", () => {
  it("[CH-8] sends one-tap buttons as an inline keyboard", async () => {
    const server = await fakeServer((_req, res) => json(res, 200, { ok: true, result: { message_id: 42 } }));
    servers.push(server);
    const tg = new TelegramTransport({ token: TOKEN, apiBase: server.url });
    const out = await tg.send("1001", "Bins out tonight", [
      { label: "Done", data: "done|bins:2026-11-02" },
      { label: "Snooze", data: "snooze|bins:2026-11-02" },
    ]);
    expect(out.externalId).toBe("1001:42");
    const req = server.requests[0];
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe(`/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(req?.body.toString() ?? "{}")).toEqual({
      chat_id: "1001",
      text: "Bins out tonight",
      reply_markup: { inline_keyboard: [[{ text: "Done", callback_data: "done|bins:2026-11-02" }, { text: "Snooze", callback_data: "snooze|bins:2026-11-02" }]] },
    });
  });

  it("refuses button data over Telegram's 64-byte limit instead of sending a broken button", async () => {
    const tg = new TelegramTransport({ token: TOKEN, apiBase: "http://127.0.0.1:1" });
    await expect(tg.send("1001", "x", [{ label: "Done", data: "d".repeat(65) }])).rejects.toThrow(/64 bytes/);
  });

  it("[AUT-2] never puts the bot token in an error or a log line", async () => {
    const server = await fakeServer((_req, res) => json(res, 500, { ok: false }));
    servers.push(server);
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => logged.push(args.map(String).join(" ")));
    const tg = new TelegramTransport({ token: TOKEN, apiBase: server.url });
    const error: unknown = await tg.send("1001", "hi", []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("SECRET");
    expect(error instanceof Error ? (error.stack ?? "") : "").not.toContain("SECRET");
    expect(logged.join("\n")).not.toContain("SECRET");
  });

  it("[MOM-8] downloads a voice note through getFile", async () => {
    const server = await fakeServer((req, res) => {
      if (req.path.endsWith("/getFile")) return json(res, 200, { ok: true, result: { file_path: "voice/file_1.oga" } });
      res.writeHead(200, { "content-type": "audio/ogg" });
      res.end(Buffer.from([1, 2, 3]));
    });
    servers.push(server);
    const voice = await new TelegramTransport({ token: TOKEN, apiBase: server.url }).downloadVoice("abc");
    expect([...voice.body]).toEqual([1, 2, 3]);
    expect(voice.contentType).toBe("audio/ogg");
    expect(server.requests[1]?.path).toBe(`/file/bot${TOKEN}/voice/file_1.oga`);
  });

  it("answers a callback query so the button stops spinning", async () => {
    const server = await fakeServer((_req, res) => json(res, 200, { ok: true, result: true }));
    servers.push(server);
    await new TelegramTransport({ token: TOKEN, apiBase: server.url }).answerCallbackQuery("cbq-1");
    expect(server.requests[0]?.path).toBe(`/bot${TOKEN}/answerCallbackQuery`);
    expect(JSON.parse(server.requests[0]?.body.toString() ?? "{}")).toEqual({ callback_query_id: "cbq-1" });
  });
});

describe("Telegram updates", () => {
  it("[CH-1] a text message becomes chat, sender, text and update id", () => {
    expect(parseTelegramUpdate({ update_id: 7, message: { chat: { id: 1001 }, from: { id: 1001 }, text: "we're out of oat milk" } })).toEqual({
      kind: "message",
      chatId: "1001",
      fromId: "1001",
      text: "we're out of oat milk",
      updateId: 7,
    });
  });

  it("[CH-8] a button tap comes back as a callback with its data", () => {
    expect(parseTelegramUpdate({ update_id: 8, callback_query: { id: "q1", from: { id: 1002 }, data: "done|bins", message: { chat: { id: 1002 } } } })).toEqual({
      kind: "callback",
      chatId: "1002",
      fromId: "1002",
      data: "done|bins",
      updateId: 8,
      callbackQueryId: "q1",
    });
  });

  it("[MOM-8] a voice note carries its file id", () => {
    expect(parseTelegramUpdate({ update_id: 9, message: { chat: { id: 1 }, from: { id: 1 }, voice: { file_id: "v1" } } })).toMatchObject({ kind: "message", text: "", voiceFileId: "v1" });
  });

  it("ignores updates it has nothing to do with", () => {
    expect(parseTelegramUpdate({ update_id: 10, edited_message: {} })).toBeNull();
    expect(parseTelegramUpdate({ nonsense: true })).toBeNull();
  });
});
