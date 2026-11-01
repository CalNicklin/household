import { BlockType, Section, TimerKind } from "@household/contracts";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { truncateAndSeed } from "../../practice/seed.ts";
import type { HttpEnv } from "../adapters/registry.ts";
import { firstDayBlocks } from "../planner/first-day.ts";
import type { TestHousehold } from "../testing/household.ts";
import { householdWithApp, loginCookie } from "../testing/http.ts";
import { atLocal, localDate } from "../time.ts";
import { conversationView } from "./conversation.ts";
import { screenView } from "./screen.ts";

let h: TestHousehold;
let app: Hono<HttpEnv>;

beforeAll(async () => {
  ({ h, app } = await householdWithApp());
  // A brand-new house: people and logins only, no calendar, backlog or rules, and no plan.
  await truncateAndSeed(h.env, h.ports.clock.now(), { empty: true });
});
afterAll(async () => h.close());

const today = () => localDate(h.ports.clock.now(), h.rt.timeZone);
/** The practice clock is frozen; step it so each reply is the newest one. */
const tick = () => h.ports.clock.set(new Date(h.ports.clock.now().getTime() + 60_000).toISOString(), true);

async function until<T>(read: () => Promise<T | null>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await read();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

describe("a new or quiet house", () => {
  test("[HOME-11][PLT-1] (HOU-149) a house with no plan for today gets one when the screen is asked for, through a job, without waiting for the timer", async () => {
    expect(await h.rt.system("t").plans.latest({ date: today() })).toBeNull();
    const cookie = await loginCookie(app);
    const res = await app.request(`/api/trpc/screen?input=${encodeURIComponent("{}")}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    await until(() => h.rt.system("t").plans.latest({ date: today() }));
    // It went through the coordinator as a message and a job (PLT-1), not a model call from the view.
    const job = await until(async () => (await h.rt.system("t").jobs.recentJobs()).find((j) => j.intent === `timer:${TimerKind.catchUpPlan}` && j.status !== "running") ?? null);
    expect(job.status).toBe("succeeded");
    // Asking again in the same hour starts nothing new.
    await app.request(`/api/trpc/screen?input=${encodeURIComponent("{}")}`, { headers: { cookie } });
    expect((await h.rt.system("t").jobs.recentJobs()).filter((j) => j.intent === `timer:${TimerKind.catchUpPlan}`)).toHaveLength(1);
  });

  test("[HOME-3][HOME-4] (HOU-149) the first-day home says the house is empty and shows how to start, as planner suggestions with a dismiss", async () => {
    const view = await screenView(h.rt, "priya", today());
    expect(view.blocks[0]?.type).toBe(BlockType.context);
    const start = view.blocks.filter((b) => b.section === Section.start);
    expect(start.map((b) => (b.type === BlockType.suggestion ? b.title : ""))).toEqual([
      "Say a few jobs into the box below",
      "Connect the shared calendar in Settings",
      "Ask “if I do one thing, what should it be?”",
    ]);
    for (const b of start) {
      expect(b.provenance).toBe("planner");
      expect(b.reason).not.toBe("");
      expect(b.type === BlockType.suggestion ? b.actions.map((a) => a.kind) : []).toEqual(["not-today"]);
    }
    expect(view.blocks.at(-1)?.type).toBe(BlockType.composer);
  });

  test("[MOM-2] (HOU-149) 'what should I prioritise today?' on an empty house is one plain answer, never an error or a list", async () => {
    tick();
    const a = await h.sayAndWait("what should I prioritise today?");
    const reply = (await h.rt.system("t").jobs.replyFor({ id: a.messageId }))?.text ?? "";
    expect(reply).not.toContain("?");
    expect(reply.split(/(?<=[.!])\s+/).length).toBeLessThanOrEqual(3);
    const [latest] = await conversationView(h.rt, "priya");
    // Monday morning is dry and nobody is known to be out, so the washing rule is the one thing.
    expect(latest?.pick).toEqual({ title: "Hang the washing out", why: expect.stringMatching(/dry/i) });
  });

  test("[MOM-2] (HOU-149) with nothing at all to suggest, the answer is 'Nothing pressing today'", async () => {
    const washing = (await screenView(h.rt, "priya", today())).blocks.find((b) => b.type === BlockType.suggestion && b.title === "Hang the washing out");
    expect(washing?.type).toBe(BlockType.suggestion);
    tick();
    await h.wait(await h.tap(washing !== undefined && "ref" in washing ? washing.ref : "", "not-today"));
    tick();
    const a = await h.sayAndWait("what should I prioritise today?");
    expect((await h.rt.system("t").jobs.replyFor({ id: a.messageId }))?.text).toBe("Nothing pressing today. No rule, calendar entry or quick backlog job needs doing now.");
    const [latest] = await conversationView(h.rt, "priya");
    expect(latest?.pick).toEqual({ title: "Nothing pressing today", why: "No rule, calendar entry or quick backlog job needs doing now." });
  });

  test("[MOM-2] (HOU-149) once a few jobs are said, the one thing is the oldest small one, with its reason", async () => {
    tick();
    await h.sayAndWait("ring the dentist");
    tick();
    await h.sayAndWait("fix the gate");
    tick();
    const a = await h.sayAndWait("if I do one thing, what should it be?");
    const reply = (await h.rt.system("t").jobs.replyFor({ id: a.messageId }))?.text ?? "";
    expect(reply).toMatch(/^Ring the dentist\. /);
    const [latest] = await conversationView(h.rt, "priya");
    expect(latest?.pick?.title).toBe("Ring the dentist");
    expect(latest?.pick?.why).toMatch(/oldest|fifteen minutes/);
  });

  test("[HOME-4] (HOU-149) 'Not now' on a Getting started card hides it, and nothing is learned or remembered from it", async () => {
    tick();
    const a = await h.tap("start:ask", "not-today");
    await h.wait(a);
    expect((await h.rt.system("t").jobs.replyFor({ id: a.messageId }))?.text).toBe("Okay, not now.");
    expect((await screenView(h.rt, "priya", today())).blocks.map((b) => b.id)).not.toContain("start:ask");
    expect([...h.ports.memory.banks.values()].flat().filter((m) => m.includes("Ask “if I do one thing"))).toEqual([]);
  });

  test("[PRO-7][MOM-2] (HOU-149) the thin-house fallback waits out the asker's own quiet hours, not the defaults", async () => {
    const at = (hour: number) => h.ports.clock.set(atLocal(today(), hour, 0, h.rt.timeZone).toISOString(), true);
    const ask = async () => {
      const a = await h.sayAndWait("what should I prioritise today?");
      return (await h.rt.system("t").jobs.replyFor({ id: a.messageId }))?.text ?? "";
    };
    at(21);
    await h.sayAndWait("descale the kettle");
    await h.rt.as({ kind: "person", person: "priya" }).household.updateMySettings({ quietStartHour: 0, quietEndHour: 6 });
    // 23:00 is past the day's last slot, so only the fallback can answer; 23:00 is inside the defaults' quiet hours, not Priya's.
    at(23);
    expect(await ask()).toMatch(/^Descale the kettle\. /);
    await h.rt.as({ kind: "person", person: "priya" }).household.updateMySettings({ quietStartHour: 21, quietEndHour: 7 });
    at(23);
    tick();
    expect(await ask()).toMatch(/^Nothing pressing today\./);
  });

  test("[HOME-3] (HOU-149) saying a job redraws today at once, so 'the backlog is empty' is never left up", async () => {
    const ids = (await screenView(h.rt, "priya", today())).blocks.map((b) => b.id);
    expect(ids).not.toContain("start:backlog");
    expect(ids).toContain("start:calendar");
  });
});

describe("first-day blocks", () => {
  test("[HOME-7] (HOU-149) they show only while the house is thin, and only the ones that apply", () => {
    expect(firstDayBlocks({ calendarConnected: true, backlogItems: 4 })).toEqual([]);
    expect(firstDayBlocks({ calendarConnected: true, backlogItems: 0 }).map((b) => b.id)).toEqual(["start:backlog", "start:ask"]);
    expect(firstDayBlocks({ calendarConnected: false, backlogItems: 3 }).map((b) => b.id)).toEqual(["start:calendar", "start:ask"]);
  });
});

