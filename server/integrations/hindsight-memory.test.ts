import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeServer, json } from "./fake-http.ts";
import { bankId, HindsightMemory } from "./hindsight-memory.ts";

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const zRetain = z.object({ items: z.array(z.object({ content: z.string() })) });

/** A Hindsight stand-in that keeps memories per bank, exactly as the real server scopes them. */
async function fakeHindsight() {
  const banks = new Map<string, string[]>();
  const server = await fakeServer((req, res) => {
    const m = /^\/v1\/default\/banks\/([^/]+)(\/memories(\/recall)?)?$/.exec(new URL(req.path, "http://x").pathname);
    const bank = decodeURIComponent(m?.[1] ?? "");
    if (req.method === "POST" && m?.[2] !== undefined && m[3] === undefined) {
      const body = zRetain.parse(JSON.parse(req.body.toString()));
      banks.set(bank, [...(banks.get(bank) ?? []), ...body.items.map((i) => i.content)]);
      return json(res, 200, { success: true, bank_id: bank, items_count: body.items.length, async: false });
    }
    if (req.method === "POST" && m?.[3] !== undefined) {
      return json(res, 200, { results: (banks.get(bank) ?? []).map((text, i) => ({ id: String(i), text })) });
    }
    if (req.method === "DELETE") {
      banks.delete(bank);
      return json(res, 200, { success: true });
    }
    json(res, 404, { detail: "not found" });
  });
  servers.push(server);
  return { server, banks };
}

describe("Hindsight episodic memory", () => {
  it("[PLT-6] recall never crosses people or houses", async () => {
    const { server } = await fakeHindsight();
    const memory = new HindsightMemory({ baseUrl: server.url });
    const priya = { household: "practice", person: "priya" };
    const tom = { household: "practice", person: "tom" };
    await memory.retain(priya, "Priya dismisses washing suggestions in the evening");
    await memory.retain(tom, "Tom says 'bins' not 'rubbish'");

    expect(await memory.recall(priya, "washing")).toEqual(["Priya dismisses washing suggestions in the evening"]);
    expect(await memory.recall(tom, "washing")).toEqual(["Tom says 'bins' not 'rubbish'"]);
    expect(await memory.recall({ household: "other", person: "priya" }, "washing")).toEqual([]);

    for (const r of server.requests) {
      const path = decodeURIComponent(r.path);
      const bank = /banks\/([^/]+)/.exec(path)?.[1];
      expect(["household-practice-person-priya", "household-practice-person-tom", "household-other-person-priya"]).toContain(bank);
    }
    const recallPaths = server.requests.filter((r) => r.path.endsWith("/recall")).map((r) => decodeURIComponent(r.path));
    expect(recallPaths[0]).toContain("household-practice-person-priya");
    expect(recallPaths[0]).not.toContain("tom");
  });

  it("[PRV-7] forgetting a person deletes their bank", async () => {
    const { server, banks } = await fakeHindsight();
    const memory = new HindsightMemory({ baseUrl: server.url });
    const tom = { household: "practice", person: "tom" };
    await memory.retain(tom, "something");
    await memory.forget(tom);
    expect(banks.has(bankId(tom))).toBe(false);
    expect(await memory.recall(tom, "something")).toEqual([]);
  });

  it("bank ids cannot be steered by odd characters in a name", () => {
    expect(bankId({ household: "practice", person: "../tom" })).toBe("household-practice-person----tom");
  });
});
