import { ActionKind, ActorKind, type Block, BlockType, Channel, ReminderStatus, TimerKind } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { findReminder } from "../agent/reminders.ts";
import { jobScope } from "../agent/scope.ts";
import { houseTools } from "../agent/tools.ts";
import { acceptTimer } from "../coordinator/accept.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { atLocal } from "../time.ts";
import { screenView } from "../views/screen.ts";
import { waitForJob } from "./launch.ts";

let h: TestHousehold;
const MON = "2026-11-02";
const WED = "2026-11-04";
const TZ = "Europe/London";
const replyTo = async (a: { messageId: string }) => (await h.rt.system("t").jobs.replyFor({ id: a.messageId }))?.text ?? "";
const said = async (text: string, person = "priya") => replyTo(await h.sayAndWait(text, { person }));
const tapped = async (ref: string, action: ActionKind, value?: string) => {
  const a = await h.tap(ref, action, value === undefined ? {} : { value });
  await h.wait(a);
  return replyTo(a);
};
const upcoming = async () => (await h.rt.system("t").backlog.upcomingReminders({ from: MON })).filter((r) => r.text.startsWith("Check BoyBoy"));
const reminderBlocks = async (date: string) => (await screenView(h.rt, "priya", date)).blocks.filter((b): b is Extract<Block, { type: "reminder" }> => b.type === BlockType.reminder);

beforeAll(async () => {
  h = await testHousehold();
  h.ports.clock.set(atLocal(MON, 5, 30, TZ), true);
  await waitForJob((await acceptTimer(h.rt, TimerKind.morningPlan, atLocal(MON, 5, 30, TZ))).jobId);
  h.ports.clock.set(atLocal(MON, 14, 0, TZ), true);
});
afterAll(async () => h.close());

describe("HOU-174: a reminder is moved or cancelled when a person asks, never duplicated", () => {
  test("[CAP-10][PRV-1] Cal's two BoyBoy reminders: re-timing asks which one, never guesses", async () => {
    expect(await said("remind me on Wednesday morning to check BoyBoy's lunchtime nap", "tom")).toBe("I'll remind you at 09:00 Wednesday 4 November: Check BoyBoy's lunchtime nap.");
    expect(await said("remind me on Wednesday at 7:30 to check BoyBoy's lunchtime nap", "tom")).toBe("I'll remind you at 07:30 Wednesday 4 November: Check BoyBoy's lunchtime nap.");
    const reply = await said("make the BoyBoy reminder 7:15", "tom");
    expect(reply).toBe("Which one? 07:30 Wednesday 4 November: Check BoyBoy's lunchtime nap; 09:00 Wednesday 4 November: Check BoyBoy's lunchtime nap. Say its time or what it's about.");
    expect((await upcoming()).map((r) => r.time)).toEqual(["07:30", "09:00"]);
  });

  test("[CAP-10][PRV-1] cancel by phrase: 'cancel the 9 o'clock BoyBoy reminder' cancels that one only", async () => {
    expect(await said("cancel the 9 o'clock BoyBoy reminder", "tom")).toBe("Cancelled the 09:00 reminder Wednesday 4 November: Check BoyBoy's lunchtime nap.");
    expect((await upcoming()).map((r) => r.time)).toEqual(["07:30"]);
    const nine = (await h.rt.system("t").backlog.reminders({ from: WED, to: WED })).find((r) => r.time === "09:00");
    expect(nine).toBeUndefined();
    const all = await h.rt.system("t").backlog.exportPerson({ person: "tom" });
    expect(JSON.stringify(all["reminders"])).toContain(`"time":"09:00","askedBy":"tom","createdVia":"app","status":"${ReminderStatus.cancelled}"`);
  });

  test("[CAP-10][PRV-1] re-time by phrase: with one left, it moves; Cal's own words move it, never set a second", async () => {
    expect(await said("make the BoyBoy reminder 7:15", "tom")).toBe("Moved: Check BoyBoy's lunchtime nap, now at 07:15 Wednesday 4 November.");
    expect(await said("BoyBoy reminder on Wednesday 4th should be earlier than 9 - make it 730", "tom")).toBe("Moved: Check BoyBoy's lunchtime nap, now at 07:30 Wednesday 4 November.");
    expect((await upcoming()).map((r) => [r.date, r.time])).toEqual([[WED, "07:30"]]);
  });

  test("[CAP-10] a description that fits nothing asks, listing what is coming up", async () => {
    expect(await said("cancel the swimming reminder")).toBe("I couldn't tell which reminder you mean. Coming up: 07:30 Wednesday 4 November: Check BoyBoy's lunchtime nap.");
    expect(await upcoming()).toHaveLength(1);
  });

  test("[CAP-10][PRV-1] Change time and Delete on a reminder on Today: a person's tap moves it on the screen, then takes it off", async () => {
    await said("remind me tonight to lock the shed");
    const block = (await reminderBlocks(MON)).find((b) => b.title === "Lock the shed");
    expect(block?.time).toBe("20:00");
    if (block === undefined) throw new Error("no reminder");
    expect(await tapped(block.ref, ActionKind.retime, "21:15")).toBe("Moved: Lock the shed, now at 21:15 today.");
    expect((await reminderBlocks(MON)).find((b) => b.title === "Lock the shed")?.time).toBe("21:15");
    expect(await tapped(block.ref, ActionKind.retime, "13:00")).toBe("13:00 has already gone today. Say a later time.");
    expect(await tapped(block.ref, ActionKind.cancel)).toBe("Cancelled the 21:15 reminder today: Lock the shed.");
    expect((await reminderBlocks(MON)).some((b) => b.title === "Lock the shed")).toBe(false);
    expect(await tapped(block.ref, ActionKind.cancel)).toBe("That reminder was cancelled.");
  });

  test("[PRV-1] the app cannot change or cancel a reminder on its own: not the system, not a job acting on a different message, and not from an email", async () => {
    const [r] = await upcoming();
    if (r === undefined) throw new Error("no reminder");
    const job = h.rt.as({ kind: ActorKind.agent, job: "j", onBehalfOf: "tom", message: "some-other-message" });
    await expect(job.backlog.changeReminder({ id: r.id, date: WED, time: "06:00", sourceMessage: "this-message" })).rejects.toThrow(/PRV-1/);
    await expect(job.backlog.cancelReminder({ id: r.id, sourceMessage: "this-message" })).rejects.toThrow(/PRV-1/);
    await expect(h.rt.system("t").backlog.cancelReminder({ id: r.id, sourceMessage: "x" })).rejects.toThrow(/PRV-1|needs a person/);
    // The reminder they are looking at (the About ref) is used only when it fits what they said (AR-4).
    const app = jobScope(h.rt, "j", "app-message", "tom", Channel.app);
    expect(await findReminder(app, "that one", `reminder:${r.id}`)).toEqual({ reminder: r });
    expect(await findReminder(app, "the swimming reminder", `reminder:${r.id}`)).toMatchObject({ say: expect.stringContaining("I couldn't tell which reminder") });
    // An email's words are someone else's (a forwarded order), never the person asking: neither tool changes anything.
    const email = houseTools(jobScope(h.rt, "j", "email-message", "tom", Channel.email));
    expect(await email.cancel_reminder.execute?.({ which: "the BoyBoy reminder", ref: `reminder:${r.id}` }, {})).toEqual({ cancelled: false, say: "" });
    expect(await email.change_reminder.execute?.({ which: "the BoyBoy reminder", ref: `reminder:${r.id}`, when: "06:00" }, {})).toEqual({ changed: false, say: "" });
    expect((await upcoming()).map((x) => x.time)).toEqual(["07:30"]);
  });

  test("[CAP-10] on the day, one message at the new time and none at the cancelled one", async () => {
    const before = h.ports.messenger.sent.length;
    for (const [hour, minute] of [[7, 30], [9, 0]] as const) {
      h.ports.clock.set(atLocal(WED, hour, minute, TZ), true);
      await waitForJob((await acceptTimer(h.rt, TimerKind.reminders, atLocal(WED, hour, minute, TZ))).jobId);
    }
    expect(h.ports.messenger.sent.slice(before).filter((m) => m.text.includes("BoyBoy")).map((m) => m.text)).toEqual(["Reminder: Check BoyBoy's lunchtime nap"]);
  });
});
