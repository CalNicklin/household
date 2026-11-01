import { BacklogTag } from "@household/contracts";

/** CAP-3: words that suggest each tag. Corrections the household makes are added as hints. */
const CUES: Record<BacklogTag, RegExp> = {
  [BacklogTag.quick]: /\b(ring|call|email|text|order|book|descale|card|cards|renew online|quick|5 min|10 min|15 min)\b/i,
  [BacklogTag.short]: /\b(fix|service|clean|bleed|rake|sort|tidy|clear|wash the car|put up|hang)\b/i,
  [BacklogTag.halfDay]: /\b(loft|paint|garage|half[- ]day|redecorate|clear out)\b/i,
  [BacklogTag.daylight]: /\b(garden|gate|gutter|gutters|fence|shed|outside|rake|leaves|car|bike|hedge|lawn)\b/i,
  [BacklogTag.dry]: /\b(paint|gutter|gutters|bike|rake|leaves|lawn|mow|wash the car|fence|outside|shed)\b/i,
  [BacklogTag.bothHome]: /\b(gutter|gutters|ladder|both of us|together|heavy|move the|carry)\b/i,
  [BacklogTag.noKids]: /\b(loft|pictures|drill|oven|paint|thank[- ]you|wrap|presents|bike)\b/i,
  [BacklogTag.phoneCall]: /\b(ring|call|phone|plumber|electrician|council|book the car|mot|dentist|gp|doctor)\b/i,
  [BacklogTag.tripOut]: /\b(return|drop off|charity shop|tip|post office|pick up|collect|passport|shop for)\b/i,
  [BacklogTag.officeHours]: /\b(ring|call|plumber|council|mot|bank|gp|dentist|nursery|electrician|book)\b/i,
};

const DURATIONS: readonly BacklogTag[] = [BacklogTag.quick, BacklogTag.short, BacklogTag.halfDay];

export function guessTags(text: string, hints: readonly { word: string; tag: string }[] = []): BacklogTag[] {
  const tags = new Set<BacklogTag>();
  for (const tag of Object.values(BacklogTag)) if (CUES[tag].test(text)) tags.add(tag);
  const lower = text.toLowerCase();
  for (const hint of hints) {
    const tag = Object.values(BacklogTag).find((t) => t === hint.tag);
    if (tag !== undefined && lower.includes(hint.word.toLowerCase())) tags.add(tag);
  }
  // At most one duration: the longest one the words suggest.
  const durations = DURATIONS.filter((d) => tags.has(d));
  for (const d of durations.slice(0, -1)) tags.delete(d);
  return Object.values(BacklogTag).filter((t) => tags.has(t));
}
