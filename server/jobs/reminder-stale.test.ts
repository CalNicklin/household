import { ActionKind, type Block, BlockType, TimerKind } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
const said = async (text: string) => replyTo(await h.sayAndWait(text, { person: "tom" }));
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
