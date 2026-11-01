import { Channel, ExchangeState, JobStatus, ModelProvider } from "@household/contracts";
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

  test("[MOM-2] (HOU-159) an exchange with no reply is waiting while its job runs, quiet when it finished with nothing to say, and failed when its job failed", async () => {
    const api = h.rt.system("t");
    const said = async (text: string) =>
      (
        await api.jobs.acceptMessage({
          household: h.env.HOUSEHOLD_ID,
          person: "priya",
          channel: Channel.app,
          text,
          attachments: [],
          dedupeKey: `test:${text}`,
          receivedAt: h.ports.clock.now().toISOString(),
        })
      ).messageId;
    const finish = (id: string, status: JobStatus) => api.jobs.finishJob({ id, intent: "chat", status, inputTokens: 0, outputTokens: 0, costMicros: 0, durationMs: 0, toolCalls: [], error: status === JobStatus.failed ? "boom" : null });
    const stateOf = async (text: string) => (await conversationView(h.rt, "priya")).find((e) => e.said === text);

    const noJob = await said("no job yet");
    expect(await stateOf("no job yet")).toMatchObject({ id: noJob, state: ExchangeState.waiting, reply: null });

    const running = await said("still running");
    await api.jobs.startJob({ id: `job-${running}`, messageId: running, provider: ModelProvider.practice, model: "practice" });
    expect((await stateOf("still running"))?.state).toBe(ExchangeState.waiting);

    const quiet = await said("nothing to say back");
    await api.jobs.startJob({ id: `job-${quiet}`, messageId: quiet, provider: ModelProvider.practice, model: "practice" });
    await finish(`job-${quiet}`, JobStatus.succeeded);
    expect(await stateOf("nothing to say back")).toMatchObject({ state: ExchangeState.quiet, reply: null });

    const failed = await said("this one breaks");
    await api.jobs.startJob({ id: `job-${failed}`, messageId: failed, provider: ModelProvider.practice, model: "practice" });
    await finish(`job-${failed}`, JobStatus.failed);
    expect(await stateOf("this one breaks")).toMatchObject({ state: ExchangeState.failed, reply: null });
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
    // A tap made today, then retention turned off: redaction empties its attachments, and it is still a tap.
    await h.wait(await h.tap("another-block", "not-today"));
    const before = (await conversationView(h.rt, "priya")).length;
    await h.rt.as({ kind: "person", person: "priya" }).household.updateSettings({ retainMessages: false });
    await h.rt.system("t").jobs.redactAll();
    const view = await conversationView(h.rt, "priya");
    expect(view).toHaveLength(before);
    expect(view.length).toBeGreaterThan(0);
    expect(view.every((e) => e.said === null)).toBe(true);
    expect(view.every((e) => e.reply !== null)).toBe(true);
  });
});
