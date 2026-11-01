import { ActionKind, ActorKind, BacklogStatus, BlockType, Limits, LiveTopic, Section, TimerKind, zBacklogItem } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { acceptTimer } from "../coordinator/accept.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { atLocal } from "../time.ts";
import { backlogScreen } from "../views/backlog.ts";
import { screenView } from "../views/screen.ts";
import { waitForJob } from "./launch.ts";

let h: TestHousehold;
const MON = "2026-11-02";
const screen = (person = "priya", date = MON) => screenView(h.rt, person, date);
const morningPlan = async () => {
  const a = await acceptTimer(h.rt, TimerKind.morningPlan, atLocal(MON, 5, 30, "Europe/London"));
  await waitForJob(a.jobId);
};

beforeAll(async () => {
  h = await testHousehold();
  await morningPlan();
});
afterAll(async () => h.close());

describe("Morning glance", () => {
  test("[HOME-1] the home screen shows Now, Later today and Tomorrow from the shared calendar", async () => {
    const s = await screen();
    const sections = [...new Set(s.blocks.map((b) => b.section))];
    expect(sections).toEqual(expect.arrayContaining([Section.now, Section.later, Section.tomorrow]));
    const events = s.blocks.filter((b) => b.type === BlockType.event && b.provenance === "calendar");
    expect(events.map((e) => (e.type === BlockType.event ? e.title : ""))).toEqual(expect.arrayContaining(["Nursery drop-off", "Priya — client call", "Nursery pick-up", "Dinner at Sam's"]));
  });

  test("[HOME-1][CH-6] a calendar change re-plans only the day affected, well within a minute", async () => {
    h.ports.calendar.upsert({ externalId: "g-new", title: "Boiler engineer", start: "2026-11-02T15:00:00Z", end: "2026-11-02T16:00:00Z", allDay: false, attendees: ["tom"], away: [], work: false, soloWithKids: null });
    const before = (await h.rt.system("t").plans.versions({ date: MON })).length;
    const beforeTue = (await h.rt.system("t").plans.versions({ date: "2026-11-03" })).length;
    const t0 = Date.now();
    const a = await h.rt.system("t").jobs.acceptMessage({
      household: "practice",
      person: null,
      channel: "webhook",
      text: "calendar changed",
      attachments: [{ kind: "calendar-change", resourceState: "exists" }],
      dedupeKey: "calendar:test:1",
      receivedAt: new Date().toISOString(),
    });
    const { startMessageJob } = await import("./handle-message.ts");
    await startMessageJob(`job-${a.messageId}`, a.messageId);
    await waitForJob(`job-${a.messageId}`);
    // limit: calendarRefreshMs
    expect(Date.now() - t0).toBeLessThan(Limits.calendarRefreshMs.value);
    expect((await h.rt.system("t").plans.versions({ date: MON })).length).toBe(before + 1);
    expect((await h.rt.system("t").plans.versions({ date: "2026-11-03" })).length).toBe(beforeTue);
    expect((await screen()).blocks.some((b) => b.type === BlockType.event && b.title === "Boiler engineer")).toBe(true);
  });

  test("[HOME-3] every suggestion says why, in one line you could check yourself", async () => {
    const s = await screen();
    const planned = s.blocks.filter((b) => b.type === BlockType.suggestion || b.type === BlockType.alert || b.type === BlockType.backlogPick);
    expect(planned.length).toBeGreaterThan(1);
    for (const b of planned) {
      expect(b.reason.length).toBeGreaterThan(10);
      expect(b.reason).not.toContain("\n");
      expect(b.reason).toMatch(/\d|dry|clear|both|nobody|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|today|tomorrow|morning|evening/i);
    }
    expect(planned.find((b) => b.id === `washing:${MON}`)?.reason).toBe("Dry until 2pm and you're both in all day");
  });

  test("[HOME-4][HOME-5] one tap dismisses a suggestion; the screen updates straight away for everyone, and nothing is ever overdue", async () => {
    const events: string[] = [];
    const off = h.rt.bus.subscribe((e) => events.push(e.topic));
    await h.rt.system("t").plans.responsesOn({ date: MON });
    const a = await h.tap(`washing:${MON}`, ActionKind.notToday, { person: "tom" });
    await h.wait(a);
    off();
    expect(events).toContain("plan");
    for (const person of ["priya", "tom"]) expect((await screen(person)).blocks.some((b) => b.id === `washing:${MON}`)).toBe(false);
    const text = JSON.stringify(await screen());
    expect(text.toLowerCase()).not.toContain("overdue");
    expect(Object.keys(zBacklogItem.shape)).not.toEqual(expect.arrayContaining(["due", "dueDate", "deadline", "priority"]));
  });

  test("[HOME-7] the server decides which blocks appear and in what order", async () => {
    const s = await screen();
    expect(s.blocks[0]?.type).toBe(BlockType.context);
    expect(s.blocks.at(-1)?.type).toBe(BlockType.composer);
    const order = s.blocks.map((b) => b.section).filter((x, i, a) => a.indexOf(x) === i);
    expect(order).toEqual(["header", "now", "later", "tomorrow", "arriving", "fits", "footer"]);
    for (const b of s.blocks) expect(b.placement).toBeDefined();
  });

  test("[HOME-11][PLT-4] tomorrow's plan is ready by 6am, and every version of every day is kept", async () => {
    const tue = await h.rt.system("t").plans.latest({ date: "2026-11-03" });
    expect(tue).not.toBeNull();
    expect(new Date(tue?.createdAt ?? "").getTime()).toBeLessThan(atLocal("2026-11-03", 6, 0, "Europe/London").getTime());
    const versions = await h.rt.system("t").plans.versions({ date: MON });
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions[0]?.inputs).toHaveProperty("facts");
    expect(versions.map((v) => v.version)).toEqual(versions.map((_, i) => i + 1));
  });

  test("[PRO-6] at most one backlog item is offered a day, and each only once", async () => {
    const offers = await h.rt.system("t").plans.offers();
    expect(offers.filter((o) => o.date === MON)).toHaveLength(1);
    // limit: backlogOffersPerDay
    expect(offers.filter((o) => o.date === MON).length).toBeLessThanOrEqual(Limits.backlogOffersPerDay.value);
    const picks = (await screen()).blocks.filter((b) => b.type === BlockType.backlogPick);
    expect(picks.length).toBeLessThanOrEqual(1);
    // Re-planning the same day keeps the same pick; the next day offers a different item.
    const again = await acceptTimer(h.rt, TimerKind.hourlyRefresh, atLocal(MON, 9, 0, "Europe/London"));
    await waitForJob(again.jobId);
    const offersAfter = await h.rt.system("t").plans.offers();
    expect(offersAfter.filter((o) => o.date === MON)).toHaveLength(1);
    const ids = offersAfter.map((o) => o.itemId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("[CAP-4] the backlog has Could go soon (with when), Waiting for the right moment (with what for), and Just added", async () => {
    // A wet week: anything needing dry weather has to wait, and says so.
    for (let d = 0; d < 8; d++) {
      const date = `2026-11-${String(2 + d).padStart(2, "0")}`;
      h.ports.weather.overrides.set(date, Array.from({ length: 16 }, (_, i) => ({ hour: `${date}T${String(6 + i).padStart(2, "0")}:00`, precipitationProbability: 90, temperatureC: 8 })));
    }
    const view = await backlogScreen(h.rt);
    h.ports.weather.overrides.clear();
    expect(view.waiting.find((w) => w.item.text === "Clear the gutters")?.waitingFor).toBe("Needs dry weather, both of us home, daylight and a free hour");
    expect(view.soon.length).toBeGreaterThan(0);
    expect(view.waiting.length).toBeGreaterThan(0);
    for (const s of view.soon) expect(s.slot).toMatch(/^(Today|Tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun) (morning|afternoon|evening)/);
    for (const w of view.waiting) expect(w.waitingFor).toMatch(/^Needs /);
    expect(view.justAdded.map((j) => j.item.text)).toEqual(expect.arrayContaining(["Descale the coffee machine"]));
    expect(view.justAdded[0]?.byline).toMatch(/^(Priya|Tom) · /);
  });

  test("[CAP-5] saying not now three times parks an item; it is not offered again until brought back", async () => {
    const item = (await h.rt.system("t").backlog.list()).find((i) => i.text === "Bleed the radiators");
    if (item === undefined) throw new Error("seed changed");
    // limit: notNowParkThreshold
    for (let i = 0; i < Limits.notNowParkThreshold.value; i++) await h.wait(await h.tap(`backlog:${item.id}`, ActionKind.notToday));
    const parked = await h.rt.system("t").backlog.get({ id: item.id });
    expect(parked?.status).toBe(BacklogStatus.parked);
    expect((await backlogScreen(h.rt)).parked.map((p) => p.id)).toContain(item.id);
    expect([...(await backlogScreen(h.rt)).soon, ...(await backlogScreen(h.rt)).waiting].map((x) => x.item.id)).not.toContain(item.id);
    await h.rt.as({ kind: ActorKind.person, person: "priya" }).backlog.bringBack({ id: item.id });
    expect((await h.rt.system("t").backlog.get({ id: item.id }))?.status).toBe(BacklogStatus.active);
  });

  test("[CAP-3] guessed tags show as chips; one tap fixes a wrong one", async () => {
    await h.sayAndWait("ring the dentist about Ivy");
    const item = (await h.rt.system("t").backlog.list()).find((i) => i.text === "Ring the dentist about Ivy");
    expect(item?.tags).toEqual(expect.arrayContaining(["phone-call", "office-hours"]));
    expect(item?.confirmedTags).toBe(false);
    const fixed = await h.rt.as({ kind: ActorKind.person, person: "priya" }).backlog.setTags({ id: item?.id ?? "", tags: ["quick", "phone-call"] });
    expect(fixed.tags).toEqual(["quick", "phone-call"]);
    expect(fixed.confirmedTags).toBe(true);
  });

  test("[CAP-2] backlog items have no due date and no priority, only tags for what they need", () => {
    expect(Object.keys(zBacklogItem.shape).sort()).toEqual(["confirmedTags", "createdAt", "createdBy", "createdVia", "id", "notNowCount", "status", "tags", "text"]);
  });

  test("[CAP-6] shopping and simple lists live in the app: what is said adds to them, and both of us see the same list straight away", async () => {
    const { schemas } = await import("../runtime.ts");
    expect(Object.keys(schemas.lists)).toEqual(expect.arrayContaining(["lists", "items"]));
    const topics: string[] = [];
    const unsubscribe = h.rt.bus.subscribe((e) => topics.push(e.topic));
    await h.sayAndWait("add wrapping paper to the christmas presents list", { person: "priya" });
    unsubscribe();
    expect(topics).toContain(LiveTopic.lists);
    const seenBy = async (person: string) => (await h.rt.as({ kind: ActorKind.person, person }).lists.list()).find((l) => l.name === "Christmas presents")?.items.map((i) => i.text);
    expect(await seenBy("tom")).toContain("wrapping paper");
    expect(await seenBy("tom")).toEqual(await seenBy("priya"));
  });
});
