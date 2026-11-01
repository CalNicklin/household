import { AttachmentKind, Channel, type InboundMessage, type TimerKind, zInboundMessage } from "@household/contracts";
import { startMessageJob } from "../jobs/handle-message.ts";
import type { Runtime } from "../runtime.ts";

export type Accepted = { messageId: string; jobId: string; duplicate: boolean };

/**
 * The coordinator's front door (PLT-1). Every adapter calls this with the one message shape (CH-1).
 * It records the message once per duplicate-check key (CH-4) and starts exactly one job for it.
 * It never waits for the job.
 */
export async function accept(rt: Runtime, raw: InboundMessage): Promise<Accepted> {
  const message = zInboundMessage.parse(raw);
  const { messageId, duplicate } = await rt.system("coordinator").jobs.acceptMessage(message);
  const jobId = `job-${messageId}`;
  if (!duplicate) await startMessageJob(jobId, messageId);
  return { messageId, jobId, duplicate };
}

/** CH-3: senders the edge could not identify are dropped and logged, never passed on. */
export async function dropUnknown(rt: Runtime, channel: InboundMessage["channel"], address: string): Promise<void> {
  await rt.system("coordinator").jobs.drop({ channel, address, reason: "unknown sender" });
  console.warn(JSON.stringify({ event: "dropped-unknown-sender", channel }));
}

/** CH-3: a channel address to a person, resolved at the edge. */
export async function identify(rt: Runtime, channel: InboundMessage["channel"], address: string): Promise<string | null> {
  return rt.system("coordinator").household.resolveIdentity({ channel, address });
}

/** CH-5: a timer is a message like any other — household, no person, the timer channel, a dedupe key. */
export async function acceptTimer(rt: Runtime, timer: TimerKind, scheduledFor: Date, dedupeKey = `timer:${timer}:${scheduledFor.toISOString()}`): Promise<Accepted> {
  return accept(rt, {
    household: rt.env.HOUSEHOLD_ID,
    person: null,
    channel: Channel.timer,
    text: timer,
    attachments: [{ kind: AttachmentKind.timer, timer, scheduledFor: scheduledFor.toISOString() }],
    dedupeKey,
    receivedAt: rt.ports.clock.now().toISOString(),
  });
}
