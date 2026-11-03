import { ActionKind, type Block, BlockType, TimerKind } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { acceptTimer } from "../coordinator/accept.ts";
import { waitForJob } from "../jobs/launch.ts";
import { planDay } from "../jobs/plan-day.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { atLocal, daysBetween, localDate } from "../time.ts";
import { backlogScreen } from "../views/backlog.ts";
import { conversationView } from "../views/conversation.ts";
import { screenView } from "../views/screen.ts";
import { weekView } from "../views/week.ts";
import { gatherFacts, pickReason } from "./gather.ts";
import { parsePencil } from "./pencil.ts";

let h: TestHousehold;
const MON = "2026-11-02";
const WED = "2026-11-04";
const TZ = "Europe/London";
type Pick = Extract<Block, { type: "backlog-pick" }>;
const isPick = (b: Block): b is Pick => b.type === BlockType.backlogPick;
const weekDay = async (date: string) => (await weekView(h.rt, "priya")).days.find((d) => d.date === date)?.blocks ?? [];
let pick: Pick;

beforeAll(async () => {
  h = await testHousehold();
  h.ports.clock.set(atLocal(MON, 5, 30, TZ), true);
  await waitForJob((await acceptTimer(h.rt, TimerKind.morningPlan, atLocal(MON, 5, 30, TZ))).jobId);
  // Wednesday's plan, made on Monday morning, as Cal's was.
  h.ports.clock.set(atLocal(MON, 9, 0, TZ), true);
  await planDay(WED, "test", null);
  const found = (await weekDay(WED)).find(isPick);
  if (found === undefined) throw new Error("no backlog pick on Wednesday");
  pick = found;
});
afterAll(async () => h.close());

describe("HOU-173: a backlog pick on a later day", () => {
  test("[PRO-6] its reason says the day and the age from the real today, not from the plan's day", async () => {
    const item = await h.rt.system("t").backlog.get({ id: pick.ref.slice("backlog:".length) });
    const slot = parsePencil(pick.actions[0]?.value ?? null);
    if (item === null || slot === null) throw new Error("no item or slot");
    expect(slot.date >= WED).toBe(true);
    expect(pick.reason).not.toMatch(/^This /);
    expect(pick.reason).toMatch(slot.date === "2026-11-03" ? /^Tomorrow / : /^(Wednesday|Thursday|Friday|Saturday|Sunday|Monday) /);
    const age = daysBetween(localDate(new Date(item.createdAt), TZ), MON);
    expect(pick.reason).toContain(age < 14 ? `added ${age} days ago` : `added ${Math.round(age / 7)} weeks ago`);
  });

  test("[PRO-6] an item added on Monday, offered on Wednesday's plan, was added today and is for Wednesday morning (Cal's card)", async () => {
    const facts = await gatherFacts(h.rt, MON, 7);
    const item = await h.rt.system("t").backlog.get({ id: pick.ref.slice("backlog:".length) });
    if (item === null) throw new Error("no item");
    const added = { ...item, createdAt: atLocal(MON, 8, 0, TZ).toISOString() };
    expect(pickReason(facts, added, WED, MON, "morning", ["office hours"])).toBe("Wednesday morning is clear: office hours. From the backlog, added today.");
    expect(pickReason(facts, added, "2026-11-03", MON, "evening", [])).toBe("Tomorrow evening is clear. From the backlog, added today.");
    expect(pickReason(facts, added, MON, MON, "afternoon", [])).toBe("This afternoon is clear. From the backlog, added today.");
    expect(pickReason(facts, added, WED, "2026-11-04", "morning", [])).toBe("This morning is clear. From the backlog, added 2 days ago.");
  });

  test("[PRO-6][LRN-1][PRV-1] Pencil it in closes the card on Week, shows it pencilled in on that day and the Backlog, confirms, and is learned from", async () => {
    const accept = pick.actions.find((a) => a.kind === ActionKind.accept);
    if (accept === undefined) throw new Error("no Pencil it in");
    const tapped = await h.tap(pick.ref, ActionKind.accept, { value: accept.value ?? "" });
    await h.wait(tapped);
    const reply = (await h.rt.system("t").jobs.replyFor({ id: tapped.messageId }))?.text ?? "";
    // Kept against Wednesday's plan, so the card closes on Week (and Today never had it). HOU-178:
    // the slot is the one the house chose when it was tapped, from the gaps the rules allow.
    const responses = await h.rt.system("t").plans.responsesForRef({ ref: pick.ref });
    expect(responses.map((r) => [r.action, r.date])).toEqual([[ActionKind.accept, WED]]);
    const slot = parsePencil(responses[0]?.value ?? null);
    if (slot === null) throw new Error("no pencil slot recorded");
    expect(slot.date >= MON).toBe(true);
    const day = slot.date === MON ? "this" : slot.date === "2026-11-03" ? "tomorrow" : new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(new Date(slot.date));
    // The day and part, the item, then why in a few words (HOU-178).
    expect(reply).toMatch(new RegExp(`^Pencilled in for ${day} ${slot.dayPart}: ${pick.title}\\. \\S.*\\.$`));
    // The answer is shown in today's conversation, as the confirmation.
    expect((await conversationView(h.rt, "priya")).map((e) => e.reply?.text)).toContain(reply);
    expect((await weekDay(WED)).some((b) => b.id === pick.id)).toBe(false);
    expect((await screenView(h.rt, "priya", MON)).blocks.some((b) => b.id === pick.id)).toBe(false);
    // Pencilled in on its day, as a fact with no buttons, and on its Backlog row.
    const line = reply.slice(0, reply.indexOf(":"));
    const onDay = (await weekDay(slot.date)).find((b) => b.id === `pencil:${pick.ref.slice("backlog:".length)}`);
    expect(onDay).toMatchObject({ type: BlockType.event, title: pick.title, detail: line });
    const row = (await backlogScreen(h.rt)).soon.find((r) => `backlog:${r.item.id}` === pick.ref);
    expect(row?.slot).toBe(line);
    // LRN-1: remembered as accepted.
    expect((await h.rt.system("t").learning.events()).some((e) => e.ref === pick.ref && e.kind === ActionKind.accept)).toBe(true);
    // PRO-6: re-planning Wednesday offers it no more.
    await planDay(WED, "test", null);
    expect((await h.rt.system("t").plans.latest({ date: WED }))?.blocks.some((b) => b.id === pick.id)).toBe(false);
  });
});
