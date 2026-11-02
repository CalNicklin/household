import { SenderProof } from "@household/contracts";
import type { AuthenticateResult } from "mailauth";

/**
 * HOU-150 / CH-3: who sent an email on to orders@, proven, not claimed. Anyone can send to orders@,
 * and a forwarded order's From is the shop, so From, To and the forwarding headers (X-Forwarded-For,
 * X-Forwarded-To, Delivered-To, Resent-From) say only what the sender chose to write. An address counts
 * only when its own provider vouches for it, in one of two shapes:
 *
 * - Gmail's auto-forward to us: the envelope sender is `<user>+caf_=<our address, @ as =>@gmail.com`
 *   (or googlemail.com), aimed at our own address, SPF passes for gmail.com, and the message carries a
 *   passing ARC chain whose newest set is google.com's (Gmail seals what it forwards). Gmail lets an
 *   account send only with its own envelope address, so that is `<user>@gmail.com` forwarding. An SPF
 *   pass alone proves no mailbox: on shared servers (Google's, Microsoft's, an ISP's) one customer can
 *   pass it for another, so no other envelope counts.
 * - A forward by hand: the From header's domain is exactly the domain of a passing DKIM signature
 *   (DMARC's DKIM alignment, strict) whose signed To or Cc names our address, so an old email of
 *   theirs re-sent to us doesn't count. A DMARC fail rules it out whatever else passed.
 *
 * Whether the address is one of us is the app's call (CH-3); this only says which addresses it may
 * consider. An email with none is dropped before it reaches the app.
 */
export type ProvenSender = { address: string; proof: SenderProof };

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/**
 * `cal+caf_=orders=orders.example.com@gmail.com`, forwarding to orders@orders.example.com → `cal@gmail.com`.
 * Null for any other envelope, or one forwarding somewhere else.
 */
export function gmailForwarder(envelope: string, recipient: string): string | null {
  const m = /^(.+?)\+caf_=(.+)@([^@]+)$/i.exec(envelope);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined || !GMAIL.has(m[3].toLowerCase())) return null;
  const target = m[2].replace(/=([^=]*)$/, "@$1").toLowerCase();
  return target === recipient.toLowerCase() ? `${m[1]}@${m[3]}`.toLowerCase() : null;
}

export function provenSenders(auth: AuthenticateResult, envelopeFrom: string, recipient: string): ProvenSender[] {
  const proven: ProvenSender[] = [];
  const forwarder = gmailForwarder(envelopeFrom, recipient);
  const spfPassed = auth.spf !== false && auth.spf.status.result === "pass" && auth.spf.domain.toLowerCase() === domainOf(envelopeFrom);
  const sealedByGoogle = auth.arc !== false && auth.arc.status.result === "pass" && auth.arc.signature !== false && auth.arc.signature?.signingDomain?.toLowerCase() === "google.com";
  if (forwarder !== null && spfPassed && sealedByGoogle) proven.push({ address: forwarder, proof: SenderProof.envelopeSpf });

  const { headerFrom, fromFields, fromSyntax, results } = auth.dkim;
  const author = fromFields === 1 && fromSyntax === "valid" && headerFrom.length === 1 ? headerFrom[0]?.toLowerCase() : undefined;
  const dmarcFailed = auth.dmarc !== false && auth.dmarc.status.result === "fail";
  if (author === undefined || !author.includes("@") || dmarcFailed || proven.some((p) => p.address === author)) return proven;
  const domain = domainOf(author);
  const signedForUs = (lines: string[] | undefined) => (lines ?? []).some((line) => /^(to|cc):/i.test(line) && line.toLowerCase().includes(recipient.toLowerCase()));
  // A signature covering only the first l= bytes of the body would let anyone append to it.
  const aligned = results.some((r) => r.status.result === "pass" && r.signingDomain?.toLowerCase() === domain && r.canonBodyLengthLimited !== true && signedForUs(r.signingHeaders?.headers));
  if (aligned) proven.push({ address: author, proof: SenderProof.authorDkim });
  return proven;
}

/** The sender of Gmail's forwarding confirmation, and its subject: "(#123456789) Gmail Forwarding Confirmation - …". */
const GMAIL_CONFIRMATION_FROM = "forwarding-noreply@google.com";
const GMAIL_CONFIRMATION_SUBJECT = /^\(#(\d{6,12})\) /;

/**
 * HOU-150: the code in Gmail's forwarding confirmation, when the email really is Gmail's: From is
 * forwarding-noreply@google.com and a passing DKIM signature is google.com's. Anything else is null.
 */
export function forwardingConfirmationCode(proven: ProvenSender[], subject: string): string | null {
  if (!proven.some((p) => p.address === GMAIL_CONFIRMATION_FROM && p.proof === SenderProof.authorDkim)) return null;
  return GMAIL_CONFIRMATION_SUBJECT.exec(subject)?.[1] ?? null;
}
