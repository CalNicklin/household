import { type InboundMessage, JobStatus, Practice, zInboundMessage } from "@household/contracts";
import type { Hono } from "hono";
import { type Adapter, type HttpEnv, loadAdapters } from "../adapters/registry.ts";
import { createApp } from "../http/app.ts";
import type { Runtime } from "../runtime.ts";
import { testHousehold, type TestHousehold } from "./household.ts";

/**
 * The real HTTP app with every adapter that exists on disk. Adapters register DBOS workflows when
 * imported, so load them (`loadAdapters()`) before the household launches its jobs.
 */
function testApp(rt: Runtime, adapters: Adapter[]): Hono<HttpEnv> {
  return createApp(rt, adapters);
}

/** Load every adapter on disk, then start a practice household with jobs running. */
export async function householdWithApp(): Promise<{ h: TestHousehold; app: Hono<HttpEnv>; adapters: Adapter[] }> {
  const adapters = await loadAdapters();
  const h = await testHousehold();
  for (const a of adapters) if (a.name !== "timers") await a.start?.(h.rt);
  return { h, app: testApp(h.rt, adapters), adapters };
}

/** Log in as a practice person (Priya unless named) with the practice login, and return the session cookie. */
export async function loginCookie(app: Hono<HttpEnv>, username = "priya"): Promise<string> {
  const password = Practice.login;
  const res = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  const cookie = res.headers.get("set-cookie");
  if (res.status !== 200 || cookie === null) throw new Error(`login failed: ${res.status}`);
  return cookie.split(";")[0] ?? "";
}

/** Wait until a job row exists and has finished. */
async function settled(rt: Runtime, jobId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const job = await rt.system("test").jobs.job({ id: jobId });
    if (job !== null && job.status !== JobStatus.running && job.status !== JobStatus.pending) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${jobId} did not finish`);
}

/** The stored message with this duplicate-check key, if any. */
export async function messageByKey(rt: Runtime, dedupeKey: string): Promise<string | null> {
  for (const m of await rt.system("test").jobs.messages()) {
    const full = await rt.system("test").jobs.message({ id: m.id });
    if (full?.dedupeKey === dedupeKey) return m.id;
  }
  return null;
}

/** The job for the message with this key, once it has finished. */
export async function jobForKey(rt: Runtime, dedupeKey: string) {
  const messageId = await poll(() => messageByKey(rt, dedupeKey));
  const job = await poll(() => rt.system("test").jobs.jobForMessage({ id: messageId }));
  await settled(rt, job.id);
  return { messageId, job: await poll(() => rt.system("test").jobs.job({ id: job.id })) };
}

/** CH-1: the stored message, rebuilt as the one inbound shape (strict: exactly seven fields). */
export async function storedShape(rt: Runtime, messageId: string): Promise<InboundMessage> {
  const m = await rt.system("test").jobs.message({ id: messageId });
  if (m === null) throw new Error("no message");
  return zInboundMessage.parse({ household: rt.env.HOUSEHOLD_ID, person: m.person, channel: m.channel, text: m.text, attachments: m.attachments, dedupeKey: m.dedupeKey, receivedAt: m.receivedAt });
}

export async function poll<T>(probe: () => Promise<T | null | undefined | false>, attempts = 200): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition never became true");
}
