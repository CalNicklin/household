import { Channel } from "@household/contracts";
import { loadEnv } from "../server/env.ts";
import { TelegramTransport } from "../server/integrations/telegram.ts";
import type { Runtime } from "../server/runtime.ts";
import { connect, NO_TOKEN, parseTelegramCommand, redact, showSenders, showStatus } from "./telegram/admin.ts";

/**
 * CH-2 / CH-3: connect the real house to Telegram, on the server (docs/OPERATIONS.md, "Telegram").
 * `sudo household-telegram <command>` runs this inside the app's container, so it reads the house's own
 * .env: the bot token and webhook secret are never on a command line, and are redacted from all output.
 *
 *   connect                    point the bot's webhook at https://<HOUSEHOLD_DOMAIN>/webhooks/telegram
 *   status                     which bot, and where its webhook points
 *   senders                    Telegram user IDs the house dropped, newest first (to find your own)
 *   set <person> <telegram id> give an adult their Telegram ID (replacing the one they had)
 */
const command = parseTelegramCommand(process.argv.slice(2));
if ("error" in command) {
  console.error(command.error);
  process.exit(2);
}
const env = loadEnv();
const secrets = [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET];
const print = (line: string) => process.stdout.write(`${redact(line, secrets)}\n`);
const settings = { token: env.TELEGRAM_BOT_TOKEN, secret: env.TELEGRAM_WEBHOOK_SECRET, publicUrl: env.PUBLIC_URL };

async function withHouse(work: (rt: Runtime) => Promise<void>): Promise<void> {
  // Loaded only for the commands that read or write the house, so connect and status stay quick.
  const [{ createRuntime }, { realPorts }, { practicePorts }] = await Promise.all([import("../server/runtime.ts"), import("../server/integrations/index.ts"), import("../practice/fakes.ts")]);
  const ports = env.PRACTICE ? practicePorts() : realPorts(env, { now: () => new Date() }, { timeZone: "Europe/London", personForEmail: () => null }).ports;
  const rt = await createRuntime(env, ports);
  try {
    await work(rt);
  } finally {
    await rt.close();
  }
}

try {
  let code = 0;
  if (command.kind === "connect" || command.kind === "status") {
    if (env.TELEGRAM_BOT_TOKEN === undefined || env.TELEGRAM_BOT_TOKEN === "") {
      print(NO_TOKEN);
      process.exit(1);
    }
    const transport = new TelegramTransport({ token: env.TELEGRAM_BOT_TOKEN, apiBase: env.TELEGRAM_API_BASE });
    const bot = { username: () => transport.username(), setWebhook: (url: string, secret: string) => transport.setWebhook(url, secret), webhookInfo: () => transport.webhookInfo() };
    code = command.kind === "connect" ? await connect(settings, bot, print) : await showStatus(settings, bot, print);
  } else if (command.kind === "senders") {
    await withHouse(async (rt) => {
      const api = rt.system("household-telegram");
      const dropped = await api.jobs.droppedSenders({ channel: Channel.telegram });
      // Known means what the webhook knows (CH-3): an ID that maps to an adult now. A sitter's ID is still dropped, so still listed.
      const resolved = await Promise.all(dropped.map(async (d) => ((await api.household.resolveIdentity({ channel: Channel.telegram, address: d.address })) === null ? null : d.address)));
      showSenders(dropped, new Set(resolved.filter((a): a is string => a !== null)), print);
    });
  } else {
    await withHouse(async (rt) => {
      const result = await rt.system("household-telegram").household.setTelegramId({ person: command.person, telegram: command.telegram });
      print(`${result.person}'s Telegram ID is now ${result.telegram}${result.replaced.length > 0 ? ` (was ${result.replaced.join(", ")})` : ""}. Message the bot again: it reaches the house now.`);
    });
  }
  process.exit(code);
} catch (e) {
  console.error(redact(e instanceof Error ? e.message : String(e), secrets));
  process.exit(1);
}
