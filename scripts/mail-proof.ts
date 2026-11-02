import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { deliver as deliverOnce, fixtureWorld, gmailConfirmation, gmailForwarded, screwfixOrder, signed, smtpSession } from "../mail/testing.ts";

/**
 * HOU-150's proof against local Docker (deploy/test-mail.sh): real SMTP into the house's mail receiver.
 *   node scripts/mail-proof.ts world <subnet>… > world.json   test DNS records and DKIM keys, with
 *                                                             Google's servers being those subnets
 *   node scripts/mail-proof.ts dns world.json                       answer the receiver's DNS (SPF, DKIM,
 *                                                                   DMARC) on UDP 53, in its own container
 *   node scripts/mail-proof.ts send world.json <smtp port> <orders address> <household address>
 * `send` delivers a Gmail auto-forward of an order, spoofed ones, mail for someone else, a relay attempt,
 * an oversize message, Gmail's forwarding confirmation, and a burst. Each line it prints is one result.
 */
const zWorld = z.object({ googleIps: z.string(), keys: z.record(z.enum(["gmail", "google", "shop", "evil"]), z.object({ privateKey: z.string(), record: z.string() })) });
const [mode, ...args] = process.argv.slice(2);
if (mode === "world") {
  if (args.length === 0 || !args.every((subnet) => /^[\d.]+\/\d+$/.test(subnet))) throw new Error("usage: mail-proof.ts world <subnet>…");
  const googleIps = args.map((subnet) => `ip4:${subnet}`).join(" ");
  console.log(JSON.stringify({ googleIps, keys: fixtureWorld(googleIps).keys }));
  process.exit(0);
}
const saved = zWorld.parse(JSON.parse(readFileSync(args[0] ?? "", "utf8")));
const world = fixtureWorld(saved.googleIps, saved.keys);

if (mode === "dns") {
  // A DNS server with only the fixtures' records: TXT answers, NXDOMAIN for anything else.
  const dns = createSocket("udp4");
  dns.on("message", (query, peer) => {
    void (async () => {
      let offset = 12;
      const labels: string[] = [];
      for (let len = query[offset] ?? 0; len > 0; len = query[offset] ?? 0) {
        labels.push(query.subarray(offset + 1, offset + 1 + len).toString());
        offset += len + 1;
      }
      const question = query.subarray(12, offset + 5);
      const type = query.readUInt16BE(offset + 1);
      const records = type === 16 ? await world.resolver(labels.join("."), "TXT").then((r) => r.flat().map(String), () => []) : [];
      const answers = records.map((txt) => {
        const chunks: Buffer[] = [];
        for (let i = 0; i < txt.length; i += 255) {
          const part = Buffer.from(txt.slice(i, i + 255));
          chunks.push(Buffer.from([part.length]), part);
        }
        const rdata = Buffer.concat(chunks);
        const rr = Buffer.alloc(12);
        rr.writeUInt16BE(0xc00c, 0);
        rr.writeUInt16BE(16, 2);
        rr.writeUInt16BE(1, 4);
        rr.writeUInt32BE(60, 6);
        rr.writeUInt16BE(rdata.length, 10);
        return Buffer.concat([rr, rdata]);
      });
      const header = Buffer.alloc(12);
      query.copy(header, 0, 0, 2);
      header.writeUInt16BE(0x8180 | (records.length === 0 && type === 16 ? 3 : 0), 2);
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(answers.length, 6);
      dns.send(Buffer.concat([header, question, ...answers]), peer.port, peer.address);
    })();
  });
  dns.bind(53, "0.0.0.0", () => console.log("test DNS listening on 53/udp"));
} else if (mode === "send") {
  await send(Number(args[1]), args[2] ?? "", args[3] ?? "");
} else {
  throw new Error("usage: mail-proof.ts world|dns|send …");
}

function say(what: string, result: unknown): void {
  console.log(`${what}: ${JSON.stringify(result)}`);
}

async function send(port: number, ORDERS: string, PERSON: string): Promise<void> {
  const [local, domain] = PERSON.split("@");
  const deliver = async (envelopeFrom: string, rcpt: string[], message: string) => {
    const { mail, rcpts, data } = await deliverOnce(port, envelopeFrom, rcpt, message);
    return { mail, rcpts, data };
  };

  const s = await smtpSession(port);
  say("ehlo", (await s.send("EHLO mail-sor-f41.google.com")).text.trim().split("\r\n"));
  await s.close();

  // Arriving tomorrow, so it is on the home screen (the shop signs the body, so it is changed before signing).
  const tomorrowOrder = await signed(screwfixOrder(PERSON, "SF-90001").replaceAll("Thursday 5 November", "tomorrow"), world.signer.shop);
  const forwarded = await gmailForwarded(tomorrowOrder, PERSON, ORDERS, world.signer.googleArc);
  say("genuine Gmail forward of a Screwfix order", await deliver(forwarded.envelopeFrom, [ORDERS], forwarded.message));

  const byHand = await signed(
    [`From: Sam <${PERSON}>`, `To: ${ORDERS}`, "Subject: Fwd: Your Currys order", "Message-ID: <fwd-currys@mail.gmail.com>", "Content-Type: text/plain", "", "---------- Forwarded message ---------", "From: Currys <orders@currys.example>", "Subject: Your Currys order", "", "Thanks for your order. Arriving tomorrow between 10am and 2pm.", ""].join("\r\n"),
    world.signer.gmail,
  );
  say("a forward by hand of a Currys order", await deliver(PERSON, [ORDERS], byHand));

  const argos = (from: string, id: string) =>
    [`X-Forwarded-For: ${PERSON} ${ORDERS}`, `X-Forwarded-To: ${ORDERS}`, `Delivered-To: ${PERSON}`, `Resent-From: ${PERSON}`, `From: ${from}`, `To: ${PERSON}`, "Subject: Your Argos order is confirmed", `Message-ID: <${id}@argos.example>`, "", "Thanks for your order. Arriving tomorrow between 7am and 7pm.", ""].join("\r\n");
  say("spoof: forwarding headers naming the household, from a server that isn't Google", await deliver(`${local}+caf_=${ORDERS.replace("@", "=")}@${domain}`.replace("@gmail.com", "@gmail.org"), [ORDERS], argos(`Argos <orders@argos.example>`, "spoof-1")));
  say("spoof: From the household person, sent from evil.test", await deliver("mallory@evil.test", [ORDERS], argos(`Sam <${PERSON}>`, "spoof-2")));
  const strangersGmail = await gmailForwarded(await signed(argos("Argos <orders@argos.example>", "spoof-3"), world.signer.evil), "mallory@gmail.com", ORDERS, world.signer.googleArc);
  say("spoof: a stranger's own Gmail forwarding, headers rewritten to name the household", await deliver(strangersGmail.envelopeFrom, [ORDERS], strangersGmail.message.replace(`X-Forwarded-For: mallory@gmail.com`, `X-Forwarded-For: ${PERSON}`)));
  say("mail for another recipient here", await deliver("mallory@evil.test", [`sam@${ORDERS.split("@")[1] ?? ""}`], argos("Argos <orders@argos.example>", "other-1")));
  say("relay attempt (RCPT to someone elsewhere)", await deliver("mallory@evil.test", ["victim@gmail.com", "victim@example.org"], argos("Argos <orders@argos.example>", "relay-1")));
  const big = screwfixOrder(PERSON, "SF-BIG").replace("2x LED bulbs", `${"x".repeat(76)}\r\n`.repeat(70_000));
  say("oversize message (5.3 MB)", await deliver(forwarded.envelopeFrom, [ORDERS], big));
  say("Gmail's forwarding confirmation", await deliver("forwarding-noreply@google.com", [ORDERS], await signed(gmailConfirmation(PERSON, ORDERS, "693452117"), world.signer.google)));

  // Three sessions at once from one address: the third is refused.
  const seats = [await smtpSession(port), await smtpSession(port), await smtpSession(port)];
  say("three sessions at once from one address (greetings)", seats.map((x) => x.greeting.code));
  await Promise.all(seats.map((seat) => seat.close()));

  // A burst for the memory cap: 40 messages of 1 MB each, two sessions at a time (one address's limit),
  // each one read, checked and parsed in full. Sent by mallory, so only the shop's signature is proven,
  // and the app drops each one as nobody's (CH-3).
  const burstBody = await signed(screwfixOrder(PERSON, "SF-BURST").replace("2x LED bulbs", `${"y".repeat(76)}\r\n`.repeat(13_000)), world.signer.shop);
  const results: Array<number | null> = [];
  for (let round = 0; round < 20; round++) {
    const codes = await Promise.all(Array.from({ length: 2 }, () => deliver("mallory@evil.test", [ORDERS], burstBody).then((r) => r.data)));
    results.push(...codes);
  }
  say("burst of 40 x 1 MB (data replies)", [...new Set(results)].map((code) => [String(code), results.filter((c) => c === code).length]));
}
