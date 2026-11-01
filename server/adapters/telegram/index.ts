import { type Attachment, AttachmentKind, Channel, parseButtonData } from "@household/contracts";
import { z } from "zod";
import { PracticeMessenger } from "../../../practice/fakes.ts";
import { accept, dropUnknown, identify } from "../../coordinator/accept.ts";
import { parseTelegramUpdate, TelegramTransport } from "../../integrations/telegram.ts";
import type { Runtime } from "../../runtime.ts";
import type { Adapter } from "../registry.ts";

/** Practice only: a fake update can carry the words a voice note would have said (MOM-8). */
const zPracticeVoice = z.object({ message: z.object({ voice_transcript: z.string() }) });

async function transcribeVoice(rt: Runtime, raw: unknown, fileId: string, updateId: number): Promise<{ key: string; transcript: string } | null> {
  const messenger = rt.ports.messenger;
  const key = `audio/${updateId}.ogg`;
  if (messenger instanceof TelegramTransport) {
    const audio = await messenger.downloadVoice(fileId);
    await rt.ports.objects.put(key, audio.body, audio.contentType);
    return { key, transcript: await rt.ports.transcriber.transcribe(audio.body, audio.contentType) };
  }
  if (!rt.env.PRACTICE) return null;
  const practice = zPracticeVoice.safeParse(raw);
  if (!practice.success) return null;
  await rt.ports.objects.put(key, new TextEncoder().encode(practice.data.message.voice_transcript), "audio/ogg");
  return { key, transcript: practice.data.message.voice_transcript };
}

/**
 * Telegram as a channel (CH-2). The webhook checks Telegram's secret header (PRV-6), maps the chat
 * to a person at the edge (CH-3), and turns text, voice notes (MOM-8) and button taps (CH-8) into
 * the one message shape. The update id is the duplicate-check key (CH-4). No business logic (CH-11).
 */
export async function handleTelegramUpdate(rt: Runtime, raw: unknown): Promise<void> {
  const update = parseTelegramUpdate(raw);
  if (update === null) return;
  const person = (await identify(rt, Channel.telegram, update.fromId)) ?? (await identify(rt, Channel.telegram, update.chatId));
  if (person === null) {
    // The sender's own user ID (the chat's, in a private chat), so an adult can find theirs (household-telegram senders).
    await dropUnknown(rt, Channel.telegram, update.fromId);
    return;
  }
  const base = { household: rt.env.HOUSEHOLD_ID, person, channel: Channel.telegram, dedupeKey: `telegram:update:${update.updateId}`, receivedAt: rt.ports.clock.now().toISOString() };
  if (update.kind === "callback") {
    const button = parseButtonData(update.data);
    const notification = button === null ? null : await rt.system("telegram").jobs.notification({ id: button.notificationId });
    const action = button === null ? undefined : notification?.actions[button.index];
    if (rt.ports.messenger instanceof TelegramTransport) await rt.ports.messenger.answerCallbackQuery(update.callbackQueryId);
    if (action === undefined) return;
    const ref: Attachment = { kind: AttachmentKind.ref, ref: action.ref, action: action.kind };
    if (action.value !== undefined) ref.value = action.value;
    await accept(rt, { ...base, text: action.label, attachments: [ref] });
    return;
  }
  const attachments: Attachment[] = [];
  let text = update.text;
  if (update.voiceFileId !== undefined) {
    const voice = await transcribeVoice(rt, raw, update.voiceFileId, update.updateId);
    if (voice === null) return;
    attachments.push({ kind: AttachmentKind.audio, key: voice.key, transcript: voice.transcript });
    if (text === "") text = voice.transcript;
  }
  await accept(rt, { ...base, text, attachments });
}

export const adapter: Adapter = {
  name: "telegram",
  routes: (app, rt) => {
    app.post("/webhooks/telegram", async (c) => {
      if (c.req.header("x-telegram-bot-api-secret-token") !== rt.env.TELEGRAM_WEBHOOK_SECRET) return c.json({ error: "bad secret" }, 401);
      await handleTelegramUpdate(rt, await c.req.json());
      return c.json({ ok: true });
    });
  },
  privateRoutes: (app, rt) => {
    if (!rt.env.PRACTICE) return;
    /** Practice only: what the practice "phone" received, so journeys can check messages. */
    app.get("/api/practice/phone", (c) => {
      const messenger = rt.ports.messenger;
      if (!(messenger instanceof PracticeMessenger)) return c.json([]);
      const address = c.req.query("address");
      return c.json(messenger.sent.filter((m) => address === undefined || m.address === address));
    });
  },
};
