import { ActionKind, type Block, BlockType, Channel, Provenance, ReminderStatus, Section, TimerKind } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { acceptTimer } from "../coordinator/accept.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { atLocal } from "../time.ts";
import { screenView } from "../views/screen.ts";
import { waitForJob } from "./launch.ts";

let h: TestHousehold;
const MON = "2026-11-02";
const TUE = "2026-11-03";
const TZ = "Europe/London";
const replyTo = async (a: { messageId: string }) => (await h.rt.system("t").jobs.replyFor({ id: a.messageId }))?.text ?? "";
const timer = async (kind: TimerKind, date: string, hour: number, minute = 0) => {
  h.ports.clock.set(atLocal(date, hour, minute, TZ), true);
  await waitForJob((await acceptTimer(h.rt, kind, atLocal(date, hour, minute, TZ))).jobId);
};
const reminderBlocks = async (date: string) => (await screenView(h.rt, "priya", date)).blocks.filter((b): b is Extract<Block, { type: "reminder" }> => b.type === BlockType.reminder);

beforeAll(async () => {
  h = await testHousehold();
  await timer(TimerKind.morningPlan, MON, 5, 30);
  h.ports.clock.set(atLocal(MON, 14, 0, TZ), true);
});
afterAll(async () => h.close());

describe("CAP-10: reminders you ask for", () => {
  test("[CAP-10] 'remind us to discuss Wise Owls tonight' shows on Today under Later today for both, grey, then under Now with a message to each at 8pm", async () => {
    const reply = await replyTo(await h.sayAndWait("remind us to discuss Wise Owls tonight"));
    expect(reply).toBe("I'll remind you and Tom at 20:00 today: Discuss Wise Owls.");
    const [block] = await reminderBlocks(MON);
    expect(block).toMatchObject({ section: Section.later, provenance: Provenance.person, time: "20:00", title: "Discuss Wise Owls", detail: "For Priya & Tom" });
    expect(block?.actions.map((a) => a.label)).toEqual(["Done", "Not now"]);
    // Nothing is sent before its time.
    const before = h.ports.messenger.sent.length;
    await timer(TimerKind.reminders, MON, 19, 45);
    expect(h.ports.messenger.sent.length).toBe(before);
    await timer(TimerKind.hourlyRefresh, MON, 20, 0);
    const sent = h.ports.messenger.sent.slice(before).filter((m) => m.text.startsWith("Reminder"));
    expect(sent.map((m) => [m.address, m.text]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["1001", "Reminder: Discuss Wise Owls"],
      ["1002", "Reminder from Priya: Discuss Wise Owls"],
    ]);
    expect(sent[0]?.buttons.map((b) => b.label)).toEqual(["Done", "Later"]);
    expect((await reminderBlocks(MON))[0]?.section).toBe(Section.now);
    // PRO-9: the next look sends nothing again.
    const after = h.ports.messenger.sent.length;
    await timer(TimerKind.reminders, MON, 20, 15);
    expect(h.ports.messenger.sent.length).toBe(after);
  });

  test("[CAP-10] Done takes it off Today", async () => {
    const [block] = await reminderBlocks(MON);
    if (block === undefined) throw new Error("no reminder");
    await h.wait(await h.tap(block.ref, ActionKind.done, { person: "tom", channel: Channel.telegram }));
    expect(await reminderBlocks(MON)).toEqual([]);
    expect((await h.rt.system("t").backlog.getReminder({ id: block.ref.slice("reminder:".length) }))?.status).toBe(ReminderStatus.done);
  });

  test("[CAP-10] Not now moves a reminder to tomorrow, under Tomorrow and then on tomorrow's Today", async () => {
    h.ports.clock.set(atLocal(MON, 20, 20, TZ), true);
    await h.sayAndWait("remind me at 9pm to put the bins out", { person: "tom" });
    const [block] = await reminderBlocks(MON);
    expect(block).toMatchObject({ time: "21:00", detail: "For Tom" });
    if (block === undefined) throw new Error("no reminder");
    expect(await replyTo(await h.tap(block.ref, ActionKind.snooze, { person: "tom" }).then(async (a) => (await h.wait(a), a)))).toBe("Moved to tomorrow: Put the bins out.");
    expect(await reminderBlocks(MON)).toEqual([]);
    expect((await h.rt.system("t").backlog.reminders({ from: TUE, to: TUE })).map((r) => r.text)).toContain("Put the bins out");
  });

  test("[CAP-10][CAP-1] with no time it stays on Today for the rest of the day, then moves to the Backlog as the asker's own item", async () => {
    h.ports.clock.set(atLocal(MON, 21, 0, TZ), true);
    expect(await replyTo(await h.sayAndWait("remind me to ring the dentist"))).toContain("on Today for the rest of the day");
    expect((await reminderBlocks(MON)).find((b) => b.title === "Ring the dentist")).toMatchObject({ section: Section.later, time: null });
    await timer(TimerKind.reminders, MON, 23, 45);
    expect((await reminderBlocks(MON)).some((b) => b.title === "Ring the dentist")).toBe(true);
    await timer(TimerKind.morningPlan, TUE, 5, 30);
    const item = (await h.rt.system("t").backlog.list()).find((i) => i.text === "Ring the dentist");
    expect(item).toMatchObject({ createdBy: "priya", status: "active" });
    expect((await reminderBlocks(TUE)).some((b) => b.title === "Ring the dentist")).toBe(false);
    // The one moved to tomorrow by "Not now" is on Tuesday's Today.
    expect((await reminderBlocks(TUE)).map((b) => b.title)).toContain("Put the bins out");
  });

  test("[CAP-10][PRO-6] reminders are not backlog offers, and a name that is not one of us is asked about, not guessed", async () => {
    // Monday's reminders were never made backlog offers: every offer that day is an existing backlog
    // item, none of them one of the reminders, and Monday's plan offered at most one (PRO-6).
    const items = await h.rt.system("t").backlog.list();
    const mondayOffers = (await h.rt.system("t").plans.offers()).filter((o) => o.date === MON);
    expect(mondayOffers.length).toBeLessThanOrEqual(1);
    for (const o of mondayOffers) expect(["Discuss Wise Owls", "Put the bins out", "Ring the dentist"]).not.toContain(items.find((i) => i.id === o.itemId)?.text);
    h.ports.clock.set(atLocal(TUE, 9, 0, TZ), true);
    expect(await replyTo(await h.sayAndWait("remind Chloe to book swimming"))).toContain("Who should I remind?");
  });
});
