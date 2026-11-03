import { ActionKind, BacklogStatus, BlockType, Channel, DayPart, type LocalDate, LongTool, ModeKind, NotificationStatus, type PencilSlot, ReminderStatus, RhythmSource, ShoppingStatus, zLocalTime } from "@household/contracts";
import { START_REF_PREFIX } from "../planner/first-day.ts";
import { forecasts, gatherFacts } from "../planner/gather.ts";
import { parsePencil, pencilledLine } from "../planner/pencil.ts";
import { deadlineOf, tooLate } from "../rules/deadline.ts";
import { findSlot, partOfDay, partStartHour } from "../rules/fit.ts";
import { addLocalDays, atLocal, dayPartWords, localDate, localHour, longDate, weekdayOf } from "../time.ts";
import { cancelReminder, changeReminder, closedSay, replanFor } from "./reminders.ts";
import type { JobScope } from "./scope.ts";

export function dayPartOf(hour: number): DayPart {
  return hour < 12 ? DayPart.morning : hour < 17 ? DayPart.afternoon : DayPart.evening;
}

/** What a ref is about, in words: the block title on today's plan, the backlog item, or the ref. */
export async function subjectFor(scope: JobScope, ref: string, date: LocalDate): Promise<string> {
  const api = scope.rt.system("subject");
  if (ref.startsWith("backlog:")) {
    const item = await api.backlog.get({ id: ref.slice("backlog:".length) });
    if (item !== null) return item.text;
  }
  if (ref.startsWith("reminder:")) {
    const reminder = await api.backlog.getReminder({ id: ref.slice("reminder:".length) });
    if (reminder !== null) return reminder.text;
  }
  if (ref.startsWith("shopping:")) {
    const request = await api.shopping.get({ id: ref.slice("shopping:".length) });
    if (request !== null) return request.item;
  }
  for (const d of [date, addLocalDays(date, -1)]) {
    const plan = await api.plans.latest({ date: d });
    for (const b of plan?.blocks ?? []) {
      if (!("ref" in b) || b.ref !== ref) continue;
      if (b.type === BlockType.arrival) return `${b.shop} delivery`;
      if ("title" in b) return b.title;
    }
    const pick = plan?.blocks.find((b) => b.type === BlockType.mode);
    if (pick?.type === BlockType.mode && pick.pick?.ref === ref) return pick.pick.title;
  }
  const note = (await api.jobs.notifications({ statuses: Object.values(NotificationStatus) })).find((n) => n.key === ref);
  if (note !== undefined) return note.message;
  if (ref.startsWith("washing:")) return "Hang the washing out";
  return ref;
}

async function weatherNow(scope: JobScope, now: Date): Promise<string> {
  const settings = await scope.rt.system("weather").household.settings();
  const date = localDate(now, scope.rt.timeZone);
  // HOU-170: a weather outage never fails a tap; the kept forecast stands in, or "unknown".
  const hours = (await forecasts(scope.rt, [date], settings.latitude, settings.longitude))[date] ?? [];
  const h = hours.find((x) => Number(x.hour.slice(11, 13)) === localHour(now, scope.rt.timeZone)) ?? hours[0];
  if (h === undefined) return "unknown";
  return `${h.precipitationProbability < 40 ? "dry" : "wet"} ${Math.round(h.temperatureC)}°`;
}

async function respondToReminder(scope: JobScope, ref: string, action: ActionKind, date: LocalDate, value: string | null): Promise<string> {
  const reminder = await scope.api.backlog.getReminder({ id: ref.slice("reminder:".length) });
  if (reminder === null) return "I can't find that reminder.";
  if (reminder.status !== ReminderStatus.open) return closedSay(reminder.status);
  const replan = (d: LocalDate) => {
    if (!scope.effects.replan.includes(d)) scope.effects.replan.push(d);
  };
  if (action === ActionKind.done) {
    await scope.api.plans.respond({ ref, action, channel: scope.channel, date, value: null });
    await scope.api.backlog.reminderDone({ id: reminder.id, sourceMessage: scope.messageId });
    scope.effects.closeRefs.push({ ref, status: "done" });
    replan(date);
    // Its own day's plan, and the day before's, which shows it under Tomorrow (HOU-177).
    await replanFor(scope, [reminder.date]);
    return `Done: ${reminder.text}.`;
  }
  if (action === ActionKind.snooze || action === ActionKind.notToday) {
    const to = addLocalDays(reminder.date > date ? reminder.date : date, 1);
    await scope.api.plans.respond({ ref, action: ActionKind.snooze, channel: scope.channel, date, value: to });
    await scope.api.backlog.moveReminder({ id: reminder.id, date: to, sourceMessage: scope.messageId });
    scope.effects.closeRefs.push({ ref, status: "dismissed" });
    replan(date);
    replan(addLocalDays(date, 1));
    // Every plan that showed it or will show it: its old day, its new day and the day before each (HOU-177).
    await replanFor(scope, [reminder.date, to]);
    return to === addLocalDays(date, 1) ? `Moved to tomorrow: ${reminder.text}.` : `Moved to ${longDate(to)}: ${reminder.text}.`;
  }
  // HOU-174: a person's Change time or Delete on the reminder (PRV-1: they asked). Never from an email,
  // whose words are someone else's: this is the one place both actions reach, so the refusal is here.
  if (action === ActionKind.retime || action === ActionKind.cancel) {
    if (scope.channel === Channel.email) return "";
    if (action === ActionKind.cancel) return (await cancelReminder(scope, reminder)).say;
    if (value === null || !zLocalTime.safeParse(value).success) return "What time should it be?";
    return (await changeReminder(scope, reminder, { date: reminder.date, time: value })).say;
  }
  return "Noted.";
}

/**
 * HOU-178: what to say when a pencil slot starts at or after the item's deadline ("by Friday
 * lunchtime"), with the first free slot before it if there is one; null when the slot is in time.
 */
async function tooLateToPencil(scope: JobScope, ref: string, slot: PencilSlot, now: Date): Promise<string | null> {
  const tz = scope.rt.timeZone;
  const item = await scope.api.backlog.get({ id: ref.slice("backlog:".length) });
  const deadline = item === null ? null : deadlineOf(item, tz);
  if (item === null || deadline === null || !tooLate(deadline, atLocal(slot.date, partStartHour(slot.dayPart), 0, tz))) return null;
  const today = localDate(now, tz);
  const instead = findSlot(await gatherFacts(scope.rt, today, 7), item, now, today, 7, deadline);
  const late = `That's too late: it's needed ${deadline.words}, so I haven't pencilled it in.`;
  if (instead === null) return `${late} There's no free slot for it before then.`;
  const words = dayPartWords(instead.date, today, partOfDay(instead.startHour));
  return `${late} ${words.charAt(0).toUpperCase()}${words.slice(1)} is free before then.`;
}

/**
 * HOU-173: a backlog pick's buttons are kept against the day whose plan offered it (PRO-6: one plan,
 * once), so the card closes there — on Week for a later day — as well as on Today. Anything else is today's.
 */
async function respondedOn(scope: JobScope, ref: string, action: ActionKind, hasSlot: boolean, today: LocalDate): Promise<LocalDate> {
  // HOU-179: so is Done (from the card or the Backlog's "…" menu), so an offered card closes on its own day.
  if (!ref.startsWith("backlog:") || (action !== ActionKind.accept && action !== ActionKind.done && !hasSlot)) return today;
  // HOU-179 (AR-1): only a card still on a screen, today's or a later day's. An offer from an earlier day is
  // no card any more, and a response kept there could fall outside the pencil window and never be read back.
  const offered = (await scope.api.plans.offers()).find((o) => `backlog:${o.itemId}` === ref)?.date;
  return offered !== undefined && offered >= today ? offered : today;
}

/**
 * Done, Not today, Snooze, hand-over, accept or answer — however it arrived (HOME-4/5, CH-8).
 * Nothing becomes overdue: a response hides the thing and is remembered, that's all.
 */
export async function respond(scope: JobScope, ref: string, action: ActionKind, value: string | null): Promise<string> {
  const now = scope.rt.ports.clock.now();
  const tz = scope.rt.timeZone;
  const date = localDate(now, tz);
  const person = scope.person;
  if (person === null) return "I don't know who that was.";
  // HOU-148: decide about a shopping dismissal before recording anything. A second tap (or a job that
  // runs again) finds it already dismissed; a request still in play takes the ordinary "not today".
  let dismissShopping = false;
  if (ref.startsWith("shopping:") && action === ActionKind.notToday) {
    const request = await scope.api.shopping.get({ id: ref.slice("shopping:".length) });
    if (request?.status === ShoppingStatus.dismissed) return "That's already dismissed.";
    dismissShopping = request?.status === ShoppingStatus.failed || request?.status === ShoppingStatus.saved;
  }
  // CAP-10: Done, or Not now / Later (to tomorrow). A reminder someone asked for is theirs, not a
  // suggestion: nothing to learn from, nothing to remember.
  if (ref.startsWith("reminder:")) return respondToReminder(scope, ref, action, date, value);
  const slot = ref.startsWith("backlog:") ? parsePencil(value) : null;
  // HOU-179: Done on an item no longer on the backlog (done already, or deleted) records nothing.
  if (ref.startsWith("backlog:") && action === ActionKind.done) {
    const item = await scope.api.backlog.get({ id: ref.slice("backlog:".length) });
    if (item === null || item.status === BacklogStatus.done) return "That's already off the list.";
  }
  // HOU-178: a slot at or after the deadline in the item's own words is never pencilled in. Nothing is
  // recorded and the item is left as it is (PRV-1).
  if (action === ActionKind.accept && slot !== null) {
    const late = await tooLateToPencil(scope, ref, slot, now);
    if (late !== null) return late;
  }
  const on = await respondedOn(scope, ref, action, slot !== null, date);
  await scope.api.plans.respond({ ref, action, channel: scope.channel, date: on, value });
  const subject = await subjectFor(scope, ref, date);

  // HOU-149: "Getting started" cards are about the app, not the house's life: nothing to learn or
  // remember. HOU-157: nor is an "Added to the shop" card.
  if (ref.startsWith("shopping:") && ref.endsWith(":added") && action === ActionKind.notToday) {
    scope.effects.closeRefs.push({ ref, status: "dismissed" });
    return "Okay, dismissed.";
  }
  if (ref.startsWith(START_REF_PREFIX)) {
    scope.effects.closeRefs.push({ ref, status: "dismissed" });
    return "Okay, not now.";
  }
  const learnable: readonly ActionKind[] = [ActionKind.accept, ActionKind.notToday, ActionKind.snooze, ActionKind.handOver, ActionKind.done];
  if (learnable.includes(action)) {
    const mode = await scope.rt.system("mode").household.activeMode();
    const hour = localHour(now, tz);
    await scope.api.learning.record({
      kind: action === ActionKind.notToday ? ActionKind.notToday : action === ActionKind.accept ? ActionKind.accept : action === ActionKind.snooze ? ActionKind.snooze : action === ActionKind.handOver ? ActionKind.handOver : ActionKind.done,
      subject,
      ref,
      person,
      date,
      dayPart: dayPartOf(hour),
      weekday: weekdayOf(date),
      hour,
      weather: await weatherNow(scope, now),
      dayMode: mode?.mode ?? ModeKind.normal,
      at: now.toISOString(),
    });
  }
  scope.effects.closeRefs.push({ ref, status: action === ActionKind.done ? "done" : "dismissed" });

  if (ref.startsWith("backlog:")) {
    const id = ref.slice("backlog:".length);
    if (action === ActionKind.notToday) {
      const item = await scope.api.backlog.notNow({ id });
      scope.effects.remember.push(`Said not now to "${subject}" on a ${weekdayOf(date)} ${dayPartOf(localHour(now, tz))}.`);
      return item.status === "parked" ? `Okay. That's three times, so "${subject}" is parked until you bring it back.` : "Okay, not now.";
    }
    if (action === ActionKind.done) {
      // PRV-1: the person's own tap, so the router allows it only from this message (HOU-179).
      await scope.api.backlog.markDone({ id, sourceMessage: scope.messageId });
      // HOU-179: today's screens, and the day it was offered for, are planned again without it.
      await replanFor(scope, [date, on]);
      return `Nice. "${subject}" is off the list.`;
    }
    // HOU-173: kept as the response (PRV-1: nothing is written to the calendar); Today, Week and the
    // Backlog read it back as "Pencilled in for Wednesday morning".
    if (action === ActionKind.accept) return slot === null ? `Pencilled in: ${subject}.` : `${pencilledLine(slot, date)}: ${subject}.`;
  }
  if (ref.startsWith("question:") && action === ActionKind.answer && value !== null) {
    const q = await scope.api.learning.answer({ id: ref.slice("question:".length), answer: value });
    const days = Number(value);
    if (q.topic === "chore-rhythm" && Number.isFinite(days) && days > 0) await scope.api.learning.upsertRhythm({ subject: q.subject, everyDays: days, usualWeekday: null, source: RhythmSource.answered });
    return "Thanks, noted.";
  }
  if (ref.startsWith("wellbeing:") && action === ActionKind.notHelpful) {
    scope.effects.remember.push("Said wellbeing suggestions were not helpful.");
    return "Understood. I'll keep those to myself for a month.";
  }
  // HOU-148: a shopping request that went nowhere, dismissed with one tap; today is replanned so it
  // leaves the home screen too (HOME-4, PRO-9).
  if (dismissShopping) {
    await scope.api.shopping.dismiss({ id: ref.slice("shopping:".length) });
    if (!scope.effects.replan.includes(date)) scope.effects.replan.push(date);
    return "Okay, dismissed.";
  }
  if (ref.startsWith("shopping:") && action === ActionKind.answer && value !== null) {
    scope.effects.long.push({ tool: LongTool.shop, requestId: ref.slice("shopping:".length), sku: value });
    return "Adding that one.";
  }
  if (ref.startsWith("sitter:") && action === ActionKind.accept && value !== null) {
    scope.effects.sitterAsk.push({ sitter: value, date: ref.slice("sitter:".length), from: person });
    return `I've asked ${value}.`;
  }
  if (action === ActionKind.snooze) return "Moved to tomorrow.";
  if (action === ActionKind.notToday) {
    scope.effects.remember.push(`Dismissed "${subject}" on a ${weekdayOf(date)} ${dayPartOf(localHour(now, tz))}.`);
    return "Okay, not today.";
  }
  if (action === ActionKind.done) return "Done.";
  return "Noted.";
}
