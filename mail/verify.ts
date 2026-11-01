import { SenderProof } from "@household/contracts";
import type { AuthenticateResult } from "mailauth";

/**
 * HOU-150 / CH-3: who sent an email on to orders@, proven, not claimed. Anyone can send to orders@,
 * and a forwarded order's From is the shop, so From, To and the forwarding headers (X-Forwarded-For,
 * X-Forwarded-To, Delivered-To, Resent-From) say only what the sender chose to write. An address counts
 * only when its own domain vouches for it:
 *
 * - the envelope sender passed SPF for its own domain (SPF checks exactly that domain). Gmail's
 *   auto-forward sends from `<user>+caf_=<forward-to, @ as =>@gmail.com` out of Google's servers, and
 *   Gmail only lets an account send with its own envelope address, so `cal+caf_=…@gmail.com` with SPF
 *   passing is cal@gmail.com forwarding;
 * - or the From header's domain is exactly the domain of a passing DKIM signature (DMARC's DKIM
 *   alignment, strict): someone forwarding by hand from their own mailbox, whose provider signs only
 *   its own users' From. A DMARC fail rules that out whatever else passed. SPF alone never proves a
 *   From: it vouches for a domain's servers, and on gmail.com those send for every Gmail user.
 *
 * Whether the address is one of us is the app's call (CH-3); this only says which addresses it may
 * consider. An email with none is dropped before it reaches the app.
 */
export type ProvenSender = { address: string; proof: SenderProof };

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** `cal+caf_=orders=orders.example.com@gmail.com` → `cal@gmail.com`; any other address as it is. */
export function forwarderOf(envelope: string): string {
  const at = envelope.lastIndexOf("@");
  if (at < 1) return envelope.toLowerCase();
  const local = envelope.slice(0, at).replace(/\+caf_=.*$/i, "");
  return `${local}@${envelope.slice(at + 1)}`.toLowerCase();
}

export function provenSenders(auth: AuthenticateResult, envelopeFrom: string): ProvenSender[] {
  const proven: ProvenSender[] = [];
  const add = (address: string, proof: SenderProof) => {
    if (!proven.some((p) => p.address === address)) proven.push({ address, proof });
  };
  const spfPassed = envelopeFrom.includes("@") && auth.spf !== false && auth.spf.status.result === "pass" && auth.spf.domain.toLowerCase() === domainOf(envelopeFrom);
  if (spfPassed) add(forwarderOf(envelopeFrom), SenderProof.envelopeSpf);

  const { headerFrom, fromFields, fromSyntax, results } = auth.dkim;
  const author = fromFields === 1 && fromSyntax === "valid" && headerFrom.length === 1 ? headerFrom[0]?.toLowerCase() : undefined;
  const dmarcFailed = auth.dmarc !== false && auth.dmarc.status.result === "fail";
  if (author !== undefined && author.includes("@") && !dmarcFailed) {
    const domain = domainOf(author);
    // A signature covering only the first l= bytes of the body would let anyone append to it.
    const dkimAligned = results.some((r) => r.status.result === "pass" && r.signingDomain?.toLowerCase() === domain && r.canonBodyLengthLimited !== true);
    if (dkimAligned) add(author, SenderProof.authorDkim);
  }
  return proven;
}

/** The sender of Gmail's forwarding confirmation, and its subject: "(#123456789) Gmail Forwarding Confirmation - …". */
const GMAIL_CONFIRMATION_FROM = "forwarding-noreply@google.com";
const GMAIL_CONFIRMATION_SUBJECT = /^\(#(\d{6,12})\) /;

/**
 * HOU-150: the code in Gmail's forwarding confirmation, when the email really is Gmail's: From is
 * forwarding-noreply@google.com and a passing DKIM signature is google.com's. Anything else is null.
 */
export function forwardingConfirmationCode(auth: AuthenticateResult, subject: string): string | null {
  const proven = provenSenders(auth, "");
  if (proven.length !== 1 || proven[0]?.address !== GMAIL_CONFIRMATION_FROM) return null;
  return GMAIL_CONFIRMATION_SUBJECT.exec(subject)?.[1] ?? null;
}
