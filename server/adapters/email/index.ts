import { AttachmentKind, Channel } from "@household/contracts";
import { z } from "zod";
import { accept, dropUnknown, identify } from "../../coordinator/accept.ts";
import { looksLikeOrder } from "../../rules/orders.ts";
import type { Runtime } from "../../runtime.ts";
import type { Adapter } from "../registry.ts";

/** What an inbound-mail webhook (Cloudflare Email Routing, Postmark inbound, …) posts. */
const zInboundEmail = z.object({
  from: z.string(),
  to: z.union([z.string(), z.array(z.string())]),
  subject: z.string().default(""),
  text: z.string().default(""),
  messageId: z.string().min(1),
});

const addressOf = (header: string): string => (/<([^>]+)>/.exec(header)?.[1] ?? header).trim().toLowerCase();

export type EmailOutcome = "accepted" | "ignored" | "dropped";

/**
 * Email as a channel (CH-2, CAP-9). The sender is whichever of from/to is one of us (CH-3). Only
 * order confirmations get past the edge; anything else is never stored or read further (PRV-3).
 */
export async function handleEmail(rt: Runtime, raw: unknown): Promise<EmailOutcome> {
  const email = zInboundEmail.parse(raw);
  const candidates = [email.from, ...(Array.isArray(email.to) ? email.to : [email.to])].map(addressOf);
  let person: string | null = null;
  for (const address of candidates) {
    person = await identify(rt, Channel.email, address);
    if (person !== null) break;
  }
  if (!looksLikeOrder(email.subject, email.text)) {
    console.info(JSON.stringify({ event: "ignored non-order email" }));
    return "ignored";
  }
  if (person === null) {
    await dropUnknown(rt, Channel.email, addressOf(email.from));
    return "dropped";
  }
  await accept(rt, {
    household: rt.env.HOUSEHOLD_ID,
    person,
    channel: Channel.email,
    // One line: the agent prompt carries the message as a single `Message:` line.
    text: `From: ${email.from} | Subject: ${email.subject} | ${email.text.replace(/\s*\n\s*/g, " ")}`,
    attachments: [{ kind: AttachmentKind.email, orderLike: true }],
    dedupeKey: `email:${email.messageId}`,
    receivedAt: rt.ports.clock.now().toISOString(),
  });
  return "accepted";
}

export const adapter: Adapter = {
  name: "email",
  routes: (app, rt) => {
    app.post("/webhooks/email", async (c) => {
      if (c.req.header("x-webhook-secret") !== rt.env.EMAIL_WEBHOOK_SECRET) return c.json({ error: "bad secret" }, 401);
      return c.json({ outcome: await handleEmail(rt, await c.req.json()) });
    });
  },
};
