import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { type InboundEmail, Limits, SenderProof } from "@household/contracts";
import { authenticate, type AuthenticateResult, type DNSResolver } from "mailauth";
import { simpleParser } from "mailparser";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import { z } from "zod";
import { saveConfirmation } from "./confirmation.ts";
import { forwardingConfirmation, type ProvenSender, provenSenders } from "./verify.ts";

/**
 * HOU-150: the house's own mail receiver. It takes mail for exactly one address, orders@<domain>, and
 * hands each email whose sender it can prove (verify.ts) to the app's email webhook. It never sends
 * mail of any kind: no relay, no reply, no bounce. Mail for anyone else is refused at RCPT; AUTH is
 * switched off, so there is nothing to relay through even with a login.
 *
 * Unproven mail is answered 250 and dropped: refusing it would make the sending server bounce it to
 * the envelope sender, who may be anyone. The answer is 451 (try again later) only when the receiver
 * couldn't decide: a DNS lookup failed for now, the checks ran out of time, or the app can't be reached.
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
  /** DNS for SPF, DKIM, DMARC and ARC; the system resolver unless a test gives one. */
  resolver?: DNSResolver | undefined;
};

const zAnswer = z.object({ outcome: z.string() });
type SmtpError = Error & { responseCode: number };
const smtpError = (responseCode: number, message: string): SmtpError => Object.assign(new Error(message), { responseCode });
const log = (event: string, fields: Record<string, unknown> = {}) => console.info(JSON.stringify({ event, ...fields }));
const recipientFor = (domain: string): string => `orders@${domain}`.toLowerCase();
/** The container's own healthcheck connects from here; anything else counts as the internet. */
const isHealthcheck = (address: string): boolean => address === "127.0.0.1" || address === "::1";

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
  const handled = queue.then(() => withDeadline((signal) => receive(options, raw, session, signal)));
  queue = handled.catch(() => undefined);
  try {
    await handled;
    return null;
  } catch (error) {
    log("mail-deferred", { reason: error instanceof Error ? error.message : String(error) });
    return smtpError(451, "4.3.0 try again later");
  }
}

/**
 * The work, given until inboundEmailCheckMs. Past it the answer is 451 and the next message starts; the
 * abandoned work is told to stop (`signal`) and does nothing more at its next step: it never saves a
 * code or posts to the app after the sender was told to try again.
 */
function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  // limit: inboundEmailCheckMs
  const signal = AbortSignal.timeout(Limits.inboundEmailCheckMs.value);
  const deadline = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("the checks took too long")), { once: true }));
  return Promise.race([work(signal), deadline]);
}

export function createReceiver(options: ReceiverOptions): SMTPServer {
  const recipient = recipientFor(options.domain);
  const messages = new Map<string, number>();
  const seats = new Map<string, string>();
  const server = new SMTPServer({
    name: options.domain,
    banner: "orders only; nothing is relayed",
    // limit: inboundEmailMaxBytes
    size: Limits.inboundEmailMaxBytes.value,
    // Sessions are limited by seat() in onConnect, not by smtp-server's maxClients, which would also
    // count the refused ones and the healthcheck.
    // limit: inboundEmailSocketMs
    socketTimeout: Limits.inboundEmailSocketMs.value,
    // No AUTH at all, so no login can make it relay; STARTTLS only with Caddy's real certificate.
    disabledCommands: options.tls === undefined ? ["AUTH", "STARTTLS"] : ["AUTH"],
    authOptional: true,
    disableReverseLookup: true,
    logger: false,
    ...(options.tls === undefined ? {} : { key: options.tls.key, cert: options.tls.cert }),
    onConnect(session, callback) {
      callback(seat(seats, session));
    },
    onMailFrom(_address, session, callback) {
      const count = (messages.get(session.id) ?? 0) + 1;
      messages.set(session.id, count);
      // limit: inboundEmailMessagesPerSession
      if (count > Limits.inboundEmailMessagesPerSession.value) return callback(smtpError(421, "4.7.0 too many messages in one session"));
      callback();
    },
    onRcptTo(address, _session, callback) {
      if (address.address.toLowerCase() === recipient) return callback();
      log("mail-refused-recipient");
      callback(smtpError(550, "5.1.1 no such mailbox here, and nothing is relayed"));
    },
    onData(stream, session, callback) {
      void (async () => callback(await take(options, stream, session)))();
    },
    onClose(session) {
      messages.delete(session.id);
      seats.delete(session.id);
    },
  });
  limitLifetime(server);
  server.on("error", (error) => log("mail-server-error", { reason: error.message }));
  return server;
}

/**
 * At most inboundEmailMaxClients sessions from the internet at once, inboundEmailClientsPerAddress of them
 * from one address. The container's own healthcheck (127.0.0.1) always gets in, so a flood can't make the
 * house's deploy fail. Counted by SMTP session (onConnect and onClose), which also ends for a session that
 * went over to TLS, whose plain socket never says it closed.
 */
function seat(seats: Map<string, string>, session: SMTPServerSession): SmtpError | null {
  const address = session.remoteAddress.replace(/^::ffff:/, "");
  if (isHealthcheck(address)) return null;
  const fromHere = [...seats.values()].filter((a) => a === address).length;
  // limit: inboundEmailMaxClients
  const full = seats.size >= Limits.inboundEmailMaxClients.value;
  // limit: inboundEmailClientsPerAddress
  if (full || fromHere >= Limits.inboundEmailClientsPerAddress.value) {
    log("mail-refused-connection", { open: seats.size, fromThisAddress: fromHere });
    return smtpError(421, "4.7.0 too many connections, try again later");
  }
  seats.set(session.id, address);
  return null;
}

/** Every connection is closed after inboundEmailSessionMs, however busy it keeps itself. */
function limitLifetime(server: SMTPServer): void {
  server.server.on("connection", (socket: Socket) => {
    // limit: inboundEmailSessionMs
    const lifetime = setTimeout(() => socket.destroy(), Limits.inboundEmailSessionMs.value);
    lifetime.unref();
    socket.once("close", () => clearTimeout(lifetime));
  });
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

/** DKIM-Signature and ARC headers in the message's header block: each costs a DNS lookup and a body hash. */
function signatureCount(raw: Buffer): number {
  const end = raw.indexOf("\r\n\r\n");
  const header = raw.subarray(0, end === -1 ? raw.length : end).toString("latin1");
  return header.match(/^(dkim-signature|arc-seal|arc-message-signature|arc-authentication-results):/gim)?.length ?? 0;
}

const TEMPORARY = new Set(["temperror", "temperr"]);
/** A DNS lookup failed for now: the sender may well be proven once it answers, so ask for a retry. */
function undecided(auth: AuthenticateResult): boolean {
  const results = [auth.spf === false ? "" : auth.spf.status.result, auth.arc === false ? "" : auth.arc.status.result, ...auth.dkim.results.map((r) => r.status.result)];
  return results.some((r) => TEMPORARY.has(r));
}

/** `Screwfix <orders@screwfix.com>`, as the shop wrote it (mailparser's own text quotes the name). */
const authorOf = (author: { name: string; address?: string | undefined } | undefined): string => {
  if (author === undefined) return "";
  const address = author.address ?? "";
  return author.name === "" ? address : `${author.name.replace(/[<>"\r\n]/g, "")} <${address}>`;
};

/** In a forward by hand, the shop is the From of the forwarded message ("---- Forwarded message ----\nFrom: …"). */
const forwardedAuthor = (text: string): string | null => /^[>\s*]*From:\s*\**\s*(.+?)\s*$/im.exec(text)?.[1] ?? null;

async function receive(options: ReceiverOptions, raw: Buffer, session: SMTPServerSession, signal: AbortSignal): Promise<void> {
  const recipient = recipientFor(options.domain);
  // limit: inboundEmailMaxSignatures
  if (signatureCount(raw) > Limits.inboundEmailMaxSignatures.value) {
    log("mail-dropped-unproven-sender", { reason: "too many signatures" });
    return;
  }
  const envelopeFrom = session.envelope.mailFrom === false ? "" : session.envelope.mailFrom.address;
  const auth = await authenticate(raw, {
    ip: session.remoteAddress.replace(/^::ffff:/, ""),
    helo: session.hostNameAppearsAs,
    sender: envelopeFrom,
    mta: options.domain,
    disableBimi: true,
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
  });
  signal.throwIfAborted();
  const senders = provenSenders(auth, envelopeFrom, recipient);
  if (senders.length === 0) {
    if (undecided(auth)) throw new Error("a DNS lookup failed for now");
    // CH-3: dropped and logged, with no reply and no bounce. Only the results, never an address.
    log("mail-dropped-unproven-sender", { spf: auth.spf === false ? "none" : auth.spf.status.result, dkim: auth.dkim.results.map((r) => r.status.result), arc: auth.arc === false ? "none" : auth.arc.status.result });
    return;
  }
  // Only a proven email is parsed.
  const mail = await simpleParser(raw, { skipImageLinks: true });
  signal.throwIfAborted();
  const { confirmation, ignored } = forwardingConfirmation(senders, { subject: mail.subject ?? "", text: mail.text ?? "", html: typeof mail.html === "string" ? mail.html : "" });
  if (confirmation !== null) {
    await saveConfirmation(options.stateDir, confirmation, new Date());
    log("mail-forwarding-confirmation", { code: confirmation.code !== null, link: confirmation.link !== null });
    return;
  }
  // HOU-169: a google.com-proven email that isn't recognised as the confirmation: its shape, no content.
  if (ignored !== null) log("mail-google-not-confirmation", ignored);
  await handToApp(options, toEmail(mail, raw, senders, recipient, options.domain), senders, signal);
}

function toEmail(mail: Awaited<ReturnType<typeof simpleParser>>, raw: Buffer, senders: ProvenSender[], recipient: string, domain: string): InboundEmail {
  const text = mail.text ?? "";
  // A forward by hand comes From the person; the shop is in the forwarded message's own From line.
  const byHand = senders.every((s) => s.proof === SenderProof.authorDkim);
  return {
    from: (byHand ? forwardedAuthor(text) : null) ?? authorOf(mail.from?.value[0]),
    to: recipient,
    subject: mail.subject ?? "",
    // Only bounds what is posted. The app adds From and Subject in front and cuts the whole line to
    // maxInboundTextChars itself (server/adapters/email/index.ts), so a text this long still fits.
    text: text.slice(0, Limits.maxInboundTextChars.value),
    messageId: mail.messageId ?? `<${createHash("sha256").update(raw).digest("hex")}@${domain}>`,
    provenSenders: senders.map((s) => s.address),
  };
}

async function handToApp(options: ReceiverOptions, email: InboundEmail, senders: ProvenSender[], deadline: AbortSignal): Promise<void> {
  const response = await fetch(options.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-secret": options.webhookSecret },
    body: JSON.stringify(email),
    // limit: inboundEmailWebhookMs
    signal: AbortSignal.any([deadline, AbortSignal.timeout(Limits.inboundEmailWebhookMs.value)]),
  });
  if (!response.ok) throw new Error(`the app answered ${response.status}`);
  const { outcome } = zAnswer.parse(await response.json());
  log("mail-handed-to-app", { outcome, proof: senders.map((s) => s.proof) });
}
