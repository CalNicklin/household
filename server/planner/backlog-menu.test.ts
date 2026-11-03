import { ActionKind, ActorKind, type BacklogItem, BacklogStatus, BlockType, Channel, TimerKind } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { acceptTimer } from "../coordinator/accept.ts";
import { waitForJob } from "../jobs/launch.ts";
import { planDay } from "../jobs/plan-day.ts";
import { deadlineOf } from "../rules/deadline.ts";
import { partStartHour } from "../rules/fit.ts";
import { guessTags } from "../rules/tags.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { atLocal } from "../time.ts";
import { backlogScreen } from "../views/backlog.ts";
import { conversationView } from "../views/conversation.ts";
import { screenView } from "../views/screen.ts";
import { weekView } from "../views/week.ts";
import { parsePencil, pencilledLine } from "./pencil.ts";

/**
 * HOU-179: the Backlog's "…" menu. Done is a person's tap (PRV-1) and Pencil it in is HOU-178's path,
 * from the Backlog rather than the day's offer card, so it doesn't count as that offer (PRO-6).
 */
let h: TestHousehold;
const TZ = "Europe/London";
const TUE = "2026-11-03";
const FRIDAY = atLocal("2026-11-06", 0, 0, TZ);
const FRIDGE = "Clean the fridge before Friday";
let fridge: BacklogItem;
let todaysOffer: string;

const sys = () => h.rt.system("t");
const reply = async (messageId: string) => (await sys().jobs.replyFor({ id: messageId }))?.text ?? "";
const weekDay = async (date: string) => (await weekView(h.rt, "cal")).days.find((d) => d.date === date)?.blocks ?? [];

beforeAll(async () => {
  h = await testHousehold();
  // Tuesday's own plan, made at 5:30, with its one offer (PRO-6), before Cal's item existed.
  h.ports.clock.set(atLocal(TUE, 5, 30, TZ), true);
  await waitForJob((await acceptTimer(h.rt, TimerKind.morningPlan, atLocal(TUE, 5, 30, TZ))).jobId);
  const offer = (await sys().plans.offers()).find((o) => o.date === TUE);
  if (offer === undefined) throw new Error("no offer on Tuesday's plan");
  todaysOffer = offer.itemId;
  // Cal's item, as Cal added it: Tuesday 3 November, 16:32.
  h.ports.clock.set(atLocal(TUE, 16, 32, TZ), true);
  fridge = await h.rt.as({ kind: ActorKind.person, person: "cal" }).backlog.create({ text: FRIDGE, tags: guessTags(FRIDGE), createdVia: Channel.app, sourceMessage: "hou-179-fridge" });
});
afterAll(async () => h.close());

describe("HOU-179: Pencil it in from the Backlog", () => {
  test("[PRO-8][CAP-4] Cal's fridge, added on Tuesday afternoon, gets a slot before Friday, said with the day and why; it shows on that day in Week and under Could go soon", async () => {
    expect((await backlogScreen(h.rt)).justAdded.map((r) => r.item.text)).toContain(FRIDGE);
    const ref = `backlog:${fridge.id}`;
    const tapped = await h.tap(ref, ActionKind.accept, { person: "cal", value: "Pencil it in" });
    await h.wait(tapped);
    const said = await reply(tapped.messageId);
    expect(said).toMatch(new RegExp(`^Pencilled in for (this evening|tomorrow (morning|afternoon|evening)|Thursday (morning|afternoon|evening)): ${FRIDGE}\\. .+\\.$`));
    expect(said).toContain("before Friday");
    const [response] = await sys().plans.responsesForRef({ ref });
    const slot = parsePencil(response?.value ?? null);
    if (slot === null) throw new Error("no pencil slot recorded");
    expect(atLocal(slot.date, partStartHour(slot.dayPart), 0, TZ) < FRIDAY).toBe(true);
    expect(deadlineOf(fridge, TZ)?.at.toISOString()).toBe(FRIDAY.toISOString());
    // On that day in Week, as a fact with no buttons.
    const line = pencilledLine(slot, TUE);
    expect((await weekDay(slot.date)).find((b) => b.id === `pencil:${fridge.id}`)).toMatchObject({ type: BlockType.event, title: FRIDGE, detail: line });
    // Under Could go soon with its pencilled line, so its menu says Move.
    const row = (await backlogScreen(h.rt)).soon.find((r) => r.item.id === fridge.id);
    expect(row).toMatchObject({ slot: line, pencilled: true });
    // PRV-1: Cal's item is as Cal wrote it.
    expect(await sys().backlog.get({ id: fridge.id })).toEqual(fridge);
  });

  test("[PRO-6] it isn't the day's offer: Tuesday's own offer stands, also when Tuesday is planned again", async () => {
    const offers = await sys().plans.offers();
    expect(offers.filter((o) => o.date === TUE).map((o) => o.itemId)).toEqual([todaysOffer]);
    expect(offers.some((o) => o.itemId === fridge.id)).toBe(false);
    await planDay(TUE, "test", null);
    expect((await sys().plans.offers()).filter((o) => o.date === TUE).map((o) => o.itemId)).toEqual([todaysOffer]);
    const plan = await sys().plans.latest({ date: TUE });
    expect(plan?.blocks.some((b) => "ref" in b && b.ref === `backlog:${fridge.id}` && b.type !== BlockType.event)).toBe(false);
  });

  test("[PRO-8] Move picks again, from the other allowed gaps", async () => {
    const ref = `backlog:${fridge.id}`;
    const before = (await backlogScreen(h.rt)).soon.find((r) => r.item.id === fridge.id)?.slot;
    const tapped = await h.tap(ref, ActionKind.accept, { person: "cal", value: "Move" });
    await h.wait(tapped);
    const after = (await backlogScreen(h.rt)).soon.find((r) => r.item.id === fridge.id);
    expect(after?.pencilled).toBe(true);
    expect(after?.slot).not.toBe(before);
    expect(await reply(tapped.messageId)).toMatch(/^Pencilled in for .+: Clean the fridge before Friday\. .+\.$/);
  });
});

describe("HOU-179: Pencil it in from the Backlog on an item offered over a week ago (AR-1)", () => {
  test("[PRO-8][CAP-4] the pencil is kept against today, so it is read back on the Backlog", async () => {
    const later = "2026-11-12";
    h.ports.clock.set(atLocal(later, 9, 0, TZ), true);
    try {
      const tapped = await h.tap(`backlog:${todaysOffer}`, ActionKind.accept, { person: "cal", value: "Pencil it in" });
      await h.wait(tapped);
      expect(await reply(tapped.messageId)).toMatch(/^Pencilled in for /);
      const responses = await sys().plans.responsesForRef({ ref: `backlog:${todaysOffer}` });
      expect(responses.at(-1)?.date).toBe(later);
      expect((await backlogScreen(h.rt)).soon.find((r) => r.item.id === todaysOffer)?.pencilled).toBe(true);
    } finally {
      h.ports.clock.set(atLocal(TUE, 16, 40, TZ), true);
    }
  });
});

describe("HOU-179: Done from the Backlog", () => {
  test("[PRV-1] the router refuses Done from the system, and from a job acting on another message", async () => {
    const other = h.rt.as({ kind: ActorKind.agent, job: "j-other", onBehalfOf: "cal", message: "another-message" });
    await expect(sys().backlog.markDone({ id: fridge.id, sourceMessage: "x" })).rejects.toThrow(/PRV-1|needs a person/);
    await expect(other.backlog.markDone({ id: fridge.id, sourceMessage: "this-message" })).rejects.toThrow(/PRV-1/);
    expect((await sys().backlog.get({ id: fridge.id }))?.status).toBe(BacklogStatus.active);
  });

  test("[PRV-1][HOME-4] a person's Done marks it done: it leaves the Backlog, its pencilled line leaves Week, and Tuesday's offer is closed when that is the one", async () => {
    const tapped = await h.tap(`backlog:${fridge.id}`, ActionKind.done, { person: "cal", value: "Done" });
    await h.wait(tapped);
    expect(await reply(tapped.messageId)).toBe(`Nice. "${FRIDGE}" is off the list.`);
    // Its answer shows in Cal's conversation, as a reminder's Delete does (sent when the Undo window ends).
    expect((await conversationView(h.rt, "cal")).map((e) => e.reply?.text)).toContain(`Nice. "${FRIDGE}" is off the list.`);
    expect((await sys().backlog.get({ id: fridge.id }))?.status).toBe(BacklogStatus.done);
    const screen = await backlogScreen(h.rt);
    expect([...screen.soon, ...screen.waiting, ...screen.justAdded].some((r) => r.item.id === fridge.id)).toBe(false);
    for (const day of (await weekView(h.rt, "cal")).days) expect(day.blocks.some((b) => b.id === `pencil:${fridge.id}`), day.date).toBe(false);
    // Done on the day's offer itself: the card goes from Today, and Tuesday is planned without it.
    const offered = await h.tap(`backlog:${todaysOffer}`, ActionKind.done, { person: "cal", value: "Done" });
    await h.wait(offered);
    expect((await screenView(h.rt, "cal", TUE)).blocks.some((b) => "ref" in b && b.ref === `backlog:${todaysOffer}`)).toBe(false);
    const plan = await sys().plans.latest({ date: TUE });
    expect(plan?.blocks.some((b) => b.type === BlockType.backlogPick && b.ref === `backlog:${todaysOffer}`)).toBe(false);
    // A second Done (another phone) records nothing more.
    const again = await h.tap(`backlog:${fridge.id}`, ActionKind.done, { person: "chloe", value: "Done" });
    await h.wait(again);
    expect(await reply(again.messageId)).toBe("That's already off the list.");
  });
});
