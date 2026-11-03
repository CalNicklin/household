import { ActionKind, ActorKind, type BacklogItem, Channel } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { deadlineOf } from "../rules/deadline.ts";
import { guessTags } from "../rules/tags.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { addLocalDays, atLocal } from "../time.ts";
import { respond } from "../agent/respond.ts";
import { jobScope } from "../agent/scope.ts";
import { partStartHour } from "../rules/fit.ts";
import { gatherFacts, pickCandidates } from "./gather.ts";
import { parsePencil } from "./pencil.ts";

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

  test("[CAP-2][PRO-8] Pencil it in on Tuesday 3 November gives the fridge a time before Friday 12:00, with the reason", async () => {
    h.ports.clock.set(atLocal("2026-11-03", 9, 10, TZ), true);
    const ref = `backlog:${fridge.id}`;
    // The card's own slot is Sunday morning, as Cal's was: the house chooses again from the allowed gaps.
    const tapped = await h.tap(ref, ActionKind.accept, { person: "cal", value: "2026-11-08 morning" });
    await h.wait(tapped);
    const reply = (await h.rt.system("t").jobs.replyFor({ id: tapped.messageId }))?.text ?? "";
    expect(reply).toMatch(new RegExp(`^Pencilled in for (this|tomorrow|Thursday|Friday) (morning|afternoon|evening): ${FRIDGE}\\. .+, and it's before Friday lunchtime\\.$`));
    const [response] = await h.rt.system("t").plans.responsesForRef({ ref });
    const slot = parsePencil(response?.value ?? null);
    if (slot === null) throw new Error("no pencil slot recorded");
    expect(atLocal(slot.date, partStartHour(slot.dayPart), 0, TZ) < DEADLINE).toBe(true);
    // PRV-1: the person's item is as they wrote it.
    expect(await h.rt.system("t").backlog.get({ id: fridge.id })).toEqual(fridge);
  });

  test("[CAP-2][PRV-1] a slot after the deadline sent straight to respond (an old card, or the chat's respond tool) is refused with the reason; nothing is recorded", async () => {
    h.ports.clock.set(atLocal("2026-11-03", 9, 10, TZ), true);
    const late = await h.rt.as({ kind: ActorKind.person, person: "cal" }).backlog.create({ text: "Return the hired ladder by Thursday", tags: guessTags("Return the hired ladder"), createdVia: Channel.app, sourceMessage: "hou-178-ladder" });
    const ref = `backlog:${late.id}`;
    const say = await respond(jobScope(h.rt, "job-hou-178", "msg-hou-178", "cal", Channel.app), ref, ActionKind.accept, "2026-11-08 morning");
    expect(say).toMatch(/^That's too late: it's needed by Thursday, so I haven't pencilled it in\. (.+ is free before then|There's no free slot for it before then)\.$/);
    expect(await h.rt.system("t").plans.responsesForRef({ ref })).toEqual([]);
  });
});
