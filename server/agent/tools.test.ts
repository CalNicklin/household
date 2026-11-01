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
    expect(scope.effects.shopping).toHaveLength(1);
    expect(scope.effects.shopping[0]?.sku).toBeNull();
  });
});
