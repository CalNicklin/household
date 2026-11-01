import { ExchangeState } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type TestHousehold, testHousehold } from "../testing/household.ts";
import { atLocal, localDate } from "../time.ts";
import { conversationView } from "./conversation.ts";

let h: TestHousehold;

beforeAll(async () => {
  h = await testHousehold();
});
afterAll(async () => h.close());

const at = (date: string, hour: number) => h.ports.clock.set(atLocal(date, hour, 0, h.rt.timeZone).toISOString(), true);

describe("today's conversation with the house (HOU-159)", () => {
  test("[MOM-2][MOM-8] (HOU-159) a question and its follow-up are both shown, oldest first, each with what you said and what the house said", async () => {
    const today = localDate(h.ports.clock.now(), h.rt.timeZone);
    at(today, 9);
    await h.sayAndWait("what should I prioritise today?");
    at(today, 10);
    await h.sayAndWait("we're out of oat milk");
    const view = await conversationView(h.rt, "priya");
    expect(view.map((e) => e.said)).toEqual(["what should I prioritise today?", "we're out of oat milk"]);
    for (const e of view) {
      expect(e.state).toBe(ExchangeState.answered);
      expect(e.reply?.text).not.toBe("");
    }
    // The `what_now` answer keeps the one thing it named; the follow-up is plain words.
    expect(view[0]?.reply?.pick?.title).not.toBeUndefined();
    expect(view[1]?.reply?.pick).toBeNull();
  });

  test("[MOM-8] (HOU-159) one-tap buttons are taps, not things said, so they are not in the conversation", async () => {
    const before = (await conversationView(h.rt, "priya")).length;
    await h.wait(await h.tap("some-block", "not-today"));
    expect(await conversationView(h.rt, "priya")).toHaveLength(before);
  });

  test("[CH-3] (HOU-159) the conversation is person-scoped: Tom's messages and replies are not in Priya's", async () => {
    await h.sayAndWait("ring the plumber", { person: "tom" });
    const priya = await conversationView(h.rt, "priya");
    expect(priya.map((e) => e.said)).not.toContain("ring the plumber");
    expect((await conversationView(h.rt, "tom")).map((e) => e.said)).toEqual(["ring the plumber"]);
  });

  test("[PRV-5] (HOU-159) only today's: tomorrow, yesterday's exchanges are gone", async () => {
    const today = localDate(h.ports.clock.now(), h.rt.timeZone);
    const [y, m, d] = today.split("-").map(Number);
    const tomorrow = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
    at(tomorrow, 7);
    expect(await conversationView(h.rt, "priya")).toEqual([]);
    await h.sayAndWait("what should I prioritise today?");
    expect((await conversationView(h.rt, "priya")).map((e) => e.said)).toEqual(["what should I prioritise today?"]);
  });

  test("[PRV-5] (HOU-159) with message retention off, what you said was never kept, so only the house's reply shows", async () => {
    await h.rt.as({ kind: "person", person: "priya" }).household.updateSettings({ retainMessages: false });
    await h.rt.system("t").jobs.redactAll();
    const view = await conversationView(h.rt, "priya");
    expect(view.length).toBeGreaterThan(0);
    expect(view.every((e) => e.said === null)).toBe(true);
    expect(view.every((e) => e.reply !== null)).toBe(true);
  });
});
