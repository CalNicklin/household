import { createHash } from "node:crypto";
import { type InboundEmail, Limits } from "@household/contracts";
import { authenticate, type DNSResolver } from "mailauth";
import { simpleParser } from "mailparser";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import { z } from "zod";
import { saveConfirmation } from "./confirmation.ts";
import { forwardingConfirmationCode, provenSenders } from "./verify.ts";

/**
 * HOU-150: the house's own mail receiver. It takes mail for exactly one address, orders@<domain>, and
 * hands each email whose sender it can prove (verify.ts) to the app's email webhook. It never sends
 * mail of any kind: no relay, no reply, no bounce. Mail for anyone else is refused at RCPT; AUTH is
 * switched off, so there is nothing to relay through even with a login.
 *
 * Unproven mail is answered 250 and dropped: refusing it would make the sending server bounce it to
 * the envelope sender, who may be anyone. Only when the app can't be reached is the answer 451, so a
 * real forward is tried again later.
 */
export type ReceiverOptions = {
  /** The receiver's own host name, e.g. orders.example.com; mail is taken for orders@ it only. */
  domain: string;
  webhookUrl: string;
  webhookSecret: string;
  /** Where Gmail's latest forwarding-confirmation code is kept (confirmation.ts). */
  stateDir: string;
  /** STARTTLS with this certificate; none until Caddy has one (never a self-signed one). */
  tls?: { key: Buffer; cert: Buffer } | undefined;
  /** DNS for SPF, DKIM and DMARC; the system resolver unless a test gives one. */
  resolver?: DNSResolver | undefined;
};

const zAnswer = z.object({ outcome: z.string() });
type SmtpError = Error & { responseCode: number };
const smtpError = (responseCode: number, message: string): SmtpError => Object.assign(new Error(message), { responseCode });
const log = (event: string, fields: Record<string, unknown> = {}) => console.info(JSON.stringify({ event, ...fields }));

function recipientFor(domain: string): string {
  return `orders@${domain}`.toLowerCase();
}

// One email is checked and parsed at a time, whatever the number of sessions.
let queue: Promise<unknown> = Promise.resolve();

/** The answer to DATA: null for 250, or the refusal. Never throws. */
async function take(options: ReceiverOptions, stream: SMTPServerDataStream, session: SMTPServerSession): Promise<SmtpError | null> {
  const raw = await readMessage(stream).catch(() => undefined);
  if (raw === undefined) return smtpError(451, "4.3.0 try again later");
  if (raw === null) {
    log("mail-refused-size");
    return smtpError(552, "5.3.4 message too big");
  }
  const handled = queue.then(() => receive(options, raw, session));
  queue = handled.catch(() => undefined);
  try {
    await handled;
    return null;
  } catch (error) {
    log("mail-deferred", { reason: error instanceof Error ? error.message : String(error) });
    return smtpError(451, "4.3.0 try again later");
  }
}

export function createReceiver(options: ReceiverOptions): SMTPServer {
  const recipient = recipientFor(options.domain);
  const server = new SMTPServer({
    name: options.domain,
    banner: "orders only; nothing is relayed",
    // limit: inboundEmailMaxBytes
    size: Limits.inboundEmailMaxBytes.value,
    // limit: inboundEmailMaxClients
    maxClients: Limits.inboundEmailMaxClients.value,
    // limit: inboundEmailSocketMs
    socketTimeout: Limits.inboundEmailSocketMs.value,
    // No AUTH at all, so no login can make it relay; STARTTLS only with Caddy's real certificate.
    disabledCommands: options.tls === undefined ? ["AUTH", "STARTTLS"] : ["AUTH"],
    authOptional: true,
    disableReverseLookup: true,
    logger: false,
    ...(options.tls === undefined ? {} : { key: options.tls.key, cert: options.tls.cert }),
    onRcptTo(address, _session, callback) {
      if (address.address.toLowerCase() === recipient) return callback();
      log("mail-refused-recipient");
      callback(smtpError(550, "5.1.1 no such mailbox here, and nothing is relayed"));
    },
    onData(stream, session, callback) {
      void (async () => callback(await take(options, stream, session)))();
    },
  });
  server.on("error", (error) => log("mail-server-error", { reason: error.message }));
  return server;
}

/** The whole message, or null when it is over the size limit (read to the end, never kept). */
function readMessage(stream: SMTPServerDataStream): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // limit: inboundEmailMaxBytes
      if (size <= Limits.inboundEmailMaxBytes.value) chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(stream.sizeExceeded ? null : Buffer.concat(chunks)));
  });
}

/** `Screwfix <orders@screwfix.com>`, as the shop wrote it (mailparser's own text quotes the name). */
const authorOf = (author: { name: string; address?: string | undefined } | undefined): string => {
  if (author === undefined) return "";
  const address = author.address ?? "";
  return author.name === "" ? address : `${author.name.replace(/[<>"\r\n]/g, "")} <${address}>`;
};

async function receive(options: ReceiverOptions, raw: Buffer, session: SMTPServerSession): Promise<void> {
  const envelopeFrom = session.envelope.mailFrom === false ? "" : session.envelope.mailFrom.address;
  const ip = session.remoteAddress.replace(/^::ffff:/, "");
  const auth = await authenticate(raw, {
    ip,
    helo: session.hostNameAppearsAs,
    sender: envelopeFrom,
    mta: options.domain,
    disableArc: true,
    disableBimi: true,
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
  });
  const mail = await simpleParser(raw, { skipImageLinks: true });
  const subject = mail.subject ?? "";

  const code = forwardingConfirmationCode(auth, subject);
  if (code !== null) {
    await saveConfirmation(options.stateDir, code, new Date());
    log("mail-forwarding-confirmation");
    return;
  }
  const senders = provenSenders(auth, envelopeFrom);
  if (senders.length === 0) {
    // CH-3: dropped and logged, with no reply and no bounce. Only the results, never an address.
    log("mail-dropped-unproven-sender", { spf: auth.spf === false ? "none" : auth.spf.status.result, dkim: auth.dkim.results.map((r) => r.status.result), dmarc: auth.dmarc === false ? "none" : auth.dmarc.status.result });
    return;
  }
  const email: InboundEmail = {
    from: authorOf(mail.from?.value[0]),
    to: recipientFor(options.domain),
    subject,
    text: (mail.text ?? "").slice(0, Limits.maxInboundTextChars.value),
    messageId: mail.messageId ?? `<${createHash("sha256").update(raw).digest("hex")}@${options.domain}>`,
    provenSenders: senders.map((s) => s.address),
  };
  const response = await fetch(options.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-secret": options.webhookSecret },
    body: JSON.stringify(email),
    // limit: inboundEmailWebhookMs
    signal: AbortSignal.timeout(Limits.inboundEmailWebhookMs.value),
  });
  if (!response.ok) throw new Error(`the app answered ${response.status}`);
  const { outcome } = zAnswer.parse(await response.json());
  log("mail-handed-to-app", { outcome, proof: senders.map((s) => s.proof) });
}
