import { SenderProof } from "@household/contracts";
import { authenticate } from "mailauth";
import { beforeAll, describe, expect, test } from "vitest";
import { fixtureWorld, gmailConfirmation, gmailForwarded, screwfixOrder, signed } from "./testing.ts";
import { forwarderOf, forwardingConfirmationCode, provenSenders } from "./verify.ts";

/**
 * HOU-150 / CH-3: who forwarded an email to orders@ is proven by the forwarder's own domain (SPF on the
 * envelope, or DKIM/SPF aligned with From), never by what the headers say.
 */
const world = fixtureWorld();
const ORDERS = "orders@orders.example.test";
// Google's mail servers (inside Google's SPF range), and someone else's.
const GOOGLE = { ip: "209.85.220.41", helo: "mail-sor-f41.google.com" };
const ELSEWHERE = { ip: "203.0.113.66", helo: "mx.evil.test" };

const check = async (message: string, envelopeFrom: string, from: { ip: string; helo: string }) => {
  const auth = await authenticate(message, { ...from, sender: envelopeFrom, mta: "orders.example.test", disableArc: true, disableBimi: true, resolver: world.resolver });
  return { auth, proven: provenSenders(auth, envelopeFrom) };
};
let shopMessage: string;
beforeAll(async () => {
  shopMessage = await signed(screwfixOrder("cal@gmail.com"), world.signer.shop);
});

describe("who forwarded it", () => {
  test("[CH-3] Gmail's auto-forward: the envelope cal+caf_=…@gmail.com passing Google's SPF is cal@gmail.com", async () => {
    const forwarded = gmailForwarded(shopMessage, "cal@gmail.com", ORDERS);
    expect(forwarded.envelopeFrom).toBe("cal+caf_=orders=orders.example.test@gmail.com");
    const { proven } = await check(forwarded.message, forwarded.envelopeFrom, GOOGLE);
    expect(proven).toContainEqual({ address: "cal@gmail.com", proof: SenderProof.envelopeSpf });
    // The shop's own signature still verifies, so the shop is proven too: the app finds no one of us in it.
    expect(proven).toContainEqual({ address: "orders@screwfix.com", proof: SenderProof.authorDkim });
  });

  test("[CH-3] the same forward sent from somewhere that isn't Google: cal is not proven", async () => {
    const forwarded = gmailForwarded(shopMessage, "cal@gmail.com", ORDERS);
    const { proven, auth } = await check(forwarded.message, forwarded.envelopeFrom, ELSEWHERE);
    expect(auth.spf && auth.spf.status.result).not.toBe("pass");
    expect(proven.map((p) => p.address)).not.toContain("cal@gmail.com");
  });

  test("[CH-3] spoofed forwarding headers from the spoofer's own server prove only the spoofer", async () => {
    const message = [
      "X-Forwarded-To: " + ORDERS,
      `X-Forwarded-For: cal@gmail.com ${ORDERS}`,
      "Delivered-To: cal@gmail.com",
      "Resent-From: cal@gmail.com",
      "From: Cal <cal@gmail.com>",
      "To: cal@gmail.com",
      "Subject: Your Screwfix order is confirmed",
      "Message-ID: <spoof-1@evil.test>",
      "",
      "Arriving Thursday 5 November between 8am and 1pm.",
      "",
    ].join("\r\n");
    const { proven, auth } = await check(message, "cal+caf_=orders=orders.example.test@evil.test", ELSEWHERE);
    expect(auth.dmarc && auth.dmarc.status.result).toBe("fail");
    expect(proven).toEqual([{ address: "cal@evil.test", proof: SenderProof.envelopeSpf }]);
  });

  test("[CH-3] a stranger's own Gmail forwarding a message that claims to be cal's proves only the stranger", async () => {
    const claims = await signed(screwfixOrder("cal@gmail.com").replace("From: Screwfix <orders@screwfix.com>", "From: Cal <cal@gmail.com>"), world.signer.evil);
    const forwarded = gmailForwarded(claims, "mallory@gmail.com", ORDERS);
    const { proven } = await check(forwarded.message.replace("X-Forwarded-For: mallory@gmail.com", "X-Forwarded-For: cal@gmail.com"), forwarded.envelopeFrom, GOOGLE);
    expect(proven).toEqual([{ address: "mallory@gmail.com", proof: SenderProof.envelopeSpf }]);
  });

  test("[CH-3] a forward by hand: From cal@gmail.com with gmail.com's signature is cal", async () => {
    const message = await signed(
      ["From: Cal <cal@gmail.com>", `To: ${ORDERS}`, "Subject: Fwd: Your Screwfix order is confirmed", "Message-ID: <fwd-1@mail.gmail.com>", "", "---------- Forwarded message ---------", "From: Screwfix <orders@screwfix.com>", "Arriving Thursday 5 November between 8am and 1pm.", ""].join("\r\n"),
      world.signer.gmail,
    );
    const { proven } = await check(message, "cal@gmail.com", GOOGLE);
    expect(proven).toEqual([
      { address: "cal@gmail.com", proof: SenderProof.envelopeSpf },
      // (the same address once: the envelope proof came first)
    ]);
    const unsignedElsewhere = await check(message.replace(/^DKIM-Signature:[\s\S]*?\r\n(?=\S)/, ""), "cal@gmail.com", ELSEWHERE);
    expect(unsignedElsewhere.proven).toEqual([]);
  });

  test("[CH-3] a From whose signature is another domain's, or whose signature no longer matches, proves nothing", async () => {
    const message = await signed(["From: Cal <cal@gmail.com>", `To: ${ORDERS}`, "Subject: order", "", "Arriving Thursday.", ""].join("\r\n"), world.signer.evil);
    expect((await check(message, "", ELSEWHERE)).proven).toEqual([]);
    const genuine = await signed(["From: Cal <cal@gmail.com>", `To: ${ORDERS}`, "Subject: order", "", "Arriving Thursday.", ""].join("\r\n"), world.signer.gmail);
    expect((await check(genuine, "", ELSEWHERE)).proven).toEqual([{ address: "cal@gmail.com", proof: SenderProof.authorDkim }]);
    expect((await check(genuine.replace("Arriving Thursday.", "Arriving Friday."), "", ELSEWHERE)).proven).toEqual([]);
  });

  test("[CH-3] Gmail's envelope is read back to the account; other addresses are kept as they are", () => {
    expect(forwarderOf("Chloe.X+caf_=orders=orders.example.test@googlemail.com")).toBe("chloe.x@googlemail.com");
    expect(forwarderOf("cal+shopping@example.com")).toBe("cal+shopping@example.com");
    expect(forwarderOf("cal+caf_=x=y@evil.test")).toBe("cal@evil.test");
  });
});

describe("Gmail's forwarding confirmation", () => {
  test("its code is read only from Google's own, signed email", async () => {
    const genuine = await signed(gmailConfirmation("cal@gmail.com", ORDERS, "693452117"), world.signer.google);
    const { auth } = await check(genuine, "forwarding-noreply@google.com", GOOGLE);
    expect(forwardingConfirmationCode(auth, "(#693452117) Gmail Forwarding Confirmation - Receive Mail from cal@gmail.com")).toBe("693452117");

    const unsigned = await check(gmailConfirmation("cal@gmail.com", ORDERS, "111111111"), "forwarding-noreply@google.com", ELSEWHERE);
    expect(forwardingConfirmationCode(unsigned.auth, "(#111111111) Gmail Forwarding Confirmation - Receive Mail from cal@gmail.com")).toBeNull();
    const otherSigner = await signed(gmailConfirmation("cal@gmail.com", ORDERS, "222222222"), world.signer.evil);
    const other = await check(otherSigner, "x@evil.test", ELSEWHERE);
    expect(forwardingConfirmationCode(other.auth, "(#222222222) Gmail Forwarding Confirmation - Receive Mail from cal@gmail.com")).toBeNull();
  });
});
