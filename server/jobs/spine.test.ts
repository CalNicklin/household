import { ActorKind, Limits } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { jobSteps } from "./launch.ts";

let h: TestHousehold;
beforeAll(async () => {
  h = await testHousehold();
});
afterAll(async () => h.close());

describe("message → coordinator → job → agent → tools", () => {
  test("[CAP-1][PLT-1] a thought said in the app is on the backlog for both of us within five seconds", async () => {
    const t0 = Date.now();
    const accepted = await h.sayAndWait("we need to fix the shed roof");
    const elapsed = Date.now() - t0;
    for (const person of ["priya", "tom"]) {
      const items = await h.rt.as({ kind: ActorKind.person, person }).backlog.list();
      expect(items.some((i) => i.text === "Fix the shed roof")).toBe(true);
    }
    // limit: captureBudgetMs
    expect(elapsed).toBeLessThan(Limits.captureBudgetMs.value);
    const job = await h.rt.system("test").jobs.job({ id: accepted.jobId });
    expect(job?.status).toBe("succeeded");
    expect(job?.toolCalls.map((c) => c.tool)).toEqual(["capture"]);
  });

  test("[CH-4] a message delivered twice creates one job, not two", async () => {
    const before = await h.rt.system("test").backlog.list();
    const first = await h.say("descale the kettle", { dedupeKey: "wa:retry-1" });
    const second = await h.say("descale the kettle", { dedupeKey: "wa:retry-1" });
    await h.wait(first);
    expect(second.duplicate).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    const after = await h.rt.system("test").backlog.list();
    expect(after.length - before.length).toBe(1);
  });

  test("[PLT-2] a job's history (steps, tool calls, tokens, cost) can be looked up by its ID", async () => {
    const accepted = await h.sayAndWait("book the boiler service");
    const steps = await jobSteps(accepted.jobId);
    expect(steps.map((s) => s.name)).toEqual(expect.arrayContaining(["start", "load", "agent", "reply", "finish"]));
    const job = await h.rt.system("test").jobs.job({ id: accepted.jobId });
    expect(job?.inputTokens).toBeGreaterThan(0);
    expect(job?.provider).toBe("practice");
  });

  test("[PRV-1] a job cannot delete or edit what a person wrote, or touch rules or the calendar", async () => {
    const agent = h.rt.as({ kind: ActorKind.agent, job: "j", onBehalfOf: "priya", message: "m" });
    const [item] = await h.rt.system("test").backlog.list();
    if (item === undefined) throw new Error("no items");
    await expect(agent.backlog.remove({ id: item.id })).rejects.toThrow(/PRV-1/);
    await expect(agent.backlog.setTags({ id: item.id, tags: [] })).rejects.toThrow(/PRV-1/);
    const [rule] = await h.rt.system("test").household.rules();
    if (rule === undefined) throw new Error("no rules");
    await expect(agent.household.deleteRule({ id: rule.id })).rejects.toThrow(/PRV-1/);
    await expect(agent.household.updateRule({ id: rule.id, spec: rule.spec })).rejects.toThrow(/PRV-1/);
    await expect(agent.household.createRule({ spec: rule.spec })).rejects.toThrow(/PRV-1/);
    await expect(agent.calendar.applySync({ upserts: [], deletedExternalIds: [], syncToken: null })).rejects.toThrow(/PRV-1/);
    await expect(agent.backlog.create({ text: "x", tags: [], createdVia: "app", sourceMessage: "another-message" })).rejects.toThrow(/PRV-1/);
  });
});
