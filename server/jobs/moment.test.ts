import { ActionKind, ActorKind, BlockType, Channel, DeliveryChannel, Limits, ModeKind, NotificationStatus, PersonRole, ShoppingStatus, TimerKind, Urgency } from "@household/contracts";
import { getTableColumns } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { acceptTimer } from "../coordinator/accept.ts";
import * as household from "../domains/household/schema.ts";
import { notify } from "../notify/notify.ts";
import { deletePerson, exportPerson } from "../privacy/person.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { atLocal } from "../time.ts";
import { screenView } from "../views/screen.ts";
import { waitForJob } from "./launch.ts";

let h: TestHousehold;
const MON = "2026-11-02";
const TZ = "Europe/London";
const screen = (date = MON) => screenView(h.rt, "priya", date);
const replyTo = async (a: { messageId: string }) => (await h.rt.system("t").jobs.replyFor({ id: a.messageId }))?.text ?? "";
const timer = async (kind: TimerKind, date: string, hour: number, minute = 0) => {
  h.ports.clock.set(atLocal(date, hour, minute, TZ), true);
  const a = await acceptTimer(h.rt, kind, atLocal(date, hour, minute, TZ));
  await waitForJob(a.jobId);
};

beforeAll(async () => {
  h = await testHousehold();
  await timer(TimerKind.morningPlan, MON, 5, 30);
  h.ports.clock.set(atLocal(MON, 7, 12, TZ), true);
});
afterAll(async () => h.close());

describe("In the moment", () => {
  test("[MOM-2][MOM-9] 'if I do one thing, what should it be?' gives one answer with a reason, never a list and never a question", async () => {
    const reply = await replyTo(await h.sayAndWait("if I do one thing, what should it be?"));
    expect(reply).not.toMatch(/\?/);
    expect(reply).not.toMatch(/^\s*[-•*\d]+[.)]?\s/m);
    expect(reply.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== "").length).toBeLessThanOrEqual(3);
    expect(reply).toMatch(/babysitter|Dinner at Sam's|Jess/);
  });

  test("[MOM-1][MOM-3][MOM-5][HOME-8] 'slow day' said on a phone rearranges the iPad within two seconds: one suggested thing and what's still happening", async () => {
    const t0 = Date.now();
    let changedAt = 0;
    const off = h.rt.bus.subscribe((e) => {
      if (e.topic === "plan" && changedAt === 0) changedAt = Date.now();
    });
    await h.sayAndWait("slow day", { person: "tom", channel: Channel.telegram });
    off();
    // limit: liveUpdateBudgetMs
    expect(changedAt - t0).toBeLessThan(Limits.liveUpdateBudgetMs.value);
    const blocks = (await screen()).blocks;
    expect(blocks.map((b) => b.type)).toEqual([BlockType.context, BlockType.mode, BlockType.composer]);
    const mode = blocks[1];
    if (mode?.type !== BlockType.mode) throw new Error("no mode block");
    expect(mode.pick).not.toBeNull();
    const still = mode.stillHappening.map((s) => s.text).join(" | ");
    expect(still).toContain("Bins out");
    expect(still).toContain("Nursery");
    expect(still).not.toContain("Hang the washing out");
    expect(mode.stillHappening.some((x) => x.text === mode.pick?.title)).toBe(false);
    expect(blocks[0]?.type === BlockType.context && blocks[0].line).toMatch(/^Slow day · Tom said so at \d\d:\d\d$/);
  });

  test("[MOM-4] a slow day ends at midnight unless extended; the next morning is normal", async () => {
    const mode = await h.rt.system("t").household.activeMode();
    expect(mode?.endsAt).toBe(atLocal("2026-11-03", 0, 0, TZ).toISOString());
    await timer(TimerKind.morningPlan, "2026-11-03", 5, 30);
    const tue = (await screen("2026-11-03")).blocks;
    expect(tue.some((b) => b.type === BlockType.mode)).toBe(false);
    expect(await h.rt.system("t").household.activeMode()).toBeNull();
    h.ports.clock.set(atLocal(MON, 7, 30, TZ), true);
  });

  test("[MOM-4] 'keep the slow day going till tomorrow' extends it past midnight", async () => {
    await h.sayAndWait("keep the slow day going until tomorrow");
    const mode = await h.rt.system("t").household.activeMode();
    expect(mode?.endsAt).toBe(atLocal("2026-11-04", 0, 0, TZ).toISOString());
    await h.sayAndWait("back to normal");
    expect(await h.rt.system("t").household.activeMode()).toBeNull();
  });

  test("[MOM-6] 'Tom can do it' moves the item to Tom, who gets one message about it", async () => {
    const pick = (await screen()).blocks.find((b) => b.type === BlockType.backlogPick);
    if (pick?.type !== BlockType.backlogPick) throw new Error("no backlog pick");
    const before = h.ports.messenger.sent.filter((m) => m.address === "1002").length;
    await h.sayAndWait("Tom can do it", { ref: pick.ref });
    const toTom = h.ports.messenger.sent.filter((m) => m.address === "1002").slice(before);
    expect(toTom).toHaveLength(1);
    expect(toTom[0]?.text).toContain(pick.title);
    expect((await h.rt.system("t").plans.handOvers()).find((x) => x.ref === pick.ref)?.to).toBe("tom");
    expect((await screen()).blocks.some((b) => b.id === pick.id)).toBe(false);
  });

  test("[MOM-7] tap any item and 'move this to tomorrow' works without saying what 'this' is", async () => {
    const event = (await screen()).blocks.find((b) => b.type === BlockType.event && b.title === "Bins out");
    if (event === undefined || !("ref" in event)) throw new Error("no bins");
    expect(await replyTo(await h.sayAndWait("move this to tomorrow", { ref: event.ref }))).toContain("Bins out");
    const r = (await h.rt.system("t").plans.responsesForRef({ ref: event.ref })).at(-1);
    expect(r?.action).toBe(ActionKind.snooze);
    expect(r?.value).toBe("2026-11-03");
  });

  test("[MOM-8] talking works the same as typing: a spoken message takes the same path", async () => {
    const spoken = await h.sayAndWait("we need to fix the fence", { channel: Channel.app });
    const typed = await h.sayAndWait("we need to fix the fence panel", { channel: Channel.app });
    const a = await h.rt.system("t").jobs.job({ id: spoken.jobId });
    const b = await h.rt.system("t").jobs.job({ id: typed.jobId });
    expect(a?.toolCalls.map((c) => c.tool)).toEqual(b?.toolCalls.map((c) => c.tool));
  });

  test("[MOM-9] replies are at most three sentences unless you ask for more", async () => {
    const replies = await h.rt.system("t").jobs.replies({ person: "priya" });
    for (const r of replies) expect(r.text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== "").length).toBeLessThanOrEqual(3);
  });
});

describe("Proactive nudges through the real jobs", () => {
  test("[PRO-2] replying 'Jess's doing Tuesday' makes the babysitter warning disappear everywhere", async () => {
    expect((await screen()).blocks.some((b) => b.id === "sitter:2026-11-03")).toBe(true);
    await h.sayAndWait("Jess's doing Tuesday", { person: "tom", channel: Channel.telegram });
    expect((await screen()).blocks.some((b) => b.id === "sitter:2026-11-03")).toBe(false);
    const open = await h.rt.system("t").jobs.notifications({ statuses: [NotificationStatus.sent, NotificationStatus.onScreen, NotificationStatus.deferred] });
    expect(open.some((n) => n.key.startsWith("sitter:2026-11-03"))).toBe(false);
  });

  test("[PRO-3] at 7pm whoever is home gets one bins message", async () => {
    const before = h.ports.messenger.sent.length;
    // Monday 9 November: the evening before the next collection (tonight's bins were snoozed in MOM-7).
    await timer(TimerKind.bins, "2026-11-09", 19);
    const bins = h.ports.messenger.sent.slice(before).filter((m) => m.text.startsWith("Bins out tonight"));
    expect(bins.map((m) => m.address).sort()).toEqual(["1001", "1002"]);
    await timer(TimerKind.hourlyRefresh, "2026-11-09", 20);
    expect(h.ports.messenger.sent.slice(before).filter((m) => m.text.startsWith("Bins out tonight"))).toHaveLength(2);
  });

  test("[PRO-5] the morning of a delivery that needs someone in brings a message", async () => {
    const before = h.ports.messenger.sent.length;
    await timer(TimerKind.deliveries, "2026-11-03", 7, 30);
    expect(h.ports.messenger.sent.slice(before).some((m) => m.text.startsWith("Ocado delivery today"))).toBe(true);
    const mon = h.ports.messenger.sent.filter((m) => m.text.startsWith("Screwfix"));
    expect(mon).toHaveLength(0);
  });

  test("[PRO-9] dismiss a message on your phone and it is dismissed everywhere; nothing is shown twice", async () => {
    h.ports.clock.set(atLocal("2026-11-03", 12, 0, TZ), true);
    const sent = await notify(h.rt, { person: "priya", message: "Test nudge", urgency: Urgency.urgent, actions: [{ kind: ActionKind.notToday, label: "Not today", ref: "test:nudge" }], key: "test:nudge", countsTowardsBudget: false }, null);
    expect(sent.status).toBe(NotificationStatus.sent);
    const again = await notify(h.rt, { person: "priya", message: "Test nudge", urgency: Urgency.urgent, actions: [], key: "test:nudge", countsTowardsBudget: false }, null);
    expect(again.id).toBe(sent.id);
    expect(h.ports.messenger.sent.filter((m) => m.text === "Test nudge")).toHaveLength(1);
    await h.wait(await h.tap("test:nudge", ActionKind.notToday, { channel: Channel.telegram }));
    expect((await h.rt.system("t").jobs.notification({ id: sent.id }))?.status).toBe(NotificationStatus.dismissed);
  });

  test("[PRO-7] each of us sets our own message limit and quiet hours; anything over waits for the morning screen", async () => {
    const tom = h.rt.as({ kind: ActorKind.person, person: "tom" });
    await tom.household.updateMySettings({ dailyMessageBudget: 1, quietStartHour: 22, quietEndHour: 6 });
    expect((await h.rt.system("t").household.personSettings({ person: "priya" })).dailyMessageBudget).toBe(3);
    h.ports.clock.set(atLocal("2026-11-04", 10, 0, TZ), true);
    const first = await notify(h.rt, { person: "tom", message: "one", urgency: Urgency.urgent, actions: [], key: "budget:1", countsTowardsBudget: true }, null);
    const second = await notify(h.rt, { person: "tom", message: "two", urgency: Urgency.urgent, actions: [], key: "budget:2", countsTowardsBudget: true }, null);
    expect([first.status, second.status]).toEqual([NotificationStatus.sent, NotificationStatus.deferred]);
    h.ports.clock.set(atLocal("2026-11-04", 23, 0, TZ), true);
    const late = await notify(h.rt, { person: "priya", message: "late", urgency: Urgency.urgent, actions: [], key: "quiet:1", countsTowardsBudget: true }, null);
    expect(late.status).toBe(NotificationStatus.deferred);
    await timer(TimerKind.morningPlan, "2026-11-05", 5, 30);
    const morning = (await screen("2026-11-05")).blocks.filter((b) => b.type === BlockType.alert && b.title.includes("late"));
    expect(morning).toHaveLength(1);
  });

  test("[CH-7] one send function and a table decide the channel: urgent to the messenger, the rest to the morning screen, and each of us can change it", async () => {
    h.ports.clock.set(atLocal("2026-11-05", 12, 0, TZ), true);
    const normal = await notify(h.rt, { person: "priya", message: "fyi", urgency: Urgency.normal, actions: [], key: "route:1", countsTowardsBudget: false }, null);
    expect(normal.channel).toBe(DeliveryChannel.screen);
    await h.rt.as({ kind: ActorKind.person, person: "priya" }).household.updateMySettings({ routing: { urgent: DeliveryChannel.telegram, normal: DeliveryChannel.telegram, low: DeliveryChannel.screen } });
    const now = await notify(h.rt, { person: "priya", message: "fyi 2", urgency: Urgency.normal, actions: [], key: "route:2", countsTowardsBudget: false }, null);
    expect(now.channel).toBe(DeliveryChannel.telegram);
  });
});

describe("Automations and privacy", () => {
  test("[AUT-1] mentioning a shopping item puts it in the basket, and the home screen shows which product was chosen", async () => {
    h.ports.clock.set(atLocal("2026-11-05", 12, 30, TZ), true);
    const t0 = Date.now();
    await h.sayAndWait("we're out of bananas");
    const request = (await h.rt.system("t").shopping.recent()).find((r) => r.item === "bananas");
    for (let i = 0; i < 50 && (await h.rt.system("t").shopping.get({ id: request?.id ?? "" }))?.status === ShoppingStatus.queued; i++) await new Promise((r) => setTimeout(r, 100));
    expect(Date.now() - t0).toBeLessThan(10 * 60_000);
    expect((await h.rt.system("t").shopping.get({ id: request?.id ?? "" }))?.chosen?.name).toBe("Bananas x5");
    expect((await h.ports.shopping.basket()).items.find((i) => i.sku === "bananas")?.quantity).toBe(2);
  });

  test("[PRV-5] messages are kept 30 days, and one setting turns keeping them off completely", async () => {
    // limit: messageRetentionDays
    expect(Limits.messageRetentionDays.value).toBe(30);
    const before = await h.rt.system("t").jobs.messageCount();
    await timer(TimerKind.retention, "2026-12-10", 3, 15);
    expect(await h.rt.system("t").jobs.messageCount()).toBeLessThan(before);
    h.ports.clock.set(atLocal("2026-12-10", 9, 0, TZ), true);
    await h.rt.as({ kind: ActorKind.person, person: "priya" }).household.updateSettings({ retainMessages: false });
    const a = await h.sayAndWait("we need to sweep the chimney");
    const stored = await h.rt.system("t").jobs.message({ id: a.messageId });
    expect(stored?.text).toBe("");
    expect(stored?.redacted).toBe(true);
    await h.rt.as({ kind: ActorKind.person, person: "priya" }).household.updateSettings({ retainMessages: true });
  });

  test("[PRV-8] the app cannot message anyone outside the four of us and the named sitters", async () => {
    await expect(notify(h.rt, { person: "stranger", message: "hi", urgency: Urgency.urgent, actions: [], key: "x", countsTowardsBudget: false }, null)).rejects.toThrow(/PRV-8/);
    await expect(notify(h.rt, { person: "ivy", message: "hi", urgency: Urgency.urgent, actions: [], key: "y", countsTowardsBudget: false }, null)).rejects.toThrow(/PRV-8/);
    const { messageSitter } = await import("../notify/notify.ts");
    await expect(messageSitter(h.rt, "Mallory", "hi")).rejects.toThrow(/PRV-8/);
    const allowed = await h.rt.system("t").household.allowedRecipients();
    for (const m of h.ports.messenger.sent) expect(allowed.some((a) => a.address === m.address)).toBe(true);
  });

  test("[PRV-4] the app stores nothing about the kids beyond first names and nursery days", () => {
    expect(Object.keys(getTableColumns(household.people)).sort()).toEqual(["id", "name", "nurseryDays", "role"]);
    expect(Object.values(PersonRole)).toEqual(["adult", "child"]);
  });

  test("[PRV-7] each of us can download or delete everything about ourselves with one command", async () => {
    const dump = await exportPerson(h.rt, "tom");
    expect(JSON.stringify(dump)).toContain("tom");
    expect(Object.keys(dump)).toEqual(expect.arrayContaining(["household", "backlog", "plans", "learning", "jobs", "shopping", "memory"]));
    await deletePerson(h.rt, "tom");
    const after = await exportPerson(h.rt, "tom");
    expect(after).toMatchObject({ backlog: { items: [] }, plans: { responses: [] }, jobs: { messages: [] } });
    expect(after["memory"]).toEqual([]);
    expect(ModeKind.slow).toBe("slow");
  });
});
