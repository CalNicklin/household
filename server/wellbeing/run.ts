import { ActionKind, Limits, type LocalDate, type NotifyInput, type Person, Urgency, type WellbeingScore } from "@household/contracts";
import { adultsOf, type HouseFacts } from "../rules/day.ts";
import type { Runtime } from "../runtime.ts";
import { addLocalDays, weekdayOf } from "../time.ts";
import { FREE_TIME_HOURS, scoreDay } from "./score.ts";

const enabledAdults = async (rt: Runtime): Promise<Person[]> => {
  const api = rt.system("wellbeing");
  const out: Person[] = [];
  for (const a of await api.household.adults()) if ((await api.household.personSettings({ person: a.id })).wellbeingEnabled) out.push(a);
  return out;
};

async function computeScore(rt: Runtime, facts: HouseFacts, person: string, date: LocalDate): Promise<WellbeingScore> {
  const api = rt.system("wellbeing");
  const doneCount = (await api.plans.responsesOn({ date })).filter((r) => r.person === person && r.action === ActionKind.done).length;
  const settings = await api.household.settings();
  const mine = await api.household.personSettings({ person });
  // WB-7 / PRV-2: health tracking only counts when its owner turned it on, and only as one flag.
  const healthHeavy = settings.healthOwner === person && mine.healthInScore ? (await api.health.forScore({ person, from: date, to: date })).some((e) => e.heavy) : null;
  return scoreDay({ facts, person, date, doneCount, healthHeavy });
}

/** WB-1 / WB-6 / WB-8: store each opted-in adult's score and what it was made from — nothing else. */
export async function updateScores(rt: Runtime, date: LocalDate, facts: HouseFacts): Promise<void> {
  const api = rt.system("wellbeing");
  for (const a of await enabledAdults(rt)) await api.wellbeing.upsertScore(await computeScore(rt, facts, a.id, date));
}

/** WB-4: adults whose day is heavy — their free hours stay free. */
export async function heavyPeople(rt: Runtime, date: LocalDate, facts: HouseFacts): Promise<string[]> {
  const api = rt.system("wellbeing");
  const out: string[] = [];
  for (const a of await enabledAdults(rt)) {
    const stored = (await api.wellbeing.scores({ person: a.id, from: date, to: date }))[0];
    const score = stored ?? (await computeScore(rt, facts, a.id, date));
    if (score.heavy) out.push(a.id);
  }
  return out;
}

/** The first day of the run of heavy, no-free-time days ending yesterday, if it is long enough (WB-2). */
async function streakStart(rt: Runtime, person: string, today: LocalDate): Promise<LocalDate | null> {
  const api = rt.system("wellbeing");
  const scores = await api.wellbeing.scores({ person, from: addLocalDays(today, -30), to: addLocalDays(today, -1) });
  const byDate = new Map(scores.map((s) => [s.date, s]));
  let start: LocalDate | null = null;
  let length = 0;
  for (let d = addLocalDays(today, -1); ; d = addLocalDays(d, -1)) {
    const s = byDate.get(d);
    if (s === undefined || !s.heavy || s.freeHours >= FREE_TIME_HOURS) break;
    start = d;
    length += 1;
  }
  // limit: wellbeingHeavyStreak
  return length >= Limits.wellbeingHeavyStreak.value ? start : null;
}

/** A weekend morning to offer: the next Saturday or Sunday from tomorrow. */
function nextWeekendMorning(today: LocalDate): string {
  for (let i = 1; i <= 7; i++) {
    const wd = weekdayOf(addLocalDays(today, i));
    if (wd === "sat") return "Saturday morning";
    if (wd === "sun") return "Sunday morning";
  }
  return "a morning this weekend";
}

/** WB-5: one tap on "not helpful" stops wellbeing messages to that person for a month. */
async function applyNotHelpful(rt: Runtime, today: LocalDate): Promise<void> {
  const api = rt.system("wellbeing");
  // limit: wellbeingMuteDays
  const muteMs = Limits.wellbeingMuteDays.value * 86_400_000;
  const responses = await api.plans.responsesBetween({ from: addLocalDays(today, -31), to: addLocalDays(today, 1) });
  for (const r of responses) {
    if (r.action !== ActionKind.notHelpful || !r.ref.startsWith("wellbeing:")) continue;
    const until = new Date(new Date(r.at).getTime() + muteMs).toISOString();
    const current = await api.wellbeing.mutedUntil({ person: r.person });
    if (current === null || current < until) await api.wellbeing.mute({ person: r.person, until });
  }
}

/**
 * WB-2 / WB-3 / WB-5: after three heavy days in a row with no free time, offer something small —
 * first to the other adult, and only on a later day to the person themselves, from the list the
 * household wrote. At most twice a week per person, counted against the daily message limit.
 */
export async function wellbeingNudges(rt: Runtime, today: LocalDate): Promise<NotifyInput[]> {
  const api = rt.system("wellbeing");
  await applyNotHelpful(rt, today);
  const now = rt.ports.clock.now();
  const adults = await enabledAdults(rt);
  const everyone = adultsOf(await api.household.people());
  const ideas = await api.household.wellbeingIdeas();
  const sent = await api.wellbeing.nudges();
  const weekAgo = addLocalDays(today, -7);
  const out: NotifyInput[] = [];

  const mayMessage = async (to: string): Promise<boolean> => {
    if (!adults.some((a) => a.id === to)) return false;
    const muted = await api.wellbeing.mutedUntil({ person: to });
    if (muted !== null && new Date(muted) > now) return false;
    const recent = sent.filter((n) => n.to === to && n.date > weekAgo).length + out.filter((o) => o.person === to).length;
    // limit: wellbeingMessagesPerWeek
    return recent < Limits.wellbeingMessagesPerWeek.value;
  };

  for (const a of adults) {
    const start = await streakStart(rt, a.id, today);
    if (start === null) continue;
    const otherRef = `wellbeing:${a.id}:${start}:other`;
    const selfRef = `wellbeing:${a.id}:${start}:self`;
    const others = everyone.filter((p) => p.id !== a.id);
    const toOther = sent.find((n) => n.about === a.id && n.to !== a.id && n.date >= start);
    const toSelf = sent.find((n) => n.about === a.id && n.to === a.id && n.date >= start);
    if (toOther === undefined) {
      const reachable = [];
      for (const o of others) if (await mayMessage(o.id)) reachable.push(o);
      const other = reachable[0];
      if (other !== undefined) {
        out.push({
          person: other.id,
          message: `${a.name}'s had three heavy days. Could you take ${nextWeekendMorning(today)}?`,
          urgency: Urgency.normal,
          actions: [
            { kind: ActionKind.accept, label: "I'll take it", ref: otherRef },
            { kind: ActionKind.notHelpful, label: "Not helpful", ref: otherRef },
          ],
          key: otherRef,
          countsTowardsBudget: true,
        });
        await api.wellbeing.recordNudge({ about: a.id, to: other.id, date: today });
        continue;
      }
      // Nobody else can be told (switched off, muted or at their limit): note it, and the person hears tomorrow.
      await api.wellbeing.recordNudge({ about: a.id, to: "nobody", date: today });
      continue;
    }
    if (toSelf !== undefined) continue;
    const firstOffer = sent.filter((n) => n.about === a.id && n.to !== a.id && n.date >= start).map((n) => n.date).sort()[0];
    if (firstOffer !== undefined && firstOffer >= today) continue;
    if (!(await mayMessage(a.id))) continue;
    const idea = ideas.length === 0 ? null : ideas[(Number(today.slice(8, 10)) + a.id.length) % ideas.length];
    if (idea === null || idea === undefined) continue;
    out.push({
      person: a.id,
      message: `It's been a full few days. If it helps: ${idea.text.charAt(0).toLowerCase()}${idea.text.slice(1)}?`,
      urgency: Urgency.normal,
      actions: [
        { kind: ActionKind.accept, label: "Good idea", ref: selfRef },
        { kind: ActionKind.notHelpful, label: "Not helpful", ref: selfRef },
      ],
      key: selfRef,
      countsTowardsBudget: true,
    });
    await api.wellbeing.recordNudge({ about: a.id, to: a.id, date: today });
  }
  return out;
}
