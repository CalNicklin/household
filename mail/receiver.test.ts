import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Limits } from "@household/contracts";
import type { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { lastConfirmation } from "./confirmation.ts";
import { createReceiver } from "./receiver.ts";
import { fixtureWorld, gmailConfirmation, gmailForwarded, screwfixOrder, signed, smtpSession } from "./testing.ts";

/**
 * HOU-150 over real SMTP: the receiver takes mail for orders@ only, never relays, refuses what is too
 * big, and hands the app only email whose sender it proved, with the proof.
 */
const DOMAIN = "orders.example.test";
const ORDERS = `orders@${DOMAIN}`;
// The test's mail arrives from 127.0.0.1, which these records treat as Google's servers.
const world = fixtureWorld("ip4:127.0.0.1");
const posted: Array<{ secret: string | undefined; body: Record<string, unknown> }> = [];
let webhook: Server;
let receiver: SMTPServer;
let port: number;
const portOf = (address: string | AddressInfo | null): number => {
  if (address === null || typeof address === "string") throw new Error("not listening on a port");
  return address.port;
};
const stateDir = mkdtempSync(path.join(tmpdir(), "mail-state-"));

beforeAll(async () => {
  webhook = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const secret = req.headers["x-webhook-secret"];
      posted.push({ secret: typeof secret === "string" ? secret : undefined, body: z.record(z.string(), z.unknown()).parse(JSON.parse(body)) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ outcome: "accepted" }));
    });
  });
  await new Promise<void>((r) => webhook.listen(0, "127.0.0.1", r));
  receiver = createReceiver({ domain: DOMAIN, webhookUrl: `http://127.0.0.1:${portOf(webhook.address())}/webhooks/email`, webhookSecret: "a-secret-for-the-webhook", stateDir, resolver: world.resolver });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  port = portOf(receiver.server.address());
});
afterAll(async () => {
  await new Promise<void>((r) => receiver.close(r));
  await new Promise<void>((r) => webhook.close(() => r()));
});

async function deliver(envelopeFrom: string, rcpt: string[], message: string) {
  const s = await smtpSession(port);
  const ehlo = await s.send("EHLO mail-sor-f41.google.com");
  const mail = await s.send(`MAIL FROM:<${envelopeFrom}>`);
  const rcpts = [];
  for (const r of rcpt) rcpts.push((await s.send(`RCPT TO:<${r}>`)).code);
  const data = rcpts.includes(250) ? (await s.data(message)).code : null;
  s.close();
  return { ehlo: ehlo.text, mail: mail.code, rcpts, data };
}

describe("the mail receiver", () => {
  test("[CAP-9][CH-3] a Gmail auto-forward of an order reaches the app with who forwarded it, proven", async () => {
    const forwarded = gmailForwarded(await signed(screwfixOrder("cal@gmail.com"), world.signer.shop), "cal@gmail.com", ORDERS);
    const before = posted.length;
    expect(await deliver(forwarded.envelopeFrom, [ORDERS], forwarded.message)).toMatchObject({ mail: 250, rcpts: [250], data: 250 });
    expect(posted.slice(before)).toEqual([
      {
        secret: "a-secret-for-the-webhook",
        body: expect.objectContaining({ from: "Screwfix <orders@screwfix.com>", to: ORDERS, subject: "Your Screwfix order is confirmed", messageId: "<sf-88231@screwfix.com>", provenSenders: ["cal@gmail.com", "orders@screwfix.com"] }),
      },
    ]);
    expect(posted.at(-1)?.body["text"]).toContain("Arriving Thursday 5 November");
  });

  test("[CH-3] spoofed forwarding headers are accepted with 250 (no bounce to anyone) and never name cal", async () => {
    const spoof = ["X-Forwarded-For: cal@gmail.com " + ORDERS, "Delivered-To: cal@gmail.com", "From: Cal <cal@gmail.com>", "To: cal@gmail.com", "Subject: Your Screwfix order is confirmed", "Message-ID: <spoof-2@evil.test>", "", "Arriving Thursday 5 November.", ""].join("\r\n");
    const before = posted.length;
    // An envelope whose domain doesn't pass SPF from here: nobody is proven, so nothing reaches the app.
    expect(await deliver("cal+caf_=orders=orders.example.test@gmail.org", [ORDERS], spoof)).toMatchObject({ rcpts: [250], data: 250 });
    expect(posted.length).toBe(before);
    // From the spoofer's own domain: only the spoofer is proven, and the app drops them (CH-3).
    expect(await deliver("mallory@evil.test", [ORDERS], spoof)).toMatchObject({ data: 250 });
    expect(posted.slice(before).map((p) => p.body["provenSenders"])).toEqual([["mallory@evil.test"]]);
  });

  test("[PRV-6] mail for anyone else is refused at RCPT, and nothing is ever relayed", async () => {
    const before = posted.length;
    const message = screwfixOrder("someone@example.com");
    for (const rcpt of ["someone@gmail.com", `cal@${DOMAIN}`, `orders+x@${DOMAIN}`, "orders@example.test", `orders@${DOMAIN}.evil.test`, `"orders@${DOMAIN}"@evil.test`]) {
      const r = await deliver("mallory@evil.test", [rcpt], message);
      expect(r.rcpts, rcpt).not.toEqual([250]);
      expect(r.data).toBeNull();
    }
    // A source route through someone else is ignored (RFC 5321 3.6.1): it is delivered here, to orders@.
    expect((await deliver("mallory@evil.test", [`@evil.test:${ORDERS}`], message)).rcpts).toEqual([250]);
    // Ours and someone else's in one transaction: only ours is taken, and only ours sees it.
    const mixed = await deliver("mallory@evil.test", [ORDERS, "victim@gmail.com"], message);
    expect(mixed.rcpts).toEqual([250, 550]);
    // There is no login to relay through.
    const s = await smtpSession(port);
    expect((await s.send("EHLO evil.test")).text).not.toMatch(/AUTH/);
    expect((await s.send("AUTH PLAIN AGFkbWluAGFkbWlu")).code).toBeGreaterThanOrEqual(500);
    s.close();
    expect(posted.length - before).toBeLessThanOrEqual(2);
  });

  test("[CODE-13] a message over the size limit is refused, and the limit is announced", async () => {
    const s = await smtpSession(port);
    expect((await s.send("EHLO mail-sor-f41.google.com")).text).toContain(`SIZE ${Limits.inboundEmailMaxBytes.value}`);
    // Declared too big up front: refused at MAIL.
    expect((await s.send(`MAIL FROM:<cal@gmail.com> SIZE=${Limits.inboundEmailMaxBytes.value + 1}`)).code).toBe(552);
    s.close();
    const before = posted.length;
    const big = screwfixOrder("cal@gmail.com").replace("2x LED bulbs", "x".repeat(76).concat("\r\n").repeat(Math.ceil(Limits.inboundEmailMaxBytes.value / 78) + 10));
    expect((await deliver("cal@gmail.com", [ORDERS], big)).data).toBe(552);
    expect(posted.length).toBe(before);
  });

  test("Gmail's forwarding confirmation is kept for household-email, not handed to the app", async () => {
    const before = posted.length;
    const confirmation = await signed(gmailConfirmation("cal@gmail.com", ORDERS, "693452117"), world.signer.google);
    expect((await deliver("forwarding-noreply@google.com", [ORDERS], confirmation)).data).toBe(250);
    expect(posted.length).toBe(before);
    expect(await lastConfirmation(stateDir, new Date())).toBe("693452117");
    expect(await lastConfirmation(stateDir, new Date(Date.now() + 61 * 60 * 1000))).toBeNull();
  });

  test("STARTTLS is offered only with a real certificate, never a made-up one", async () => {
    const s = await smtpSession(port);
    expect((await s.send("EHLO mail-sor-f41.google.com")).text).not.toMatch(/STARTTLS/);
    s.close();
  });
});
