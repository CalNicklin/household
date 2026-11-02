import { DBOS } from "@dbos-inc/dbos-sdk";
import { ActionKind, BlockType, Limits, type LocalDate, Section, TimerKind, Urgency } from "@household/contracts";
import { updateLearning } from "../learning/learn.ts";
import { notify } from "../notify/notify.ts";
import { isShopNews } from "../planner/compose.ts";
import { gatherFacts } from "../planner/gather.ts";
import { adultsOf } from "../rules/day.ts";
import { allRules, recipientsHomeAt } from "../rules/nudges.ts";
import { isDue } from "../rules/remind.ts";
import { addLocalDays, localDate, longDate, startOfLocalDay } from "../time.ts";
import { updateScores, wellbeingNudges } from "../wellbeing/run.ts";
import { jobRuntime } from "./context.ts";
import { planDay } from "./plan-day.ts";

type Usage = { inputTokens: number; outputTokens: number; costMicros: number };

/** Send every rule nudge that is due by now; the key makes each one go once (PRO-9). */
async function dispatchDue(jobId: string, date: LocalDate): Promise<void> {
  const rt = jobRuntime();
  await DBOS.runStep(
    async () => {
      const now = rt.ports.clock.now();
      // The babysitter rule looks a week ahead (PRO-1), so the dispatcher needs the week too.
      const facts = await gatherFacts(rt, date, 8);
      const closed = new Set((await rt.system("timer").plans.responsesOn({ date })).map((r) => r.ref));
      for (const n of allRules(facts, date, now).nudges) {
        if (new Date(n.at) > now) continue;
        if (n.actions.some((a) => closed.has(a.ref))) continue;
        const people = "person" in n.to ? [n.to.person] : recipientsHomeAt(facts, new Date(n.to.homeAt));
        for (const person of people) await notify(rt, { person, message: n.message, urgency: n.urgency, actions: n.actions, key: n.key, countsTowardsBudget: true }, jobId);
      }
      for (const w of await wellbeingNudges(rt, date)) await notify(rt, w, jobId);
    },
    { name: `dispatch:${date}` },
  );
}

/**
 * CAP-10: a message at its time to each person a due reminder is for (CH-7: their routing, quiet hours
 * and daily limit decide whether it goes now or waits for the screen), with Done and Later. Each goes
 * once for its day and time (PRO-9). True when today's plan still shows a due one under Later today.
 */
async function dispatchReminders(jobId: string, date: LocalDate): Promise<boolean> {
  const rt = jobRuntime();
  return DBOS.runStep(
    async () => {
      const api = rt.system("reminders");
      const now = rt.ports.clock.now();
      const due = (await api.backlog.reminders({ from: date, to: date })).filter((r) => isDue(r, now, rt.timeZone));
      if (due.length === 0) return false;
      const people = await api.household.people();
      for (const r of due) {
        const ref = `reminder:${r.id}`;
        const asker = people.find((p) => p.id === r.askedBy)?.name ?? "one of you";
        const actions = [
          { kind: ActionKind.done, label: "Done", ref },
          { kind: ActionKind.snooze, label: "Later", ref },
        ];
        for (const person of r.for) await notify(rt, { person, message: `Reminder${person === r.askedBy ? "" : ` from ${asker}`}: ${r.text}`, urgency: Urgency.urgent, actions, key: `${ref}:${r.date}T${r.time ?? ""}`, countsTowardsBudget: true }, jobId);
      }
      const latest = await api.plans.latest({ date });
      return due.some((r) => latest?.blocks.some((b) => b.id === `reminder:${r.id}` && b.section !== Section.now) ?? false);
    },
    { name: `reminders:${date}` },
  );
}

/** CAP-10: reminders with no time left open from an earlier day become backlog items. */
async function remindersToBacklog(date: LocalDate): Promise<void> {
  const rt = jobRuntime();
  await DBOS.runStep(async () => rt.system("reminders").backlog.remindersToBacklog({ today: date }), { name: `reminders-to-backlog:${date}` });
}

async function plan(jobId: string, date: LocalDate, totals: Usage, why: string): Promise<void> {
  const r = await planDay(date, why, jobId);
  totals.inputTokens += r.inputTokens;
  totals.outputTokens += r.outputTokens;
  totals.costMicros += r.costMicros;
}

/** QA-10: what it suggested, what we accepted and dismissed, and what it cost — once a week. */
async function weeklyReport(jobId: string, today: LocalDate): Promise<void> {
  const rt = jobRuntime();
  await DBOS.runStep(
    async () => {
      const api = rt.system("weekly");
      const from = addLocalDays(today, -7);
      const suggested = new Set<string>();
      // HOU-157: shop news reports on the shop; it was not suggested, and dismissing it is not a dismissal.
      const shopNews = new Set<string>();
      for (let d = 0; d < 7; d++) {
        const p = await api.plans.latest({ date: addLocalDays(from, d) });
        for (const b of p?.blocks ?? []) {
          if (isShopNews(b)) shopNews.add(b.id);
          else if (b.type === BlockType.suggestion || b.type === BlockType.backlogPick || b.type === BlockType.alert) suggested.add(b.id);
        }
      }
      const responses = (await api.plans.responsesBetween({ from, to: today })).filter((r) => !shopNews.has(r.ref));
      const accepted = responses.filter((r) => r.action === ActionKind.accept || r.action === ActionKind.done).length;
      const dismissed = responses.filter((r) => r.action === ActionKind.notToday || r.action === ActionKind.notHelpful).length;
      const jobs = await api.jobs.jobsBetween({ from: startOfLocalDay(from, rt.timeZone).toISOString(), to: startOfLocalDay(today, rt.timeZone).toISOString() });
      const cost = jobs.reduce((s, j) => s + j.costMicros, 0);
      const message = `This week I suggested ${suggested.size} things. You accepted ${accepted} and dismissed ${dismissed}. It cost $${(cost / 1_000_000).toFixed(2)}.`;
      for (const a of adultsOf(await api.household.people()))
        await notify(rt, { person: a.id, message, urgency: Urgency.urgent, actions: [], key: `weekly:${today}`, countsTowardsBudget: false }, jobId);
    },
    { name: "weekly-report" },
  );
}

/** AUT-5: the day before delivery, the basket and what was added since you last looked, with a link to change it. */
async function basketSummary(jobId: string, today: LocalDate): Promise<void> {
  const rt = jobRuntime();
  await DBOS.runStep(
    async () => {
      const basket = await rt.ports.shopping.basket();
      if (basket.deliveryDate !== addLocalDays(today, 1)) return;
      const api = rt.system("basket-summary");
      for (const a of adultsOf(await api.household.people())) {
        const last = await api.shopping.lastSummary({ person: a.id });
        const since = last?.at ?? new Date(0).toISOString();
        const added = await api.shopping.addsSince({ since });
        const items = basket.items.map((i) => `${i.quantity}× ${i.name}`).join(", ");
        const news = added.length === 0 ? "Nothing new since you last looked." : `Added since you last looked: ${added.map((x) => x.name).join(", ")}.`;
        await notify(
          rt,
          { person: a.id, message: `Tomorrow's shop (${longDate(basket.deliveryDate)}): ${items}. ${news} Change it: ${basket.changeUrl}`, urgency: Urgency.urgent, actions: [], key: `basket:${basket.deliveryDate}`, countsTowardsBudget: true },
          jobId,
        );
        await api.shopping.recordSummary({ person: a.id, deliveryDate: basket.deliveryDate });
      }
    },
    { name: "basket-summary" },
  );
}

/** CH-5: what each timer does. Timers arrive as messages like everything else (PLT-1). */
export async function runTimer(jobId: string, timer: TimerKind, scheduledFor: string): Promise<Usage> {
  const rt = jobRuntime();
  const totals: Usage = { inputTokens: 0, outputTokens: 0, costMicros: 0 };
  const today = localDate(new Date(scheduledFor), rt.timeZone);
  await DBOS.runStep(async () => rt.system("timer").jobs.recordTimer({ timer, scheduledFor, missed: false }), { name: "record-fire" });
  switch (timer) {
    case TimerKind.morningPlan: {
      await DBOS.runStep(
        async () => {
          await updateLearning(rt, today);
          const facts = await gatherFacts(rt, addLocalDays(today, -1), 3);
          await updateScores(rt, addLocalDays(today, -1), facts);
          await updateScores(rt, today, facts);
        },
        { name: "learn-and-score" },
      );
      await remindersToBacklog(today);
      await plan(jobId, today, totals, "timer:morning-plan");
      await plan(jobId, addLocalDays(today, 1), totals, "timer:morning-plan");
      await dispatchDue(jobId, today);
      break;
    }
    case TimerKind.hourlyRefresh:
      await remindersToBacklog(today);
      await plan(jobId, today, totals, "timer:hourly-refresh");
      await dispatchDue(jobId, today);
      await dispatchReminders(jobId, today);
      break;
    case TimerKind.reminders:
      if (await dispatchReminders(jobId, today)) await plan(jobId, today, totals, "timer:reminders");
      break;
    case TimerKind.catchUpPlan:
      // HOU-149: someone looked and today had no plan. Plan today only; rule nudges keep to their own timers.
      await plan(jobId, today, totals, "timer:catch-up-plan");
      break;
    case TimerKind.bins:
    case TimerKind.deliveries:
      await dispatchDue(jobId, today);
      break;
    case TimerKind.weekly:
      await weeklyReport(jobId, today);
      break;
    case TimerKind.retention:
      await DBOS.runStep(
        async () => {
          // limit: messageRetentionDays
          const before = new Date(new Date(scheduledFor).getTime() - Limits.messageRetentionDays.value * 86_400_000).toISOString();
          await rt.system("PRV-5").jobs.purgeMessagesBefore({ before });
        },
        { name: "purge" },
      );
      break;
    case TimerKind.basketSummary:
      await basketSummary(jobId, today);
      break;
  }
  return totals;
}
