import { TelegramUpdateType } from "@household/contracts";
import { z } from "zod";
import type { MessengerTransport, OutboundButton } from "../ports.ts";
import { defaultFetch, expectOk, type Fetch, IntegrationError } from "./http.ts";

/** Telegram's documented limit on callback_data (Bot API, InlineKeyboardButton). */
const CALLBACK_DATA_MAX_BYTES = 64;

export type TelegramUpdate =
  | { kind: "message"; chatId: string; fromId: string; text: string; updateId: number; voiceFileId?: string }
  | { kind: "callback"; chatId: string; fromId: string; data: string; updateId: number; callbackQueryId: string };

const zId = z.union([z.number(), z.string()]).transform(String);
const zUpdate = z.object({
  update_id: z.number(),
  message: z
    .object({
      chat: z.object({ id: zId }),
      from: z.object({ id: zId }).optional(),
      text: z.string().optional(),
      caption: z.string().optional(),
      voice: z.object({ file_id: z.string() }).optional(),
      audio: z.object({ file_id: z.string() }).optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: z.object({ id: zId }),
      data: z.string().optional(),
      message: z.object({ chat: z.object({ id: zId }) }).optional(),
    })
    .optional(),
});

/** Turn a raw webhook update into the few facts the adapter needs; anything else is ignored. */
export function parseTelegramUpdate(raw: unknown): TelegramUpdate | null {
  const parsed = zUpdate.safeParse(raw);
  if (!parsed.success) return null;
  const u = parsed.data;
  if (u.callback_query !== undefined) {
    const q = u.callback_query;
    if (q.data === undefined) return null;
    return { kind: "callback", chatId: q.message?.chat.id ?? q.from.id, fromId: q.from.id, data: q.data, updateId: u.update_id, callbackQueryId: q.id };
  }
  if (u.message !== undefined) {
    const m = u.message;
    const voice = m.voice?.file_id ?? m.audio?.file_id;
    const text = m.text ?? m.caption ?? "";
    if (text === "" && voice === undefined) return null;
    const base = { kind: "message" as const, chatId: m.chat.id, fromId: m.from?.id ?? m.chat.id, text, updateId: u.update_id };
    return voice === undefined ? base : { ...base, voiceFileId: voice };
  }
  return null;
}

/** What Telegram says about the bot's webhook (Bot API, WebhookInfo): only the parts worth showing. */
const zWebhookInfo = z.object({
  ok: z.literal(true),
  result: z.object({
    url: z.string(),
    pending_update_count: z.number(),
    last_error_date: z.number().optional(),
    last_error_message: z.string().optional(),
    allowed_updates: z.array(z.string()).optional(),
  }),
});
export type TelegramWebhookInfo = z.infer<typeof zWebhookInfo>["result"];
const zMe = z.object({ ok: z.literal(true), result: z.object({ username: z.string() }) });
const zAnswer = z.object({ ok: z.boolean(), description: z.string().optional() });

const zSendResult = z.object({ ok: z.literal(true), result: z.object({ message_id: z.number() }) });
const zFileResult = z.object({ ok: z.literal(true), result: z.object({ file_path: z.string() }) });

/**
 * Telegram Bot API transport (CH-7/CH-8). The bot token only ever appears in request URLs;
 * errors name the method, never the URL, so the token cannot reach a log.
 */
export class TelegramTransport implements MessengerTransport {
  readonly #token: string;
  readonly #apiBase: string;
  readonly #fetch: Fetch;
  constructor(options: { token: string; apiBase?: string; fetch?: Fetch }) {
    this.#token = options.token;
    this.#apiBase = options.apiBase ?? "https://api.telegram.org";
    this.#fetch = options.fetch ?? defaultFetch;
  }

  async #call(method: string, body: unknown): Promise<unknown> {
    const response = await this.#fetch(`${this.#apiBase}/bot${this.#token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await expectOk(response, `Telegram ${method}`);
    return response.json();
  }

  /**
   * Like #call, but a refusal keeps Telegram's own reason (e.g. "bad webhook: ..."), for the person
   * connecting the bot on the server. Telegram's reasons never contain the token; the caller still
   * redacts what it prints.
   */
  async #ask(method: string, body: unknown): Promise<unknown> {
    const response = await this.#fetch(`${this.#apiBase}/bot${this.#token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const answer: unknown = await response.json().catch(() => ({ ok: false }));
    const parsed = zAnswer.safeParse(answer);
    if (!response.ok || !parsed.success || !parsed.data.ok) {
      const reason = parsed.success && parsed.data.description !== undefined ? `: ${parsed.data.description}` : "";
      throw new IntegrationError(`Telegram ${method} failed with HTTP ${response.status}${reason}`, response.status);
    }
    return answer;
  }

  /** The bot's @username, so the person connecting it knows which bot to message. */
  async username(): Promise<string> {
    return zMe.parse(await this.#ask("getMe", {})).result.username;
  }

  /**
   * Points the bot's webhook at the house (CH-2), with the secret Telegram must send back in
   * `x-telegram-bot-api-secret-token` (PRV-6), for only the update types the adapter handles.
   */
  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.#ask("setWebhook", { url, secret_token: secretToken, allowed_updates: Object.values(TelegramUpdateType) });
  }

  async webhookInfo(): Promise<TelegramWebhookInfo> {
    return zWebhookInfo.parse(await this.#ask("getWebhookInfo", {})).result;
  }

  async send(address: string, text: string, buttons: OutboundButton[]): Promise<{ externalId: string }> {
    for (const b of buttons) {
      if (new TextEncoder().encode(b.data).length > CALLBACK_DATA_MAX_BYTES) throw new Error(`Telegram button "${b.label}" data is over ${CALLBACK_DATA_MAX_BYTES} bytes`);
    }
    const body: Record<string, unknown> = { chat_id: address, text };
    if (buttons.length > 0) body["reply_markup"] = { inline_keyboard: [buttons.map((b) => ({ text: b.label, callback_data: b.data }))] };
    const result = zSendResult.parse(await this.#call("sendMessage", body));
    return { externalId: `${address}:${result.result.message_id}` };
  }

  /** Stops the spinner on a tapped button. */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.#call("answerCallbackQuery", text === undefined ? { callback_query_id: callbackQueryId } : { callback_query_id: callbackQueryId, text });
  }

  /** MOM-8: fetch a voice note so it can be transcribed at the edge. */
  async downloadVoice(fileId: string): Promise<{ body: Uint8Array; contentType: string }> {
    const file = zFileResult.parse(await this.#call("getFile", { file_id: fileId }));
    const response = await this.#fetch(`${this.#apiBase}/file/bot${this.#token}/${file.result.file_path}`);
    await expectOk(response, "Telegram file download");
    return { body: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "audio/ogg" };
  }
}
