import { buttonData, Channel, DeliveryChannel, type Notification, NotificationStatus, type NotifyInput, PersonRole, zNotifyInput } from "@household/contracts";
import type { OutboundButton } from "../ports.ts";
import { Delivery, deliveryFor } from "../rules/budget.ts";
import type { Runtime } from "../runtime.ts";
import { addLocalDays, localDate, startOfLocalDay } from "../time.ts";

async function addressFor(rt: Runtime, person: string, channel: string): Promise<string | null> {
  const addresses = await rt.system("notify").household.addressesFor({ person });
  return addresses.find((a) => a.channel === channel)?.address ?? null;
}

/** PRV-8: before anything leaves, the recipient must be one of the household or a named sitter. */
async function assertAllowed(rt: Runtime, channel: string, address: string): Promise<void> {
  const allowed = await rt.system("notify").household.allowedRecipients();
  if (!allowed.some((a) => a.channel === channel && a.address === address)) throw new Error("PRV-8: recipient is not in the household or a named sitter");
}

/**
 * CH-7: the one send function. The person's routing table picks the channel (urgent → messenger,
 * the rest → the morning screen, each changeable in Settings); PRO-7 budget and quiet hours hold
 * messages for the morning screen; PRO-9 a key is never sent twice.
 */
export async function notify(rt: Runtime, raw: NotifyInput, jobId: string | null): Promise<Notification> {
  const input = zNotifyInput.parse(raw);
  const api = rt.system("notify");
  const people = await api.household.people();
  if (!people.some((p) => p.id === input.person && p.role === PersonRole.adult)) throw new Error("PRV-8: notify only reaches the household's adults");
  const settings = await api.household.personSettings({ person: input.person });
  const channel = settings.routing[input.urgency] ?? DeliveryChannel.screen;
  const now = rt.ports.clock.now();

  if (channel === DeliveryChannel.screen) {
    const { notification } = await api.jobs.enqueueNotification({ ...input, channel, status: NotificationStatus.onScreen, jobId });
    return notification;
  }
  const today = localDate(now, rt.timeZone);
  const since = startOfLocalDay(today, rt.timeZone).toISOString();
  const until = startOfLocalDay(addLocalDays(today, 1), rt.timeZone).toISOString();
  const sentToday = await api.jobs.sentCountSince({ person: input.person, since, until });
  const decision = input.countsTowardsBudget ? deliveryFor(settings, sentToday, now, rt.timeZone) : Delivery.send;
  if (decision !== Delivery.send) {
    const { notification } = await api.jobs.enqueueNotification({ ...input, channel, status: NotificationStatus.deferred, jobId });
    return notification;
  }
  const { notification, created } = await api.jobs.enqueueNotification({ ...input, channel, status: NotificationStatus.queued, jobId });
  if (!created || notification.status !== NotificationStatus.queued) return notification;
  const address = await addressFor(rt, input.person, Channel.telegram);
  if (address === null) return api.jobs.markNotification({ id: notification.id, status: NotificationStatus.onScreen });
  await assertAllowed(rt, Channel.telegram, address);
  const buttons: OutboundButton[] = input.actions.map((a, i) => ({ label: a.label, data: buttonData(notification.id, i) }));
  const sent = await rt.ports.messenger.send(address, input.message, buttons);
  return api.jobs.markNotification({ id: notification.id, status: NotificationStatus.sent, externalId: sent.externalId });
}

/** PRV-8: a named sitter is the only outside person the app can message, and only on a tap. */
export async function messageSitter(rt: Runtime, sitter: string, text: string): Promise<void> {
  const address = await rt.system("notify").household.sitterAddress({ name: sitter, channel: Channel.telegram });
  if (address === null) throw new Error(`PRV-8: ${sitter} is not a named sitter with an address`);
  await assertAllowed(rt, Channel.telegram, address);
  await rt.ports.messenger.send(address, text, []);
}

/** A conversational reply on the channel the message came from. Replies don't count towards the budget. */
export async function reply(rt: Runtime, messageId: string, person: string | null, channel: Channel, text: string): Promise<void> {
  if (text.trim() === "") return;
  await rt.system("reply").jobs.addReply({ person, channel, text, inReplyTo: messageId });
  if (channel !== Channel.telegram || person === null) return;
  const address = await addressFor(rt, person, Channel.telegram);
  if (address === null) return;
  await assertAllowed(rt, Channel.telegram, address);
  await rt.ports.messenger.send(address, text, []);
}
