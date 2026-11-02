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

/**
 * HOU-150 / HOU-169: Gmail's forwarding confirmation. Who sent it is proven strictly: the From address is
 * @google.com and a passing google.com DKIM signature is aligned with it (author-dkim, above). Only what
 * a proven Google message says is read tolerantly: any forwarding/noreply sender at google.com, the
 * code anywhere in the (already RFC 2047-decoded) subject or else in the body, and the confirmation link.
 */
// Exact addresses, never a pattern: other google.com senders (Drive shares, comments) carry text that
// anyone can choose, so they must never count as the confirmation, however they are signed.
const GOOGLE_CONFIRMATION_SENDERS = new Set(["forwarding-noreply@google.com", "mail-noreply@google.com"]);
const SUBJECT_CODE = /#\s*(\d{6,12})(?!\d)/;
const BODY_CODE = /\bcode\b[^\d\n]{0,20}?(\d{6,12})(?!\d)/i;
// The one-time link: mail-settings.google.com/…, or mail.google.com/… with Gmail's vf- token. URL
// characters only, so nothing printed from it can reach a terminal as a control sequence. confirmation.ts
// checks what it saves against the same pattern.
const URL_CHARS = "[A-Za-z0-9\\-._~:/?#@!$&()*+,;=%]";
const LINK_SOURCE = `https://(?:mail-settings\\.google\\.com/${URL_CHARS}+|mail\\.google\\.com/${URL_CHARS}*vf-${URL_CHARS}*)`;
const MAX_CONFIRMATION_LINK = 2000;
const CONFIRMATION_LINK = new RegExp(LINK_SOURCE);
export const isConfirmationLink = (link: string): boolean => link.length <= MAX_CONFIRMATION_LINK && new RegExp(`^${LINK_SOURCE}$`).test(link);

export type ParsedMail = { subject: string; text: string; html: string };
export type Confirmation = { code: string | null; link: string | null };
/** The shape of a google.com-proven message that wasn't recognised: no content but digit-masked subject. */
export type GoogleShape = { from: string; subjectMatched: boolean; bodyMatched: boolean; subject: string };

const googleAuthor = (proven: ProvenSender[]): string | undefined => proven.find((p) => p.proof === SenderProof.authorDkim && p.address.endsWith("@google.com"))?.address;
const htmlText = (html: string): string =>
  html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&");
const linkIn = (mail: ParsedMail): string | null => {
  const link = CONFIRMATION_LINK.exec(mail.text)?.[0] ?? CONFIRMATION_LINK.exec(mail.html.replace(/&amp;/gi, "&"))?.[0] ?? null;
  return link !== null && isConfirmationLink(link) ? link : null;
};

/**
 * Gmail's forwarding confirmation, when the email really is Google's: its code and link (either may be
 * missing, not both). Otherwise `ignored` holds the shape of a google.com-proven message for the log,
 * so the next unrecognised one can be diagnosed; it is null for anyone else's mail.
 */
export function forwardingConfirmation(proven: ProvenSender[], mail: ParsedMail): { confirmation: Confirmation | null; ignored: GoogleShape | null } {
  const from = googleAuthor(proven);
  if (from === undefined) return { confirmation: null, ignored: null };
  const subjectCode = SUBJECT_CODE.exec(mail.subject)?.[1] ?? null;
  const bodyCode = BODY_CODE.exec(mail.text)?.[1] ?? BODY_CODE.exec(htmlText(mail.html))?.[1] ?? null;
  const code = subjectCode ?? bodyCode;
  const link = linkIn(mail);
  if (GOOGLE_CONFIRMATION_SENDERS.has(from) && (code !== null || link !== null)) return { confirmation: { code, link }, ignored: null };
  // Control characters out and length bounded: the subject reaches the log, its digits never do.
  const subject = mail.subject.replace(/\d/g, "#").replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 200);
  return { confirmation: null, ignored: { from, subjectMatched: subjectCode !== null, bodyMatched: bodyCode !== null, subject } };
}
