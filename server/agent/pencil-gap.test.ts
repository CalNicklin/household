import { randomBytes } from "node:crypto";
import { ActionKind, ActorKind, Channel } from "@household/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { gatherFacts } from "../planner/gather.ts";
import { pencilValue } from "../planner/pencil.ts";
import { deadlineOf } from "../rules/deadline.ts";
import { allowedGaps, partOfDay } from "../rules/fit.ts";
import { guessTags } from "../rules/tags.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { atLocal } from "../time.ts";
import { HouseAgent } from "./agent.ts";
import { chosenGap, gapReason } from "./pencil-gap.ts";
import { jobScope } from "./scope.ts";

const TZ = "Europe/London";
const MON = "2026-11-02";
const TUE = "2026-11-03";
const FRIDGE = "Clean the garage fridge ready for collection by Friday lunchtime";

let h: TestHousehold;
beforeAll(async () => {
  // The real provider's code path, with the Anthropic API stubbed: no network, and the answer is ours.
  h = await testHousehold({ jobs: false, env: { MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5" } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => h.close());

/** The stubbed model answers `text` to every call, and the prompts it was sent are kept. */
function modelAnswers(text: string): string[] {
  vi.stubEnv("ANTHROPIC_API_KEY", randomBytes(12).toString("base64url"));
  const prompts: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    prompts.push(init.body);
    const body = { id: `msg_${prompts.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", stop_sequence: null, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  return prompts;
}

async function added(text: string, id: string) {
  h.ports.clock.set(atLocal(MON, 9, 0, TZ), true);
  return h.rt.as({ kind: ActorKind.person, person: "cal" }).backlog.create({ text, tags: guessTags(text), createdVia: Channel.app, sourceMessage: id });
}

const pencilTap = (ref: string, message: string) => new HouseAgent(jobScope(h.rt, `job-${message}`, message, "cal", Channel.app)).tap(ref, ActionKind.accept, null);

describe("HOU-178: Pencil it in picks its own time, from the gaps the rules allow", () => {
  test("[PRO-8][CAP-2] the model only sees allowed gaps, and one it answers outside the list falls back to the first allowed gap", async () => {
    const item = await added(FRIDGE, "hou-178-stub");
    h.ports.clock.set(atLocal(TUE, 9, 10, TZ), true);
    const now = h.ports.clock.now();
    const gaps = allowedGaps(await gatherFacts(h.rt, TUE, 7), item, now, TUE, 7, deadlineOf(item, TZ));
    expect(gaps.length).toBeGreaterThan(1);
    const first = gaps[0];
    if (first === undefined) throw new Error("no gap");
    const prompts = modelAnswers("Sunday 8 November morning: the weekend is quieter");
    const result = await pencilTap(`backlog:${item.id}`, "msg-stub");
    // Every gap listed is before Friday lunchtime, and Sunday is not among them.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Needed by Friday lunchtime");
    expect(prompts[0]).not.toContain("Sunday 8 November");
    const [response] = await h.rt.system("t").plans.responsesForRef({ ref: `backlog:${item.id}` });
    expect(response?.value).toBe(pencilValue({ date: first.date, dayPart: partOfDay(first.startHour) }));
    expect(result.reply).toMatch(new RegExp(`^Pencilled in for .+: ${FRIDGE}\\. ${gapReason(first, deadlineOf(item, TZ), TUE).replace(/[.()]/g, "\\$&")}$`));
  });

  test("[PRO-8] a listed gap the model chooses is the one pencilled in, with its reason in a few words", async () => {
    const item = await added("Bleed the radiators upstairs", "hou-178-choice");
    h.ports.clock.set(atLocal(TUE, 9, 10, TZ), true);
    const gaps = allowedGaps(await gatherFacts(h.rt, TUE, 7), item, h.ports.clock.now(), TUE, 7, null);
    const second = gaps[1];
    if (second === undefined) throw new Error("fewer than two gaps");
    modelAnswers("2: you're both home and nothing else is on");
    const result = await pencilTap(`backlog:${item.id}`, "msg-choice");
    const [response] = await h.rt.system("t").plans.responsesForRef({ ref: `backlog:${item.id}` });
    expect(response?.value).toBe(pencilValue({ date: second.date, dayPart: partOfDay(second.startHour) }));
    expect(result.reply).toMatch(/ You're both home and nothing else is on\.$/);
  });

  test("[PRO-8][CAP-2][PRV-1] with no gap allowed nothing is pencilled in, the model is not asked, and the reply says why", async () => {
    const item = await added("Return the hired ladder by Monday", "hou-178-none");
    h.ports.clock.set(atLocal(TUE, 9, 10, TZ), true);
    const prompts = modelAnswers("1");
    const result = await pencilTap(`backlog:${item.id}`, "msg-none");
    expect(result.reply).toBe("There's no free time that suits it before Monday, so I haven't pencilled it in. You could ask for a reminder instead.");
    expect(prompts).toEqual([]);
    expect(await h.rt.system("t").plans.responsesForRef({ ref: `backlog:${item.id}` })).toEqual([]);
    expect(await h.rt.system("t").backlog.get({ id: item.id })).toEqual(item);
  });

  test("[PRO-8] the answer is read strictly: a number on the list, else the first gap with no reason from the model", () => {
    const gaps = [
      { date: TUE, startHour: 17, endHour: 18, who: ["cal"], why: [] },
      { date: "2026-11-05", startHour: 9, endHour: 10, who: ["cal"], why: [] },
    ];
    expect(chosenGap("2: kids at nursery", gaps)).toEqual({ gap: gaps[1], reason: "Kids at nursery." });
    for (const answer of ["3: later", "0", "", "Thursday morning", "-1: no"]) expect(chosenGap(answer, gaps), answer).toEqual({ gap: gaps[0], reason: null });
    expect(chosenGap(`2: ${"long ".repeat(40)}`, gaps).reason).toBeNull();
    expect(chosenGap("2: great time!", gaps).reason).toBeNull();
  });
});
