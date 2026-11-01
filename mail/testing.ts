import { generateKeyPairSync } from "node:crypto";
import { connect } from "node:net";
import { dkimSign, type DNSResolver } from "mailauth";

/**
 * HOU-150 test fixtures: emails shaped like the ones Gmail really forwards, signed with keys made here,
 * and the DNS records (SPF, DKIM, DMARC) that would vouch for them, so mailauth checks them for real.
 */
type Records = Record<string, string[]>;

function dkimKey() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { privateKey: privateKey.export({ type: "pkcs8", format: "pem" }), record: `v=DKIM1; k=rsa; p=${der}` };
}

export type Signer = { domain: string; selector: string; privateKey: string };

type Keys = Record<"gmail" | "google" | "shop" | "evil", { privateKey: string; record: string }>;

/**
 * The world's DNS for the fixtures. `googleIps` is what Google's SPF covers (real: 209.85.128.0/17).
 * `keys` from another process's world (its `keys`) share its signatures and records.
 */
export function fixtureWorld(googleIps = "ip4:209.85.128.0/17", given?: Keys) {
  const keys: Keys = given ?? { gmail: dkimKey(), google: dkimKey(), shop: dkimKey(), evil: dkimKey() };
  const records: Records = {
    "gmail.com/TXT": ["v=spf1 redirect=_spf.google.com"],
    "_spf.google.com/TXT": [`v=spf1 ${googleIps} ~all`],
    "_dmarc.gmail.com/TXT": ["v=DMARC1; p=none; sp=quarantine; rua=mailto:mailauth-reports@google.com"],
    "20230601._domainkey.gmail.com/TXT": [keys.gmail.record],
    "google.com/TXT": ["v=spf1 include:_spf.google.com ~all"],
    "_dmarc.google.com/TXT": ["v=DMARC1; p=reject; rua=mailto:mailauth-reports@google.com"],
    "20230601._domainkey.google.com/TXT": [keys.google.record],
    "screwfix.com/TXT": ["v=spf1 ip4:198.51.100.0/24 -all"],
    "_dmarc.screwfix.com/TXT": ["v=DMARC1; p=reject"],
    "sf1._domainkey.screwfix.com/TXT": [keys.shop.record],
    "evil.test/TXT": ["v=spf1 ip4:203.0.113.0/24 ip4:127.0.0.1 -all"],
    "s1._domainkey.evil.test/TXT": [keys.evil.record],
  };
  const resolver: DNSResolver = async (name, type) => {
    const found = records[`${name.toLowerCase()}/${type}`];
    if (found === undefined) throw Object.assign(new Error(`${name} ${type}: no data`), { code: "ENOTFOUND" });
    return type === "TXT" ? found.map((r) => [r]) : found;
  };
  const signer = {
    gmail: { domain: "gmail.com", selector: "20230601", privateKey: keys.gmail.privateKey },
    google: { domain: "google.com", selector: "20230601", privateKey: keys.google.privateKey },
    shop: { domain: "screwfix.com", selector: "sf1", privateKey: keys.shop.privateKey },
    evil: { domain: "evil.test", selector: "s1", privateKey: keys.evil.privateKey },
  } satisfies Record<string, Signer>;
  return { resolver, signer, keys };
}

export async function signed(message: string, by: Signer): Promise<string> {
  const { signatures } = await dkimSign(message, { signatureData: [{ signingDomain: by.domain, selector: by.selector, privateKey: by.privateKey }] });
  return signatures + message;
}

const crlf = (lines: string[]) => `${lines.join("\r\n")}\r\n`;

/** A shop's order confirmation, as it left the shop: signed by the shop, addressed to `to`. */
export function screwfixOrder(to: string, id = "SF-88231"): string {
  return crlf([
    "From: Screwfix <orders@screwfix.com>",
    `To: ${to}`,
    "Subject: Your Screwfix order is confirmed",
    "Date: Sun, 1 Nov 2026 09:11:58 +0000",
    `Message-ID: <${id.toLowerCase()}@screwfix.com>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    `Thanks for your order ${id}.`,
    "Arriving Thursday 5 November between 8am and 1pm. Someone needs to be in to sign for it.",
    "2x LED bulbs, 1x drill bits",
    "--b1",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    `<p>Thanks for your order ${id}.</p><p>Arriving Thursday 5 November between 8am and 1pm. Someone needs to be in to sign for it.</p>`,
    "--b1--",
  ]);
}

/**
 * What Gmail adds when it auto-forwards: the forwarding headers and its ARC set on top, the shop's
 * message and signature untouched. Its envelope sender is `<user>+caf_=<to with = for @>@gmail.com`.
 */
export function gmailForwarded(shopMessage: string, user: string, forwardTo: string): { message: string; envelopeFrom: string } {
  const [local, domain] = user.split("@");
  const message =
    crlf([
      `X-Forwarded-To: ${forwardTo}`,
      `X-Forwarded-For: ${user} ${forwardTo}`,
      `Delivered-To: ${user}`,
      "Received: by 2002:a05:7300:5b8c:b0:1a2:3b4c:5d6e with SMTP id k12csp1234567dyb; Sun, 1 Nov 2026 01:12:03 -0800 (PST)",
      "ARC-Seal: i=1; a=rsa-sha256; t=1793524323; cv=none; d=google.com; s=arc-20240605; b=Zm9yd2FyZGVkIGJ5IGdtYWls",
      "ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=google.com; s=arc-20240605; h=subject:message-id:date:to:from:dkim-signature; bh=YWJj; b=ZGVm",
      "ARC-Authentication-Results: i=1; mx.google.com; dkim=pass header.i=@screwfix.com header.s=sf1 header.b=abc; spf=pass (google.com: domain of orders@screwfix.com designates 198.51.100.7 as permitted sender) smtp.mailfrom=orders@screwfix.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=screwfix.com",
      "Return-Path: <orders@screwfix.com>",
      "Received: from mta7.screwfix.com (mta7.screwfix.com. [198.51.100.7]) by mx.google.com with ESMTPS id a1si123456wrx.0.2026.11.01.01.12.02 for <" + user + ">; Sun, 01 Nov 2026 01:12:02 -0800 (PST)",
    ]) + shopMessage;
  return { message, envelopeFrom: `${local}+caf_=${forwardTo.replace("@", "=")}@${domain}` };
}

/** Gmail's forwarding confirmation, as Google sends it to the new forwarding address. */
export function gmailConfirmation(user: string, forwardTo: string, code: string): string {
  return crlf([
    "From: Gmail Team <forwarding-noreply@google.com>",
    `To: ${forwardTo}`,
    `Subject: (#${code}) Gmail Forwarding Confirmation - Receive Mail from ${user}`,
    "Date: Sun, 1 Nov 2026 09:00:00 +0000",
    "Message-ID: <confirm-1@google.com>",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    `${user} has requested to automatically forward mail to your email address ${forwardTo}.`,
    `Confirmation code: ${code}`,
    "To allow it, click the link below to confirm the request: https://mail-settings.google.com/mail/vf-%5BANGjdJ%5D-abc",
  ]);
}

/**
 * A plain SMTP client for tests and the sandbox proof: one command at a time, each reply's code and
 * text. It speaks only what a sending server would (EHLO, MAIL, RCPT, DATA, QUIT and whatever else a
 * test tries), and never upgrades to TLS.
 */
const replyCode = (reply: string) => Number(reply.slice(0, 3));

export async function smtpSession(port: number, host = "127.0.0.1") {
  const socket = connect(port, host);
  let buffer = "";
  const waiting: Array<(line: string) => void> = [];
  const replies: string[] = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    // A reply ends at a line whose code is followed by a space (multi-line replies use a dash).
    for (let m = /^(\d{3}) .*\r\n/m.exec(buffer); m !== null; m = /^(\d{3}) .*\r\n/m.exec(buffer)) {
      const end = m.index + m[0].length;
      const reply = buffer.slice(0, end);
      buffer = buffer.slice(end);
      const next = waiting.shift();
      if (next === undefined) replies.push(reply);
      else next(reply);
    }
  });
  const reply = () => new Promise<string>((resolve) => {
    const ready = replies.shift();
    if (ready === undefined) waiting.push(resolve);
    else resolve(ready);
  });
  await reply();
  const send = async (line: string) => {
    socket.write(`${line}\r\n`);
    const r = await reply();
    return { code: replyCode(r), text: r };
  };
  return {
    send,
    /** DATA, then the message (dot-stuffed), then the end mark: the reply to the message itself. */
    async data(message: string) {
      const start = await send("DATA");
      if (start.code !== 354) return start;
      socket.write(`${message.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..")}${message.endsWith("\n") ? "" : "\r\n"}.\r\n`);
      const r = await reply();
      return { code: replyCode(r), text: r };
    },
    close() {
      socket.end("QUIT\r\n");
    },
  };
}
