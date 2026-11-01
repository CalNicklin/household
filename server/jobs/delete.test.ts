import { readFileSync } from "node:fs";
import path from "node:path";
import { ActorKind, Channel, DeletedThing, ShoppingStatus, TimerKind } from "@household/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { jobScope } from "../agent/scope.ts";
import { houseTools } from "../agent/tools.ts";
import { acceptTimer } from "../coordinator/accept.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { atLocal } from "../time.ts";
import { runView } from "../views/runs.ts";
import { screenView } from "../views/screen.ts";
import { waitForJob } from "./launch.ts";

/** HOU-158: a person deletes from the app, with Undo on the screen; the house itself never can (PRV-1). */
let h: TestHousehold;
const MON = "2026-11-02";
const priya = () => h.rt.as({ kind: ActorKind.person, person: "priya" });
const tom = () => h.rt.as({ kind: ActorKind.person, person: "tom" });
const job = () => h.rt.as({ kind: ActorKind.agent, job: "j-delete", onBehalfOf: "priya", message: "m-delete" });
const system = () => h.rt.system("test");
let redraws = 0;
/** Today's plan drawn again, as the morning timer does. */
const redraw = async () => {
  redraws += 1;
  await waitForJob((await acceptTimer(h.rt, TimerKind.morningPlan, atLocal(MON, 5, 30 + redraws, "Europe/London"))).jobId);
};
const deletions = () => {
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  return () =>
    spy.mock.calls
      .map((c) => (typeof c[0] === "string" && c[0].includes("deleted-by-person") ? z.record(z.string(), z.unknown()).parse(JSON.parse(c[0])) : null))
      .filter((x) => x !== null);
};

beforeAll(async () => {
  h = await testHousehold();
  await redraw();
});
afterAll(async () => h.close());
afterEach(() => vi.restoreAllMocks());

/** The backlog items today's plan offers. */
const offered = async () => (await screenView(h.rt, "priya", MON)).blocks.flatMap((b) => ("ref" in b && b.ref.startsWith("backlog:") ? [b.ref.slice("backlog:".length)] : []));

async function shoppingRequest(item: string, status: ShoppingStatus) {
  const request = await job().shopping.request({ item, sourceMessage: `m-${item}` });
  if (status !== ShoppingStatus.queued) await system().shopping.update({ id: request.id, status, chosen: null, options: [] });
  return request;
}

describe("A person can delete, the house cannot", () => {
  test("[PRV-1] a job or the system cannot delete a backlog item, a list item, a list or a shopping request; a person can", async () => {
    const [item] = await system().backlog.list();
    const [list] = await system().lists.list();
    const listItem = list?.items[0];
    if (item === undefined || list === undefined || listItem === undefined) throw new Error("seed changed");
    const request = await shoppingRequest("Oat milk", ShoppingStatus.saved);
    for (const actor of [job(), system()]) {
      await expect(actor.backlog.remove({ id: item.id })).rejects.toThrow(/PRV-1/);
      await expect(actor.lists.removeItem({ id: listItem.id })).rejects.toThrow(/PRV-1/);
      await expect(actor.lists.removeList({ id: list.id })).rejects.toThrow(/PRV-1/);
      await expect(actor.shopping.remove({ id: request.id })).rejects.toThrow(/PRV-1/);
    }
    expect(await system().backlog.get({ id: item.id })).not.toBeNull();
    expect((await system().lists.list()).find((l) => l.id === list.id)?.items.map((i) => i.id)).toContain(listItem.id);
    expect(await system().shopping.get({ id: request.id })).not.toBeNull();

    await priya().lists.removeItem({ id: listItem.id });
    await priya().shopping.remove({ id: request.id });
    expect((await system().lists.list()).find((l) => l.id === list.id)?.items.map((i) => i.id)).not.toContain(listItem.id);
    expect(await system().shopping.get({ id: request.id })).toBeNull();
  });

  test("[PRV-1] the agent's tools have no way to delete anything", () => {
    const tools = houseTools(jobScope(h.rt, "j-tools", "m-tools", "priya", Channel.app));
    expect(Object.keys(tools).filter((id) => /delete|remove|forget|clear|drop/i.test(id))).toEqual([]);
    const source = readFileSync(path.join(import.meta.dirname, "..", "agent", "tools.ts"), "utf8");
    for (const call of ["backlog.remove", "removeItem", "removeList", "shopping.remove", "deleteRule", "deletePerson", ".delete("]) expect(source, call).not.toContain(call);
  });

  test("[PRV-1] any adult can delete what the other wrote, and the log says who did, never the words", async () => {
    const item = await tom().backlog.create({ text: "Re-grout the bathroom", tags: [], createdVia: Channel.app, sourceMessage: "m-tom-grout" });
    const logged = deletions();
    await priya().backlog.remove({ id: item.id });
    expect(await system().backlog.get({ id: item.id })).toBeNull();
    expect(logged()).toEqual([{ event: "deleted-by-person", what: DeletedThing.backlogItem, id: item.id, by: "priya", writtenBy: "tom" }]);
    expect(JSON.stringify(logged())).not.toContain("grout");
  });

  test("[PRV-1] a deleted backlog item is gone from today's plan when it is next drawn", async () => {
    const [id] = await offered();
    if (id === undefined) throw new Error("today's plan offers no backlog item");
    await tom().backlog.remove({ id });
    await redraw();
    expect(await offered()).not.toContain(id);
  });

  test("[PRV-1][AUT-4] only a shopping request that went nowhere (failed or saved) can be deleted; one the helper is working on, or in the basket, cannot", async () => {
    for (const status of [ShoppingStatus.queued, ShoppingStatus.needsChoice, ShoppingStatus.added, ShoppingStatus.dismissed]) {
      const request = await shoppingRequest(`Bread ${status}`, status);
      await expect(priya().shopping.remove({ id: request.id })).rejects.toThrow(/went nowhere/);
      expect(await system().shopping.get({ id: request.id })).not.toBeNull();
    }
    const failed = await shoppingRequest("Saffron", ShoppingStatus.failed);
    const logged = deletions();
    await tom().shopping.remove({ id: failed.id });
    expect(logged()).toEqual([{ event: "deleted-by-person", what: DeletedThing.shoppingRequest, id: failed.id, by: "tom", writtenBy: "priya" }]);
    // Deleting it again is a no-op, as when two phones delete it at once.
    await expect(tom().shopping.remove({ id: failed.id })).resolves.toBeUndefined();
  });

  test("[AUT-6][PRV-1] a run's log stays openable after a person deletes the request it ran for", async () => {
    const request = await shoppingRequest("Star anise", ShoppingStatus.failed);
    const runId = await system().shopping.addRun({ requestId: request.id, log: [{ at: "2026-11-02T07:01:00.000Z", line: "searched for star anise" }], screenshots: ["runs/x/00-search.png"] });
    await priya().shopping.remove({ id: request.id });
    const run = await runView(h.rt, runId);
    expect(run?.log.map((l) => l.line)).toEqual(["searched for star anise"]);
    expect(run?.screenshots.map((s) => s.name)).toEqual(["00-search.png"]);
    expect(run?.item).toBe("A deleted request");
  });

  test("[PRV-7][AUT-6] deleting everything about a person removes their runs, even one whose request was already deleted", async () => {
    const forTom = h.rt.as({ kind: ActorKind.agent, job: "j-tom", onBehalfOf: "tom", message: "m-tom" });
    const request = await forTom.shopping.request({ item: "Sumac", sourceMessage: "m-tom-sumac" });
    await system().shopping.update({ id: request.id, status: ShoppingStatus.failed, chosen: null, options: [] });
    const runId = await system().shopping.addRun({ requestId: request.id, log: [{ at: "2026-11-02T07:01:00.000Z", line: "searched for sumac" }], screenshots: [] });
    await priya().shopping.remove({ id: request.id });
    expect(await system().shopping.run({ id: runId })).not.toBeNull();
    await system().shopping.deletePerson({ person: "tom" });
    expect(await system().shopping.run({ id: runId })).toBeNull();
  });
});
