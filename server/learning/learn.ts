/**
 * Learning (LRN-2..LRN-8). Everything here only ever changes what gets suggested and when; nothing
 * learned becomes a due date, a rule, a calendar event or an edit to a person's backlog item —
 * except adding the duration tag a person chose with their own one-tap answer.
 */
import {
  ActionKind,
  ActorKind,
  BacklogStatus,
  BacklogTag,
  DurationTag,
  type LearnedSentence,
  type LocalDate,
  type Question,
  QuestionTopic,
  WeekdayLabel,
} from "@household/contracts";
import type { Runtime } from "../runtime.ts";
import { avoidPairs, avoidSentence, choreDoneDays, inferRhythms, offerTargetsFrom, RHYTHM_MIN_DONES } from "./infer.ts";

const PreferenceKind = {
  avoidDayPart: "avoid-daypart",
  offerTo: "offer-to",
  sitterDays: "sitter-days",
} as const;

const DURATIONS: readonly string[] = Object.values(DurationTag);

const SITTER_OPTIONS = [
  { label: "Weekday evenings", value: "weekday evenings" },
  { label: "Weekends", value: "weekends" },
  { label: "Any day", value: "any day" },
];

function chorePhrase(subject: string): string {
  const lower = subject.toLowerCase();
  return /^(water|change|hoover|clean|wash|iron|mop|dust|empty|descale|defrost)\b/.test(lower) ? lower : `the ${lower}`;
}

async function nameOf(rt: Runtime, person: string): Promise<string> {
  return (await rt.system("learning").household.people()).find((p) => p.id === person)?.name ?? person;
}

/** LRN-2/5/6 and applying one-tap answers. Runs every morning (and is safe to run any time). */
export async function updateLearning(rt: Runtime, _today: LocalDate): Promise<void> {
  const api = rt.system("learning");
  const events = await api.learning.events();
  const now = rt.ports.clock.now();

  for (const r of inferRhythms(events)) await api.learning.learnRhythm({ subject: r.subject, everyDays: r.everyDays, usualWeekday: r.usualWeekday, source: "learned" });

  const prefs = await api.learning.preferences();
  const avoid = avoidPairs(events, now);
  for (const p of avoid) await api.learning.setPreference({ kind: PreferenceKind.avoidDayPart, subject: p.key, value: p.dayPart, sentence: avoidSentence(p) });
  for (const stale of prefs.filter((p) => p.kind === PreferenceKind.avoidDayPart && !avoid.some((a) => a.key === p.subject)))
    await api.learning.clearPreference({ kind: stale.kind, subject: stale.subject });

  const targets = offerTargetsFrom(events);
  for (const [key, t] of targets) await api.learning.setPreference({ kind: PreferenceKind.offerTo, subject: key, value: t.person, sentence: `${await nameOf(rt, t.person)} usually takes "${t.subject}"` });
  for (const stale of prefs.filter((p) => p.kind === PreferenceKind.offerTo && !targets.has(p.subject))) await api.learning.clearPreference({ kind: stale.kind, subject: stale.subject });

  // Answers to one-tap questions that are not rhythms (respond.ts handles those directly).
  for (const q of await api.learning.questions()) {
    if (q.answer === null) continue;
    if (q.topic === QuestionTopic.jobLength && DURATIONS.includes(q.answer)) {
      const item = await api.backlog.get({ id: q.subject });
      if (item === null || item.tags.some((t) => DURATIONS.includes(t))) continue;
      const by = (await api.plans.responsesForRef({ ref: `question:${q.id}` })).find((r) => r.action === ActionKind.answer)?.person;
      if (by === undefined) continue;
      const tag = Object.values(BacklogTag).find((t) => t === q.answer);
      if (tag === undefined) continue;
      // The person tapped this answer themselves, so the tag change is theirs (PRV-1).
      await rt.as({ kind: ActorKind.person, person: by }).backlog.setTags({ id: item.id, tags: [...item.tags, tag] });
    }
    if (q.topic === QuestionTopic.sitterDays) {
      await api.learning.setPreference({ kind: PreferenceKind.sitterDays, subject: q.subject, value: q.answer, sentence: `${q.subject} is usually free ${q.answer === "any day" ? "any day" : `on ${q.answer}`}` });
    }
  }
}

type Gap = Omit<Question, "id" | "answer" | "askedOn">;

/** LRN-4: only specific gaps — a chore with no rhythm, a job with no rough length, a sitter with no known days. */
async function gaps(rt: Runtime): Promise<Gap[]> {
  const api = rt.system("learning");
  const out: Gap[] = [];
  const rhythms = new Set((await api.learning.rhythms()).map((r) => r.subject.toLowerCase()));
  const forgotten = new Set((await api.learning.forgotten()).map((f) => `${f.kind}|${f.subject.toLowerCase()}`));
  for (const [subject, days] of choreDoneDays(await api.learning.events())) {
    if (days.length >= RHYTHM_MIN_DONES || rhythms.has(subject.toLowerCase()) || forgotten.has(`rhythm|${subject.toLowerCase()}`)) continue;
    out.push({
      topic: QuestionTopic.choreRhythm,
      subject,
      text: `How often do you do ${chorePhrase(subject)}?`,
      options: [
        { label: "3 days", value: "3" },
        { label: "5 days", value: "5" },
        { label: "Weekly", value: "7" },
      ],
    });
  }
  const items = (await api.backlog.list()).filter((i) => i.status === BacklogStatus.active && !i.confirmedTags && !i.tags.some((t) => DURATIONS.includes(t)));
  for (const item of items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    out.push({
      topic: QuestionTopic.jobLength,
      subject: item.id,
      text: `Roughly how long does "${item.text}" take?`,
      options: [
        { label: "15 min", value: DurationTag.quick },
        { label: "An hour", value: DurationTag.short },
        { label: "Half a day", value: DurationTag.halfDay },
      ],
    });
  for (const s of await api.household.sitters()) {
    if (s.knownFreeDays.length > 0) continue;
    out.push({ topic: QuestionTopic.sitterDays, subject: s.name, text: `When is ${s.name} usually free to babysit?`, options: SITTER_OPTIONS });
  }
  return out;
}

/** LRN-3/4: one question a day for the whole house, one tap to answer, never the same thing twice. */
export async function questionFor(rt: Runtime, today: LocalDate): Promise<Question | null> {
  const api = rt.system("learning");
  const asked = await api.learning.questions();
  const todays = asked.find((q) => q.askedOn === today);
  if (todays !== undefined) return todays.answer === null ? todays : null;
  const done = new Set(asked.map((q) => `${q.topic}|${q.subject}`));
  for (const gap of await gaps(rt)) {
    if (done.has(`${gap.topic}|${gap.subject}`)) continue;
    // The unique indexes make one-a-day and never-twice database facts, even under a race.
    return api.learning.ask({ ...gap, askedOn: today });
  }
  return null;
}

/** LRN-7: everything learned, as plain sentences you can delete. */
export async function learnedSentences(rt: Runtime): Promise<LearnedSentence[]> {
  const api = rt.system("learning");
  const rhythms = (await api.learning.rhythms()).map((r) => ({
    id: r.id,
    kind: "rhythm",
    text: `${r.subject}: about every ${r.everyDays === 1 ? "day" : r.everyDays === 7 ? "week" : `${r.everyDays} days`}${r.usualWeekday === null ? "" : `, usually ${WeekdayLabel[r.usualWeekday]}`}`,
  }));
  const prefs = (await api.learning.preferences()).map((p) => ({ id: p.id, kind: p.kind, text: p.sentence }));
  return [...rhythms, ...prefs];
}

/** LRN-5: "subject|dayPart" pairs whose suggestions are not offered. Forgotten ones stay forgotten. */
export async function avoidedDayParts(rt: Runtime): Promise<Set<string>> {
  const api = rt.system("learning");
  const forgotten = new Set((await api.learning.forgotten()).filter((f) => f.kind === PreferenceKind.avoidDayPart).map((f) => f.subject));
  return new Set(avoidPairs(await api.learning.events(), rt.ports.clock.now()).map((p) => p.key).filter((k) => !forgotten.has(k)));
}

/** LRN-6: subject (lower case) → the person it should be offered to. */
export async function offerTargets(rt: Runtime): Promise<Map<string, string>> {
  const api = rt.system("learning");
  const forgotten = new Set((await api.learning.forgotten()).filter((f) => f.kind === PreferenceKind.offerTo).map((f) => f.subject));
  const out = new Map<string, string>();
  for (const [key, t] of offerTargetsFrom(await api.learning.events())) if (!forgotten.has(key)) out.set(key, t.person);
  return out;
}
