import { SenderProof } from "@household/contracts";
import { authenticate } from "mailauth";
import { simpleParser } from "mailparser";
import { beforeAll, describe, expect, test } from "vitest";
import { fixtureWorld, gmailConfirmation, gmailForwarded, screwfixOrder, signed } from "./testing.ts";
import { forwardingConfirmation, gmailForwarder, type ParsedMail, provenSenders } from "./verify.ts";

/**
 * HOU-150 / CH-3: who forwarded an email to orders@ is proven by the forwarder's own provider (Gmail's
 * auto-forward shape: envelope SPF and Google's ARC seal; or a hand-forward's aligned DKIM signature
 * naming us), never by what the headers say.
 */
const world = fixtureWorld();
const ORDERS = "orders@orders.example.test";
// Google's mail servers (inside Google's SPF range), and someone else's.
const GOOGLE = { ip: "209.85.220.41", helo: "mail-sor-f41.google.com" };
const ELSEWHERE = { ip: "203.0.113.66", helo: "mx.evil.test" };

const check = async (message: string, envelopeFrom: string, from: { ip: string; helo: string }) => {
  const auth = await authenticate(message, { ...from, sender: envelopeFrom, mta: "orders.example.test", disableBimi: true, resolver: world.resolver });
  return { auth, proven: provenSenders(auth, envelopeFrom, ORDERS) };
};
const handForward = (to: string) => ["From: Cal <cal@gmail.com>", `To: ${to}`, "Subject: Fwd: Your Screwfix order is confirmed", "Message-ID: <fwd-1@mail.gmail.com>", "", "---------- Forwarded message ---------", "From: Screwfix <orders@screwfix.com>", "Arriving Thursday 5 November between 8am and 1pm.", ""].join("\r\n");
let shopMessage: string;
beforeAll(async () => {
  shopMessage = await signed(screwfixOrder("cal@gmail.com"), world.signer.shop);
});

describe("who forwarded it", () => {
  test("[CH-3] Gmail's auto-forward: cal+caf_=<us>@gmail.com, Google's SPF and Google's ARC seal, is cal@gmail.com", async () => {
    const forwarded = await gmailForwarded(shopMessage, "cal@gmail.com", ORDERS, world.signer.googleArc);
    expect(forwarded.envelopeFrom).toBe("cal+caf_=orders=orders.example.test@gmail.com");
    const { proven, auth } = await check(forwarded.message, forwarded.envelopeFrom, GOOGLE);
    expect(auth.arc && auth.arc.status.result).toBe("pass");
    // The shop's signature verifies, but it names cal@gmail.com, not us: only the forwarder is proven.
    expect(proven).toEqual([{ address: "cal@gmail.com", proof: SenderProof.envelopeSpf }]);
  });

  test("[CH-3] the same forward sent from somewhere that isn't Google: cal is not proven", async () => {
    const forwarded = await gmailForwarded(shopMessage, "cal@gmail.com", ORDERS, world.signer.googleArc);
    const { proven, auth } = await check(forwarded.message, forwarded.envelopeFrom, ELSEWHERE);
    expect(auth.spf && auth.spf.status.result).not.toBe("pass");
    expect(proven).toEqual([]);
  });

  test("[CH-3] Google's SPF without Google's ARC seal (another Google service, a relay) proves no one", async () => {
    const forwarded = await gmailForwarded(shopMessage, "cal@gmail.com", ORDERS, world.signer.googleArc);
    const unsealed = forwarded.message.replace(/^ARC-[\s\S]*?\r\n(?=Delivered-To:)/m, "");
    expect(unsealed).not.toContain("ARC-Seal");
    expect((await check(unsealed, forwarded.envelopeFrom, GOOGLE)).proven).toEqual([]);
    const sealedByOther = await gmailForwarded(shopMessage, "cal@gmail.com", ORDERS, world.signer.evil);
    expect((await check(sealedByOther.message, sealedByOther.envelopeFrom, GOOGLE)).proven).toEqual([]);
  });

  test("[CH-3] a Gmail forward aimed somewhere else, or a +caf_ envelope on another domain, proves no one", async () => {
    const elsewhere = await gmailForwarded(shopMessage, "cal@gmail.com", "orders@other.example", world.signer.googleArc);
    expect((await check(elsewhere.message, elsewhere.envelopeFrom, GOOGLE)).proven).toEqual([]);
    const forwarded = await gmailForwarded(shopMessage, "cal@gmail.com", ORDERS, world.signer.googleArc);
    // evil.test's SPF passes for its own servers; the shape alone is not Gmail's.
    expect((await check(forwarded.message, "cal+caf_=orders=orders.example.test@evil.test", { ip: "203.0.113.5", helo: "mx.evil.test" })).proven).toEqual([]);
  });

  test("[CH-3] spoofed forwarding headers from the spoofer's own server prove nobody", async () => {
    const message = [`X-Forwarded-To: ${ORDERS}`, `X-Forwarded-For: cal@gmail.com ${ORDERS}`, "Delivered-To: cal@gmail.com", "Resent-From: cal@gmail.com", "From: Cal <cal@gmail.com>", `To: ${ORDERS}`, "Subject: Your Screwfix order is confirmed", "Message-ID: <spoof-1@evil.test>", "", "Arriving Thursday 5 November between 8am and 1pm.", ""].join("\r\n");
    const { proven, auth } = await check(message, "mallory@evil.test", ELSEWHERE);
    expect(auth.dmarc && auth.dmarc.status.result).toBe("fail");
    expect(proven).toEqual([]);
  });

  test("[CH-3] a stranger's own Gmail forwarding a message that claims to be cal's proves only the stranger", async () => {
    const claims = await signed(screwfixOrder(ORDERS).replace("From: Screwfix <orders@screwfix.com>", "From: Cal <cal@gmail.com>"), world.signer.evil);
    const forwarded = await gmailForwarded(claims, "mallory@gmail.com", ORDERS, world.signer.googleArc);
    const { proven } = await check(forwarded.message.replace("X-Forwarded-For: mallory@gmail.com", "X-Forwarded-For: cal@gmail.com"), forwarded.envelopeFrom, GOOGLE);
    expect(proven).toEqual([{ address: "mallory@gmail.com", proof: SenderProof.envelopeSpf }]);
  });

  test("[CH-3] a forward by hand: From cal@gmail.com, gmail.com's signature over a To that names us, is cal", async () => {
    const message = await signed(handForward(ORDERS), world.signer.gmail);
    // From anywhere: the signature is the proof, not the server.
    expect((await check(message, "", ELSEWHERE)).proven).toEqual([{ address: "cal@gmail.com", proof: SenderProof.authorDkim }]);
  });

  test("[CH-3] an old signed email of cal's re-sent to us, another domain's signature, or a changed body proves nothing", async () => {
    const toSomeoneElse = await signed(handForward("seller@shop.example"), world.signer.gmail);
    expect((await check(toSomeoneElse.replace("To: seller@shop.example", `To: ${ORDERS}`), "", ELSEWHERE)).proven).toEqual([]);
    expect((await check(toSomeoneElse, "", ELSEWHERE)).proven).toEqual([]);
    expect((await check(await signed(handForward(ORDERS), world.signer.evil), "", ELSEWHERE)).proven).toEqual([]);
    const genuine = await signed(handForward(ORDERS), world.signer.gmail);
    expect((await check(genuine.replace("between 8am and 1pm", "between 2pm and 6pm"), "", ELSEWHERE)).proven).toEqual([]);
  });

  test("[CH-3] Gmail's envelope is read back to the account only when it forwards to us", () => {
    expect(gmailForwarder("Chloe.X+caf_=orders=orders.example.test@googlemail.com", ORDERS)).toBe("chloe.x@googlemail.com");
    expect(gmailForwarder("cal+caf_=orders=orders.example.test@gmail.com", "ORDERS@orders.example.test")).toBe("cal@gmail.com");
    expect(gmailForwarder("cal+caf_=orders=elsewhere.example@gmail.com", ORDERS)).toBeNull();
    expect(gmailForwarder("cal+caf_=orders=orders.example.test@evil.test", ORDERS)).toBeNull();
    expect(gmailForwarder("cal@gmail.com", ORDERS)).toBeNull();
  });
});

// Codes are made up per run (HOU-168's secret scan): nine digits, as Gmail's are.
const newCode = () => String(100_000_000 + Math.floor(Math.random() * 900_000_000));
const parsed = async (message: string): Promise<ParsedMail> => {
  const mail = await simpleParser(message);
  return { subject: mail.subject ?? "", text: mail.text ?? "", html: typeof mail.html === "string" ? mail.html : "" };
};
const fromGoogle = async (message: string) => forwardingConfirmation((await check(await signed(message, world.signer.google), "forwarding-noreply@google.com", GOOGLE)).proven, await parsed(message));
const LINK = "https://mail-settings.google.com/mail/vf-%5BANGjdJ%5D-abc";

describe("Gmail's forwarding confirmation", () => {
  test("its code and link are read only from Google's own, signed email", async () => {
    const code = newCode();
    const message = gmailConfirmation("cal@gmail.com", ORDERS, code);
    expect(await fromGoogle(message)).toEqual({ confirmation: { code, link: LINK }, ignored: null });
    // Unsigned, or signed by anyone but google.com, it is nobody's confirmation, and not logged as Google's.
    const unsigned = await check(message, "forwarding-noreply@google.com", ELSEWHERE);
    expect(forwardingConfirmation(unsigned.proven, await parsed(message))).toEqual({ confirmation: null, ignored: null });
    const other = await check(await signed(message, world.signer.evil), "x@evil.test", ELSEWHERE);
    expect(forwardingConfirmation(other.proven, await parsed(message))).toEqual({ confirmation: null, ignored: null });
    // google.com's key over a From that isn't google.com's proves nothing for Google either.
    const misaligned = gmailConfirmation("cal@gmail.com", ORDERS, code, { from: "Gmail Team <forwarding-noreply@google.com.evil.test>" });
    const signedMisaligned = await check(await signed(misaligned, world.signer.google), "x@evil.test", ELSEWHERE);
    expect(forwardingConfirmation(signedMisaligned.proven, await parsed(misaligned)).confirmation).toBeNull();
  });

  test("[HOU-169] real-shaped variants: encoded subject, code later in the subject, code only in the body, the sender in any case or display name", async () => {
    const code = newCode();
    const encoded = `=?UTF-8?B?${Buffer.from(`(#${code}) Gmail Forwarding Confirmation - Receive Mail from cal@gmail.com`).toString("base64")}?=`;
    expect((await fromGoogle(gmailConfirmation("cal@gmail.com", ORDERS, code, { subject: encoded }))).confirmation?.code).toBe(code);
    expect((await fromGoogle(gmailConfirmation("cal@gmail.com", ORDERS, code, { subject: `Gmail Forwarding Confirmation (#${code})` }))).confirmation?.code).toBe(code);
    const bodyOnly = { subject: "Gmail Forwarding Confirmation - Receive Mail from cal@gmail.com" };
    expect((await fromGoogle(gmailConfirmation("cal@gmail.com", ORDERS, code, bodyOnly))).confirmation).toEqual({ code, link: LINK });
    const html = `<p>Confirmation code: <b>${code}</b></p><p><a href="https://mail.google.com/mail/vf-%5BANGjdJ%5D-x?a=1&amp;b=2">confirm</a></p>`;
    expect((await fromGoogle(gmailConfirmation("cal@gmail.com", ORDERS, code, { ...bodyOnly, body: html, html: true }))).confirmation).toEqual({ code, link: "https://mail.google.com/mail/vf-%5BANGjdJ%5D-x?a=1&b=2" });
    for (const from of ["FORWARDING-NOREPLY@Google.com", '"Gmail-Team" <forwarding-noreply@google.com>']) {
      expect((await fromGoogle(gmailConfirmation("cal@gmail.com", ORDERS, code, { from }))).confirmation?.code).toBe(code);
    }
  });

  test("[HOU-169] Google mail anyone can have sent here (a Drive share, a Send-mail-as verification) is never the confirmation, however it is signed", async () => {
    const code = newCode();
    for (const from of ["mail-noreply@google.com", "drive-shares-dm-noreply@google.com", "drive-shares-noreply@google.com", "comments-noreply@google.com", "noreply@google.com"]) {
      const share = gmailConfirmation("cal@gmail.com", ORDERS, code, { from, subject: `Document shared with you: "#${code}"` });
      const result = await fromGoogle(share);
      expect(result.confirmation).toBeNull();
      expect(result.ignored?.from).toBe(from);
    }
  });

  test("[HOU-169] a google.com-proven email that isn't the confirmation gives its shape, digits masked", async () => {
    const code = newCode();
    const result = await fromGoogle(gmailConfirmation("cal@gmail.com", ORDERS, code, { from: "Google <alerts@google.com>", subject: `Alert ${code}`, body: "Nothing to confirm." }));
    expect(result).toEqual({ confirmation: null, ignored: { from: "alerts@google.com", subjectMatched: false, bodyMatched: false, subject: "Alert #########" } });
  });
});
