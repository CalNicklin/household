import { LongTool } from "@household/contracts";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { jobScope } from "./scope.ts";
import { houseTools } from "./tools.ts";

let h: TestHousehold;
beforeAll(async () => {
  h = await testHousehold({ jobs: false });
});
afterAll(async () => h.close());

/** Calls the tool the way the agent does, with the input a model chose. */
async function sitterBooked(input: { sitter: string; when: string }) {
  const scope = jobScope(h.rt, `job-${input.when}`, `msg-${input.when}`, "tom", "telegram");
  const execute = houseTools(scope).sitter_booked.execute;
  if (execute === undefined) throw new Error("sitter_booked has no execute");
  return { output: await execute(input, {}), scope };
}

async function shop(items: string[]) {
  const scope = jobScope(h.rt, `job-shop-${items.join("-")}`, `msg-shop-${items.join("-")}`, "priya", "app");
  const execute = houseTools(scope).shop.execute;
  if (execute === undefined) throw new Error("shop has no execute");
  return { output: await execute({ items }, {}), scope };
}

describe("PRO-2 through the real tool", () => {
  test("[PRO-2] 'Tuesday 3 November' (what the real model sent for \"Jess's doing Tuesday\") books Tuesday and clears Tuesday's warning", async () => {
    const { output, scope } = await sitterBooked({ sitter: "Jess", when: "Tuesday 3 November" });
    expect(output).toMatchObject({ booked: true, say: "Great, Jess is down for Tuesday 3 November." });
    const bookings = await h.rt.system("t").household.sitterBookings();
    expect(bookings.filter((b) => b.sitter === "Jess").map((b) => b.date)).toEqual(["2026-11-03"]);
    expect(scope.effects.closeRefs).toEqual([{ ref: "sitter:2026-11-03", status: "done" }]);
  });

  test("[PRO-2] a day it can't read books nothing and asks which day, instead of booking today", async () => {
    const before = (await h.rt.system("t").household.sitterBookings()).length;
    const { output, scope } = await sitterBooked({ sitter: "Marta", when: "next week sometime" });
    expect(output).toMatchObject({ booked: false, say: 'Which day is Marta doing? I couldn\'t tell from "next week sometime".' });
    expect((await h.rt.system("t").household.sitterBookings()).length).toBe(before);
    expect(scope.effects.closeRefs).toEqual([]);
  });
});

describe("AUT-1 through the real tool", () => {
  test("[AUT-1] the shop tool says the item will go in the next shop, never that it is already in the basket", async () => {
    const { output, scope } = await shop(["bananas"]);
    expect(output).toMatchObject({ added: false, say: "I'll put bananas in the next shop. The home screen will show which product once it's in." });
    // The basket add happens afterwards, in the helper's own job.
    expect(scope.effects.long).toEqual([{ tool: LongTool.shop, requestId: expect.any(String), sku: null }]);
  });
});

describe("MOM-6 through the real tool", () => {
  test("[MOM-6] handing something over names the person it went to and guesses no pronoun for them", async () => {
    const item = (await h.rt.system("t").backlog.list())[0];
    if (item === undefined) throw new Error("practice backlog is empty");
    const scope = jobScope(h.rt, "job-hand-over", "msg-hand-over", "priya", "app");
    const execute = houseTools(scope).hand_over.execute;
    if (execute === undefined) throw new Error("hand_over has no execute");
    const output = await execute({ ref: `backlog:${item.id}`, to: "Tom" }, {});
    expect(output).toMatchObject({ say: "Okay, Tom has it now, with one message about it." });
    expect(JSON.stringify(output)).not.toMatch(/\b(he|she|him|her|his|hers|they|them|their)\b/i);
    expect(scope.effects.notify.map((n) => n.person)).toEqual(["tom"]);
  });
});

const idOf = (output: unknown) => z.object({ id: z.string() }).parse(output).id;

describe("CAP-1 through the real tool", () => {
  test("[CAP-1] one message that lists two jobs captures both; a retried job, even worded differently, writes each once", async () => {
    const scope = jobScope(h.rt, "job-two-jobs", "msg-two-jobs", "priya", "app");
    const execute = houseTools(scope).capture.execute;
    if (execute === undefined) throw new Error("capture has no execute");
    const gate = idOf(await execute({ text: "Fix the gate" }, {}));
    const shed = await execute({ text: "Paint the shed" }, {});
    expect(shed).toMatchObject({ say: "Added to the backlog: Paint the shed." });
    expect(idOf(shed)).not.toBe(gate);
    // DBOS re-runs the agent step: a fresh scope for the same message, and the model words it anew.
    const retry = jobScope(h.rt, "job-two-jobs", "msg-two-jobs", "priya", "app");
    const again = houseTools(retry).capture.execute;
    if (again === undefined) throw new Error("capture has no execute");
    expect(idOf(await again({ text: "Fix the garden gate" }, {}))).toBe(gate);
    expect(idOf(await again({ text: "Paint the shed, please" }, {}))).toBe(idOf(shed));
    const mine = (await h.rt.system("t").backlog.list()).filter((i) => i.text === "Fix the gate" || i.text === "Paint the shed");
    expect(mine.map((i) => i.text).sort()).toEqual(["Fix the gate", "Paint the shed"]);
  });
});
