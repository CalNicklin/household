import { type LocalDate, type Reminder, ReminderStatus } from "@household/contracts";
import { matchReminders, type ReminderWhen } from "../rules/remind.ts";
import { addLocalDays, localDate, localTime, longDate } from "../time.ts";
import type { JobScope } from "./scope.ts";

/**
 * HOU-174: moving, re-timing or cancelling a reminder, only ever because a person asked: they said so
 * to the house, or tapped Change time or Delete on it (PRV-1). Never on the app's own initiative.
 */

const dayWords = (date: LocalDate, today: LocalDate) => (date === today ? "today" : date === addLocalDays(today, 1) ? "tomorrow" : longDate(date));

/** "09:00 Wednesday 4 November: Check BoyBoy's nap", for asking which one. */
const reminderLine = (r: Reminder, today: LocalDate) => `${r.time === null ? "" : `${r.time} `}${dayWords(r.date, today)}: ${r.text}`;

const CLOSED: Record<Exclude<ReminderStatus, "open">, string> = {
  [ReminderStatus.done]: "That's already done.",
  [ReminderStatus.moved]: "That's on the Backlog now.",
  [ReminderStatus.cancelled]: "That reminder was cancelled.",
};

/** What to say about a reminder that is no longer open (done, on the Backlog or cancelled). */
export const closedSay = (status: ReminderStatus): string => (status === ReminderStatus.open ? "" : CLOSED[status]);

/** The reminder a person means, or what to ask them instead. `ref` is the About ref when they said "this". */
export async function findReminder(scope: JobScope, which: string, ref: string | null | undefined): Promise<{ reminder: Reminder } | { say: string }> {
  const today = localDate(scope.rt.ports.clock.now(), scope.rt.timeZone);
  // The one they are looking at, if it fits what they said ("that one" fits any); never one they didn't name.
  if (ref?.startsWith("reminder:") === true) {
    const reminder = await scope.api.backlog.getReminder({ id: ref.slice("reminder:".length) });
    if (reminder?.status === ReminderStatus.open && matchReminders([reminder], which, today).length === 1) return { reminder };
  }
  const open = await scope.api.backlog.upcomingReminders({ from: today });
  const found = matchReminders(open, which, today);
  const [only] = found;
  if (found.length === 1 && only !== undefined) return { reminder: only };
  if (found.length === 0) {
    // HOU-177: the one they named is already done, on the Backlog or cancelled: say so, never offer another
    // in its place. Only when what they said narrows it down ("that reminder" alone names none of them).
    const closed = await scope.api.backlog.upcomingReminders({ from: today, closed: true });
    const gone = matchReminders(closed, which, today);
    if (gone.length > 0 && (gone.length < closed.length || closed.length === 1)) return { say: `${gone.map((r) => `${reminderLine(r, today)}. ${closedSay(r.status)}`).join(" ")} Nothing was changed.` };
  }
  if (open.length === 0) return { say: "There are no reminders coming up." };
  // Never a guess: several could match, or none does, so ask which.
  const list = (found.length > 1 ? found : open).map((r) => reminderLine(r, today)).join("; ");
  return { say: found.length > 1 ? `Which one? ${list}. Say its time or what it's about.` : `I couldn't tell which reminder you mean. Coming up: ${list}.` };
}

/** Today and tomorrow's screens, and any other day already planned, that showed or will show it. */
export async function replanFor(scope: JobScope, dates: readonly LocalDate[]): Promise<void> {
  const today = localDate(scope.rt.ports.clock.now(), scope.rt.timeZone);
  const shownOn = new Set(dates.flatMap((d) => [d, addLocalDays(d, -1)]).filter((d) => d >= today));
  for (const d of [...shownOn].sort()) {
    const planned = d <= addLocalDays(today, 1) || (await scope.api.plans.latest({ date: d })) !== null;
    if (planned && !scope.effects.replan.includes(d)) scope.effects.replan.push(d);
  }
}

/** A new day and time for a reminder the person asked to change. */
export async function changeReminder(scope: JobScope, reminder: Reminder, when: ReminderWhen): Promise<{ changed: boolean; say: string }> {
  const now = scope.rt.ports.clock.now();
  const today = localDate(now, scope.rt.timeZone);
  if (when.date < today) return { changed: false, say: `${longDate(when.date)} has already gone. Say a later day.` };
  if (when.date === today && when.time !== null && when.time <= localTime(now, scope.rt.timeZone)) return { changed: false, say: `${when.time} has already gone today. Say a later time.` };
  if (when.date === reminder.date && when.time === reminder.time) return { changed: false, say: `It's already ${when.time === null ? "" : `at ${when.time} `}${dayWords(when.date, today)}: ${reminder.text}.` };
  const changed = await scope.api.backlog.changeReminder({ id: reminder.id, date: when.date, time: when.time, sourceMessage: scope.messageId });
  // Done, moved to the Backlog or cancelled in the meantime: the router left it as it was.
  if (changed.status !== ReminderStatus.open) return { changed: false, say: closedSay(changed.status) };
  await replanFor(scope, [reminder.date, changed.date]);
  return { changed: true, say: `Moved: ${changed.text}, now ${changed.time === null ? "" : `at ${changed.time} `}${dayWords(changed.date, today)}.` };
}

/** Cancel a reminder the person asked to cancel. */
export async function cancelReminder(scope: JobScope, reminder: Reminder): Promise<{ cancelled: boolean; say: string }> {
  const today = localDate(scope.rt.ports.clock.now(), scope.rt.timeZone);
  const cancelled = await scope.api.backlog.cancelReminder({ id: reminder.id, sourceMessage: scope.messageId });
  if (cancelled.status !== ReminderStatus.cancelled) return { cancelled: false, say: closedSay(cancelled.status) };
  await replanFor(scope, [reminder.date]);
  return { cancelled: true, say: `Cancelled the ${reminder.time === null ? "" : `${reminder.time} `}reminder ${dayWords(reminder.date, today)}: ${reminder.text}.` };
}
