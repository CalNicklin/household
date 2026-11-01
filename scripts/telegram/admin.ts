import { type DroppedSender, zTelegramUserId } from "@household/contracts";
import type { TelegramWebhookInfo } from "../../server/integrations/telegram.ts";

/**
 * CH-2 / CH-3 on the real house: what `sudo household-telegram ...` does, inside the app's container
 * (deploy/household-telegram.sh). The bot token and the webhook secret come from the environment only
 * (the house's .env); nothing here takes them as an argument, and every line printed goes through
 * `redact` first.
 */
export type TelegramCommand = { kind: "connect" } | { kind: "status" } | { kind: "senders" } | { kind: "set"; person: string; telegram: string };

export const TELEGRAM_USAGE = "usage: household-telegram connect | status | senders | set <person> <telegram user id>";

const zPersonId = /^[a-z][a-z0-9-]*$/;

/** The command line, or why it is wrong. Nothing else is accepted: no options, no extra words. */
export function parseTelegramCommand(argv: readonly string[]): TelegramCommand | { error: string } {
  const [kind, ...rest] = argv;
  if ((kind === "connect" || kind === "status" || kind === "senders") && rest.length === 0) return { kind };
  if (kind === "set" && rest.length === 2) {
    const [person = "", telegram = ""] = rest;
    if (!zPersonId.test(person)) return { error: `"${person}" is not a person's id (as in house.json, e.g. cal)` };
    if (!zTelegramUserId.safeParse(telegram).success) return { error: `"${telegram}" is not a Telegram user ID (digits only, e.g. 123456789)` };
    return { kind, person, telegram };
  }
  return { error: TELEGRAM_USAGE };
}

/** Every secret in `text` replaced, however it got there (an error, Telegram's answer, a URL). */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s !== undefined && s !== "") out = out.split(s).join("[redacted]");
  return out;
}

/** Telegram's rule for secret_token (Bot API, setWebhook): 1-256 of A-Z, a-z, 0-9, _ and -. */
const SECRET_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

export type Settings = { token: string | undefined; secret: string; publicUrl: string };
/** The few Bot API calls these commands make; TelegramTransport in the house, a stand-in in tests. */
export type BotAdmin = { username(): Promise<string>; setWebhook(url: string, secret: string): Promise<void>; webhookInfo(): Promise<TelegramWebhookInfo> };
type Print = (line: string) => void;

export function webhookUrl(publicUrl: string): string {
  return new URL("/webhooks/telegram", publicUrl).toString();
}

export const NO_TOKEN = "TELEGRAM_BOT_TOKEN is not set: put the token BotFather gave you in /srv/household/.env, redeploy, then run this again";

/** Why the settings can't connect a bot, or null when they can. */
export function settingsProblem(s: Settings): string | null {
  if (s.token === undefined || s.token === "") return NO_TOKEN;
  if (!SECRET_TOKEN.test(s.secret)) return "TELEGRAM_WEBHOOK_SECRET must be 1-256 letters, digits, _ or - (Telegram's rule); re-run deploy/install.sh after removing it from /srv/household/.env";
  if (new URL(s.publicUrl).protocol !== "https:") return `the house's address ${s.publicUrl} is not https; Telegram only calls https webhooks`;
  return null;
}

/** `status`: which bot, and whether its webhook points at the house. Exit code 0 only when it does. */
export async function showStatus(s: Settings, bot: BotAdmin, print: Print): Promise<number> {
  const expected = webhookUrl(s.publicUrl);
  print(`bot: @${await bot.username()}`);
  const info = await bot.webhookInfo();
  const ok = info.url === expected;
  print(info.url === "" ? "webhook: not set" : `webhook: ${info.url}${ok ? " (this house)" : ` (not this house: expected ${expected})`}`);
  print(`updates: ${info.allowed_updates === undefined ? "all" : info.allowed_updates.join(", ")}`);
  print(`waiting to be delivered: ${info.pending_update_count}`);
  if (info.last_error_message !== undefined) {
    const when = info.last_error_date === undefined ? "" : ` at ${new Date(info.last_error_date * 1000).toISOString()}`;
    print(`last delivery error${when}: ${info.last_error_message}`);
  }
  print(ok ? "connected" : "not connected: run sudo household-telegram connect");
  return ok ? 0 : 1;
}

/** `connect`: point the bot's webhook at the house with the secret, then show the status. */
export async function connect(s: Settings, bot: BotAdmin, print: Print): Promise<number> {
  const problem = settingsProblem(s);
  if (problem !== null) {
    print(problem);
    return 1;
  }
  await bot.setWebhook(webhookUrl(s.publicUrl), s.secret);
  return showStatus(s, bot, print);
}

/**
 * `senders`: everyone the house dropped on Telegram and still doesn't know, newest first: an adult
 * messages the bot, then finds their ID here. An ID given to someone since (`set`) is left out.
 */
export function showSenders(dropped: readonly DroppedSender[], known: ReadonlySet<string>, print: Print): void {
  const senders = dropped.filter((d) => !known.has(d.address));
  if (senders.length === 0) {
    print("nobody unknown has messaged the bot yet: send it a message from your own Telegram, then run this again");
    return;
  }
  print("Telegram user IDs the house didn't know, newest first (their messages were dropped, not kept):");
  for (const d of senders) print(`  ${d.address}  last ${d.lastAt}  ${d.times === 1 ? "once" : `${d.times} times`}`);
  print("Yours is the one at the time you messaged the bot. Add it: sudo household-telegram set <person> <id>");
}
