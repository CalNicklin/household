import type { AppMessageInput } from "@household/contracts";
import { authFetch } from "./trpc.ts";

const OUTBOX = "household.outbox";

function readOutbox(): AppMessageInput[] {
  try {
    const raw = localStorage.getItem(OUTBOX);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m): m is AppMessageInput => typeof m === "object" && m !== null && "clientId" in m) : [];
  } catch {
    return [];
  }
}

function writeOutbox(items: readonly AppMessageInput[]): void {
  try {
    localStorage.setItem(OUTBOX, JSON.stringify(items));
  } catch {
    // Storage unavailable (private mode): the message is simply sent once.
  }
}

async function post(message: AppMessageInput): Promise<boolean> {
  try {
    const res = await authFetch("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}

/**
 * Say something to the house (CH-1). Each user action has one clientId, so a retried POST is the
 * same message on the server (CH-4). Unsent messages wait in an outbox and go when we are back
 * online — a thought is never lost (CAP-1).
 */
export async function say(input: Omit<AppMessageInput, "clientId">): Promise<void> {
  const message: AppMessageInput = { ...input, clientId: crypto.randomUUID() };
  writeOutbox([...readOutbox(), message]);
  if (await post(message)) writeOutbox(readOutbox().filter((m) => m.clientId !== message.clientId));
}

export async function flushOutbox(): Promise<void> {
  for (const message of readOutbox()) {
    if (await post(message)) writeOutbox(readOutbox().filter((m) => m.clientId !== message.clientId));
  }
}
