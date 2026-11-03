import { ActionKind, ActorKind, type BacklogItem, Channel } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { deadlineOf } from "../rules/deadline.ts";
import { guessTags } from "../rules/tags.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { addLocalDays, atLocal } from "../time.ts";
import { gatherFacts, pickCandidates } from "./gather.ts";

let h: TestHousehold;
let fridge: BacklogItem;
const TZ = "Europe/London";
const MON = "2026-11-02";
const THU = "2026-11-05";
const FRI = "2026-11-06";
const FRIDGE = "Clean the garage fridge ready for collection by Friday lunchtime";
const NO_SIGNALS = { avoid: [], offerTo: {}, heavy: [], todayOffer: null };
const DEADLINE = atLocal(FRI, 12, 0, TZ);

/** The fridge's slot on the plan for `date`, made at `now`, or undefined when it isn't a candidate. */
async function fridgeOn(date: string, now: Date) {
  h.ports.clock.set(now, true);
  const facts = await gatherFacts(h.rt, date, 7);
  return (await pickCandidates(h.rt, facts, date, now, NO_SIGNALS)).find((c) => c.itemId === fridge.id);
}

beforeAll(async () => {
  h = await testHousehold();
  // Cal's item, as Cal added it: Monday 2 November.
  h.ports.clock.set(atLocal(MON, 9, 0, TZ), true);
  fridge = await h.rt.as({ kind: ActorKind.person, person: "cal" }).backlog.create({ text: FRIDGE, tags: guessTags(FRIDGE), createdVia: Channel.app, sourceMessage: "hou-178-fridge" });
});
afterAll(async () => h.close());

describe("HOU-178: a backlog item's own deadline (Cal's garage fridge)", () => {
  test("[CAP-2] its deadline, read from its words and the day it was added, is Friday 6 November at 12:00; the item has no due date", () => {
    expect(deadlineOf(fridge, TZ)?.at.toISOString()).toBe(DEADLINE.toISOString());
    expect(Object.keys(fridge).sort()).toEqual(["confirmedTags", "createdAt", "createdBy", "createdVia", "id", "notNowCount", "status", "tags", "text"]);
  });

  test("[CAP-2][PRO-8] it is pickable on Thursday 5 November", async () => {
    const thursday = await fridgeOn(THU, atLocal(THU, 7, 0, TZ));
    expect(thursday?.slotDate).toBe(THU);
    expect(thursday?.neededBy?.words).toBe("by Friday lunchtime");
  });

  test("[CAP-2][PRO-8] every gap it is offered for, planned on any day from Monday, starts before Friday lunchtime", async () => {
    const slots: string[] = [];
    for (let d = 0; d < 7; d++) {
      const pick = await fridgeOn(addLocalDays(MON, d), atLocal(MON, 9, 0, TZ));
      if (pick !== undefined) slots.push(`${pick.slotDate} ${pick.dayPart}`);
    }
    expect(slots.length).toBeGreaterThan(0);
    // Friday morning starts before 12:00; Friday afternoon and every later day do not.
    expect(slots.filter((s) => s.slice(0, 10) > FRI || (s.startsWith(FRI) && !s.endsWith("morning")))).toEqual([]);
  });

  test("[CAP-2][PRO-8] it is never picked for a gap from Friday 6 November afternoon onwards", async () => {
    expect(await fridgeOn(FRI, DEADLINE)).toBeUndefined();
    expect(await fridgeOn(FRI, atLocal(FRI, 15, 0, TZ))).toBeUndefined();
    for (const date of ["2026-11-07", "2026-11-08", "2026-11-09"]) expect(await fridgeOn(date, atLocal(date, 7, 0, TZ)), date).toBeUndefined();
  });

  test("[CAP-2][PRV-1] accepting a Sunday slot is refused with the reason and a slot before it; nothing is recorded and the item is untouched", async () => {
    h.ports.clock.set(atLocal("2026-11-03", 9, 10, TZ), true);
    const ref = `backlog:${fridge.id}`;
    const tapped = await h.tap(ref, ActionKind.accept, { person: "cal", value: "2026-11-08 morning" });
    await h.wait(tapped);
    const reply = (await h.rt.system("t").jobs.replyFor({ id: tapped.messageId }))?.text ?? "";
    expect(reply).toMatch(/^That's too late: it's needed by Friday lunchtime, so I haven't pencilled it in\. (This|Tomorrow|Wednesday|Thursday|Friday) (morning|afternoon|evening) is free before then\.$/);
    expect(reply).not.toMatch(/Friday (afternoon|evening)/);
    expect(await h.rt.system("t").plans.responsesForRef({ ref })).toEqual([]);
    expect(await h.rt.system("t").backlog.get({ id: fridge.id })).toEqual(fridge);
  });

  test("[CAP-2] a slot before the deadline is still pencilled in as before", async () => {
    h.ports.clock.set(atLocal("2026-11-03", 9, 10, TZ), true);
    const ref = `backlog:${fridge.id}`;
    const tapped = await h.tap(ref, ActionKind.accept, { person: "cal", value: `${THU} evening` });
    await h.wait(tapped);
    expect((await h.rt.system("t").jobs.replyFor({ id: tapped.messageId }))?.text).toBe(`Pencilled in for Thursday evening: ${FRIDGE}.`);
  });
});
