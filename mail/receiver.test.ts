import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Limits } from "@household/contracts";
import type { DNSResolver } from "mailauth";
import type { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { lastConfirmation } from "./confirmation.ts";
import { createReceiver } from "./receiver.ts";
import { fixtureWorld, gmailConfirmation, gmailForwarded, screwfixOrder, signed, smtpSession } from "./testing.ts";

/**
 * HOU-150 over real SMTP: the receiver takes mail for orders@ only, never relays, refuses what is too
 * big, hands the app only email whose sender it proved, and can't be held up by one client.
 */
const DOMAIN = "orders.example.test";
const ORDERS = `orders@${DOMAIN}`;
// The test's mail arrives from 127.0.0.2, which these records treat as Google's servers. (127.0.0.1 is
// the container's healthcheck, which the connection limits leave alone.)
const CLIENT = "127.0.0.2";
const world = fixtureWorld("ip4:127.0.0.0/8");
const posted: Array<{ secret: string | undefined; body: Record<string, unknown> }> = [];
let webhook: Server;
const receivers: SMTPServer[] = [];
let port: number;
const stateDir = mkdtempSync(path.join(tmpdir(), "mail-state-"));
const portOf = (address: string | AddressInfo | null): number => {
  if (address === null || typeof address === "string") throw new Error("not listening on a port");
  return address.port;
};

async function startReceiver(resolver: DNSResolver): Promise<number> {
  const receiver = createReceiver({ domain: DOMAIN, webhookUrl: `http://127.0.0.1:${portOf(webhook.address())}/webhooks/email`, webhookSecret: "a-secret-for-the-webhook", stateDir, resolver });
  receivers.push(receiver);
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  return portOf(receiver.server.address());
}

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
  port = await startReceiver(world.resolver);
});
afterAll(async () => {
  for (const receiver of receivers) await new Promise<void>((r) => receiver.close(r));
  await new Promise<void>((r) => webhook.close(() => r()));
});

async function deliver(envelopeFrom: string, rcpt: string[], message: string, to = port) {
  const s = await smtpSession(to, "127.0.0.1", CLIENT);
  const ehlo = await s.send("EHLO mail-sor-f41.google.com");
  const mail = await s.send(`MAIL FROM:<${envelopeFrom}>`);
  const rcpts = [];
  for (const r of rcpt) rcpts.push((await s.send(`RCPT TO:<${r}>`)).code);
  const data = rcpts.includes(250) ? (await s.data(message)).code : null;
  await s.close();
  return { ehlo: ehlo.text, mail: mail.code, rcpts, data };
}
const newPosts = async (before: number, run: () => Promise<unknown>) => {
  await run();
  return posted.slice(before).map((p) => p.body);
};

describe("the mail receiver", () => {
  test("[CAP-9][CH-3] a Gmail auto-forward of an order reaches the app with who forwarded it, proven", async () => {
    const forwarded = await gmailForwarded(await signed(screwfixOrder("cal@gmail.com"), world.signer.shop), "cal@gmail.com", ORDERS, world.signer.googleArc);
    const before = posted.length;
    expect(await deliver(forwarded.envelopeFrom, [ORDERS], forwarded.message)).toMatchObject({ mail: 250, rcpts: [250], data: 250 });
    expect(posted.slice(before)).toEqual([
      {
        secret: "a-secret-for-the-webhook",
        body: expect.objectContaining({ from: "Screwfix <orders@screwfix.com>", to: ORDERS, subject: "Your Screwfix order is confirmed", messageId: "<sf-88231@screwfix.com>", provenSenders: ["cal@gmail.com"] }),
      },
    ]);
    expect(posted.at(-1)?.body["text"]).toContain("Arriving Thursday 5 November");
  });

  test("[CAP-9][CH-3] a forward by hand reaches the app as the shop's order, proven to be cal's", async () => {
    const message = await signed(["From: Cal <cal@gmail.com>", `To: ${ORDERS}`, "Subject: Fwd: Your Screwfix order is confirmed", "Message-ID: <fwd-2@mail.gmail.com>", "Content-Type: text/plain", "", "---------- Forwarded message ---------", "From: Screwfix <orders@screwfix.com>", "Date: Sun, 1 Nov 2026", "Subject: Your Screwfix order is confirmed", "", "Arriving Thursday 5 November between 8am and 1pm.", ""].join("\r\n"), world.signer.gmail);
    expect(await newPosts(posted.length, () => deliver("cal@gmail.com", [ORDERS], message))).toEqual([expect.objectContaining({ from: "Screwfix <orders@screwfix.com>", provenSenders: ["cal@gmail.com"] })]);
  });

  test("[CH-3] spoofed forwarding headers are answered 250 (no bounce to anyone) and nothing reaches the app", async () => {
    const spoof = [`X-Forwarded-For: cal@gmail.com ${ORDERS}`, "Delivered-To: cal@gmail.com", "From: Cal <cal@gmail.com>", "To: cal@gmail.com", "Subject: Your Screwfix order is confirmed", "Message-ID: <spoof-2@evil.test>", "", "Arriving Thursday 5 November.", ""].join("\r\n");
    const posts = await newPosts(posted.length, async () => {
      expect(await deliver("cal+caf_=orders=orders.example.test@gmail.com", [ORDERS], spoof)).toMatchObject({ rcpts: [250], data: 250 });
      expect(await deliver("mallory@evil.test", [ORDERS], spoof)).toMatchObject({ data: 250 });
    });
    expect(posts).toEqual([]);
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
    // Ours and someone else's in one transaction: only ours is taken.
    expect((await deliver("mallory@evil.test", [ORDERS, "victim@gmail.com"], message)).rcpts).toEqual([250, 550]);
    // There is no login to relay through.
    const s = await smtpSession(port, "127.0.0.1", CLIENT);
    expect((await s.send("EHLO evil.test")).text).not.toMatch(/AUTH/);
    expect((await s.send("AUTH PLAIN AGFkbWluAGFkbWlu")).code).toBeGreaterThanOrEqual(500);
    await s.close();
    // Unsigned mail from mallory proves no one, so none of it reached the app.
    expect(posted.length).toBe(before);
  });

  test("[CODE-13] a message over the size limit is refused, and the limit is announced", async () => {
    const s = await smtpSession(port, "127.0.0.1", CLIENT);
    expect((await s.send("EHLO mail-sor-f41.google.com")).text).toContain(`SIZE ${Limits.inboundEmailMaxBytes.value}`);
    expect((await s.send(`MAIL FROM:<cal@gmail.com> SIZE=${Limits.inboundEmailMaxBytes.value + 1}`)).code).toBe(552);
    await s.close();
    const before = posted.length;
    const big = screwfixOrder("cal@gmail.com").replace("2x LED bulbs", "x".repeat(76).concat("\r\n").repeat(Math.ceil(Limits.inboundEmailMaxBytes.value / 78) + 10));
    expect((await deliver("cal@gmail.com", [ORDERS], big)).data).toBe(552);
    expect(posted.length).toBe(before);
  });

  test("[CODE-13] a message with more signatures than the limit is dropped unchecked", async () => {
    const order = await signed(screwfixOrder(ORDERS), world.signer.gmail);
    const many = `${"DKIM-Signature: v=1; a=rsa-sha256; d=evil.test; s=s1; h=from; bh=YQ==; b=YQ==\r\n".repeat(Limits.inboundEmailMaxSignatures.value)}${order}`;
    expect(await newPosts(posted.length, async () => expect((await deliver("mallory@evil.test", [ORDERS], many)).data).toBe(250))).toEqual([]);
  });

  test("[CODE-13] one address gets two sessions at once, and the healthcheck always gets in", async () => {
    const a = await smtpSession(port, "127.0.0.1", CLIENT);
    const b = await smtpSession(port, "127.0.0.1", CLIENT);
    const c = await smtpSession(port, "127.0.0.1", CLIENT);
    expect([a.greeting.code, b.greeting.code, c.greeting.code]).toEqual([220, 220, 421]);
    const others = [await smtpSession(port, "127.0.0.1", "127.0.0.3"), await smtpSession(port, "127.0.0.1", "127.0.0.3"), await smtpSession(port, "127.0.0.1", "127.0.0.4")];
    // Four from the internet in all: the fifth is refused, whoever it is, but the healthcheck isn't.
    expect(others.map((o) => o.greeting.code)).toEqual([220, 220, 421]);
    const health = await smtpSession(port, "127.0.0.1");
    expect(health.greeting.code).toBe(220);
    await Promise.all([a, b, c, ...others, health].map((s) => s.close()));
  });

  test("[CODE-13] one session can't send more than the limit's messages", async () => {
    const s = await smtpSession(port, "127.0.0.1", "127.0.0.5");
    await s.send("EHLO evil.test");
    const codes = [];
    for (let i = 0; i <= Limits.inboundEmailMessagesPerSession.value; i++) {
      codes.push((await s.send("MAIL FROM:<mallory@evil.test>")).code);
      if (codes.at(-1) !== 250) break;
      await s.send("RSET");
    }
    await s.close();
    expect(codes.slice(0, -1).every((c) => c === 250)).toBe(true);
    expect(codes.at(-1)).toBe(421);
  });

  test("a DNS lookup that fails for now is answered 451, so a real forward is tried again", async () => {
    const flaky: DNSResolver = (name, type) => (name === "gmail.com" || name.endsWith("google.com") ? Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })) : world.resolver(name, type));
    const flakyPort = await startReceiver(flaky);
    const forwarded = await gmailForwarded(await signed(screwfixOrder("cal@gmail.com", "SF-77"), world.signer.shop), "cal@gmail.com", ORDERS, world.signer.googleArc);
    expect(await newPosts(posted.length, async () => expect((await deliver(forwarded.envelopeFrom, [ORDERS], forwarded.message, flakyPort)).data).toBe(451))).toEqual([]);
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
    const s = await smtpSession(port, "127.0.0.1", CLIENT);
    expect((await s.send("EHLO mail-sor-f41.google.com")).text).not.toMatch(/STARTTLS/);
    await s.close();
  });
});
