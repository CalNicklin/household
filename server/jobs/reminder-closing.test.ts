import { ActionKind, ActorKind, type Block, BlockType, Channel, ReminderStatus, TimerKind } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { jobScope } from "../agent/scope.ts";
import { houseTools, TAP_A_REMINDER } from "../agent/tools.ts";
import { acceptTimer } from "../coordinator/accept.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { atLocal } from "../time.ts";
import { conversationView } from "../views/conversation.ts";
import { openReminderBlocks, screenView } from "../views/screen.ts";
import { weekView } from "../views/week.ts";
import { waitForJob } from "./launch.ts";

let h: TestHousehold;
const MON = "2026-11-02";
const TUE = "2026-11-03";
const TZ = "Europe/London";
const NINE = "check their opinion on BoyBoy still needing a lunchtime nap, and whether he should wait a bit longer before going to the same pre-school as Pip in January";
const SEVEN = "At dropoff, ask for their opinion on whether BoyBoy still needs a lunchtime nap and whether he should wait a bit longer before starting at Pip's pre-school in January";
const replyTo = async (a: { messageId: string }) => (await h.rt.system("t").jobs.replyFor({ id: a.messageId }))?.text ?? "";
const said = async (text: string, ref?: string) => replyTo(await h.sayAndWait(text, { person: "tom", ...(ref === undefined ? {} : { ref }) }));
const tapped = async (ref: string, action: ActionKind) => {
  const a = await h.tap(ref, action, { person: "tom" });
  await h.wait(a);
  return replyTo(a);
};
const reminderCards = (blocks: readonly Block[]) => blocks.flatMap((b) => (b.type === BlockType.reminder ? [`${b.section} ${b.time ?? ""} ${b.title}`] : []));
const tuesday = async () => reminderCards((await screenView(h.rt, "tom", TUE)).blocks);
const tuesdayOnWeek = async () => reminderCards((await weekView(h.rt, "tom")).days.find((d) => d.date === TUE)?.blocks ?? []);

beforeAll(async () => {
  h = await testHousehold();
  h.ports.clock.set(atLocal(MON, 5, 30, TZ), true);
  await waitForJob((await acceptTimer(h.rt, TimerKind.morningPlan, atLocal(MON, 5, 30, TZ))).jobId);
  h.ports.clock.set(atLocal(MON, 14, 0, TZ), true);
});
afterAll(async () => h.close());

describe("HOU-177: the screen and the house agree on which reminders are open", () => {
  test("[CAP-10][PRV-1] Cal's case: the 09:00 BoyBoy reminder, done from Tomorrow, leaves the screen; 'cancel the 9 o'clock BoyBoy reminder' says it's done and never offers the 07:30", async () => {
    // Made in this order on the real house: the 09:00 one first, the 07:30 one in the next message.
    expect(await said(`remind me on Wednesday at 9 to ${NINE}`)).toMatch(/^I'll remind you at 09:00 Wednesday 4 November/);
    expect(await said(`remind me on Wednesday at 7:30 to ${SEVEN}`)).toMatch(/^I'll remind you at 07:30 Wednesday 4 November/);
    expect((await tuesday()).map((c) => c.slice(0, 15))).toEqual(["tomorrow 07:30 ", "tomorrow 09:00 "]);

    // Done on the 09:00 card under Tomorrow on Tuesday's screen: gone from Tuesday's screen and Week too.
    const nine = (await h.rt.system("t").backlog.upcomingReminders({ from: MON })).find((r) => r.time === "09:00");
    if (nine === undefined) throw new Error("no 09:00 reminder");
    expect(await tapped(`reminder:${nine.id}`, ActionKind.done)).toMatch(/^Done: /);
    expect((await tuesday()).map((c) => c.slice(0, 15))).toEqual(["tomorrow 07:30 "]);
    expect((await tuesdayOnWeek()).map((c) => c.slice(0, 15))).toEqual(["tomorrow 07:30 "]);

    // 22:40, Cal's exact words: the house says what became of the 09:00 one and changes nothing.
    h.ports.clock.set(atLocal(MON, 22, 40, TZ), true);
    const reply = await said("cancel the 9 o'clock BoyBoy reminder");
    expect(reply).toMatch(/^09:00 Wednesday 4 November: .*That's already done\. Nothing was changed\.$/);
    expect(reply).not.toContain("07:30");
    expect((await h.rt.system("t").backlog.upcomingReminders({ from: MON })).map((r) => r.time)).toEqual(["07:30"]);
  });

  test("[CAP-10] a Delete that changes nothing says why in the conversation", async () => {
    const nine = (await h.rt.system("t").backlog.upcomingReminders({ from: MON, closed: true })).find((r) => r.time === "09:00");
    if (nine === undefined) throw new Error("no 09:00 reminder");
    expect(await tapped(`reminder:${nine.id}`, ActionKind.cancel)).toBe("That's already done.");
    const last = (await conversationView(h.rt, "tom")).at(-1);
    expect(last?.reply?.text).toBe("That's already done.");
  });

  test("[CAP-10][PRV-1] 'cancel that one' about a reminder already done says so, and never cancels the only open one instead", async () => {
    const nine = (await h.rt.system("t").backlog.upcomingReminders({ from: MON, closed: true })).find((r) => r.time === "09:00");
    if (nine === undefined) throw new Error("no 09:00 reminder");
    expect(await said("cancel that reminder", `reminder:${nine.id}`)).toMatch(/^09:00 Wednesday 4 November: .*That's already done\. Nothing was changed\.$/);
    expect((await h.rt.system("t").backlog.upcomingReminders({ from: MON })).map((r) => r.time)).toEqual(["07:30"]);
  });

  test("[CAP-10] a saved plan's reminder card shows only while its reminder is open at that time", async () => {
    const saved = (await h.rt.system("t").plans.latest({ date: TUE }))?.blocks ?? [];
    const [seven] = await h.rt.system("t").backlog.upcomingReminders({ from: MON });
    if (seven === undefined) throw new Error("no 07:30 reminder");
    const now = h.rt.ports.clock.now();
    expect(reminderCards(openReminderBlocks(saved, [seven], TUE, now, TZ)).map((c) => c.slice(0, 15))).toEqual(["tomorrow 07:30 "]);
    expect(reminderCards(openReminderBlocks(saved, [], TUE, now, TZ))).toEqual([]);
    expect(reminderCards(openReminderBlocks(saved, [{ ...seven, time: "07:15" }], TUE, now, TZ))).toEqual([]);
    expect(reminderCards(openReminderBlocks(saved, [{ ...seven, date: "2026-11-05" }], TUE, now, TZ))).toEqual([]);
  });

});

describe("HOU-177 (PRV-1): only a person's tap marks a reminder done or puts it off", () => {
  const WED = "2026-11-04";
  const boyBoy = async () => (await h.rt.system("t").backlog.upcomingReminders({ from: MON })).filter((r) => r.date === WED && r.text.includes("lunchtime nap"));

  test("[PRV-1][CAP-10] Cal's sequence: 'make it 730' while looking at the 09:00 reminder re-times it, never closes it or sets a second", async () => {
    h.ports.clock.set(atLocal(MON, 20, 31, TZ), true);
    for (const r of await boyBoy()) await h.rt.as({ kind: ActorKind.person, person: "tom" }).backlog.cancelReminder({ id: r.id, sourceMessage: "tidy" }).catch(() => undefined);
    for (const words of ["BoyBoy reminder on Wednesday 4th should be earlier than 9 - make it 730", "BoyBoy reminder on Wesnday 4th should be earlier than 9 - mak eit 730"]) {
      expect(await said(`remind me on Wednesday at 9 to ${NINE}`)).toMatch(/^I'll remind you at 09:00 Wednesday 4 November/);
      const nine = (await boyBoy()).find((r) => r.time === "09:00");
      if (nine === undefined) throw new Error("no 09:00 reminder");
      const reply = await said(words, `reminder:${nine.id}`);
      expect(reply).toBe(`Moved: ${nine.text}, now at 07:30 Wednesday 4 November.`);
      const after = await h.rt.system("t").backlog.getReminder({ id: nine.id });
      expect([after?.status, after?.time]).toEqual([ReminderStatus.open, "07:30"]);
      expect((await boyBoy()).filter((r) => r.text === nine.text)).toHaveLength(1);
      await h.rt.as({ kind: ActorKind.person, person: "tom" }).backlog.cancelReminder({ id: nine.id, sourceMessage: "tidy" });
    }
  });

  test("[PRV-1] the agent's respond tool never marks a reminder done or puts it off; only the person's own tap does", async () => {
    expect(await said(`remind me on Wednesday at 9 to ${NINE}`)).toMatch(/^I'll remind you at 09:00/);
    const r = (await boyBoy()).find((x) => x.time === "09:00");
    if (r === undefined) throw new Error("no 09:00 reminder");
    const tools = houseTools(jobScope(h.rt, "j", "app-message", "tom", Channel.app));
    const refused = { say: TAP_A_REMINDER };
    for (const action of [ActionKind.done, ActionKind.snooze, ActionKind.notToday]) expect(await tools.respond.execute?.({ ref: `reminder:${r.id}`, action }, {})).toEqual(refused);
    // Nor "move this to tomorrow" with the reminder as the About ref.
    expect(await tools.move_to_tomorrow.execute?.({ ref: `reminder:${r.id}` }, {})).toEqual(refused);
    // The router: never the system, never a job handling a different message.
    const job = h.rt.as({ kind: ActorKind.agent, job: "j", onBehalfOf: "tom", message: "some-other-message" });
    await expect(job.backlog.reminderDone({ id: r.id, sourceMessage: "this-message" })).rejects.toThrow(/PRV-1/);
    await expect(job.backlog.moveReminder({ id: r.id, date: "2026-11-05", sourceMessage: "this-message" })).rejects.toThrow(/PRV-1/);
    await expect(h.rt.system("t").backlog.reminderDone({ id: r.id, sourceMessage: "x" })).rejects.toThrow(/PRV-1|needs a person/);
    await expect(h.rt.system("t").backlog.moveReminder({ id: r.id, date: "2026-11-05", sourceMessage: "x" })).rejects.toThrow(/PRV-1|needs a person/);
    const still = await h.rt.system("t").backlog.getReminder({ id: r.id });
    expect([still?.status, still?.date, still?.time]).toEqual([ReminderStatus.open, WED, "09:00"]);
    // Tom's own tap still works.
    expect(await tapped(`reminder:${r.id}`, ActionKind.snooze)).toBe(`Moved to Thursday 5 November: ${r.text}.`);
    expect(await tapped(`reminder:${r.id}`, ActionKind.done)).toBe(`Done: ${r.text}.`);
  });

  test("[CAP-10] the words name several reminders that are all done, and none open: each is named as done, none other offered", async () => {
    const swim = [] as string[];
    for (const at of ["10", "11"]) {
      expect(await said(`remind me on Friday at ${at} to book the swimming lessons`)).toMatch(/^I'll remind you at /);
      const r = (await h.rt.system("t").backlog.upcomingReminders({ from: MON })).find((x) => x.text.includes("swimming") && !swim.includes(x.id));
      if (r === undefined) throw new Error("no swimming reminder");
      swim.push(r.id);
    }
    for (const id of swim) expect(await tapped(`reminder:${id}`, ActionKind.done)).toMatch(/^Done: /);
    const reply = await said("cancel the swimming reminder");
    expect(reply).toBe("None of those is still on: 10:00 Friday 6 November: Book the swimming lessons (done); 11:00 Friday 6 November: Book the swimming lessons (done). Nothing was changed.");
  });
});
