import { ActorKind, ListItemSource, ListWriteOutcome } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { deletePerson, exportPerson } from "../privacy/person.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";

let h: TestHousehold;
beforeAll(async () => {
  h = await testHousehold();
});
afterAll(async () => h.close());

const priya = () => h.rt.as({ kind: ActorKind.person, person: "priya" }).lists;
const tom = () => h.rt.as({ kind: ActorKind.person, person: "tom" }).lists;
const job = (message = "m-1") => h.rt.as({ kind: ActorKind.agent, job: "job-1", onBehalfOf: "priya", message }).lists;
const listNamed = async (name: string) => {
  const list = (await priya().list()).find((l) => l.name === name);
  if (list === undefined) throw new Error(`no list ${name}`);
  return list;
};
async function freshList(name: string, items: string[] = []) {
  const { id } = await priya().createList({ name, emoji: "🧺" });
  for (const text of items) await priya().addItem({ listId: id, text, sourceMessage: null });
  return listNamed(name);
}

describe("Shared lists (CAP-6)", () => {
  test("[CAP-6] the practice household's lists are seeded into the lists domain, in order, with their emoji and ticks", async () => {
    const lists = await priya().list();
    expect(lists.map((l) => `${l.emoji} ${l.name}`).slice(0, 2)).toEqual(["🛒 Shopping", "🎁 Christmas presents"]);
    const shopping = await listNamed("Shopping");
    expect(shopping.items.map((i) => [i.text, i.checked])).toEqual([
      ["washing-up liquid", false],
      ["bin bags", false],
      ["kitchen roll", true],
    ]);
  });

  test("[CAP-6] tick and untick (ticked items stay, struck through), add, rename and delete; the other adult sees the same list; every change goes live", async () => {
    const topics: string[] = [];
    const unsubscribe = h.rt.bus.subscribe((e) => topics.push(e.topic));
    const list = await freshList("Weekend", ["sun cream", "hats"]);
    const [sunCream, hats] = list.items;
    if (sunCream === undefined || hats === undefined) throw new Error("items missing");

    await priya().setChecked({ id: sunCream.id, checked: true });
    expect((await tom().list()).find((l) => l.id === list.id)?.items.map((i) => [i.text, i.checked])).toEqual([
      ["sun cream", true],
      ["hats", false],
    ]);
    await tom().setChecked({ id: sunCream.id, checked: false });
    const renamed = await tom().renameItem({ id: hats.id, text: "  sun hats " });
    expect(renamed).toMatchObject({ outcome: ListWriteOutcome.renamed, item: { text: "sun hats" } });
    await priya().removeItem({ id: sunCream.id });
    await priya().updateList({ id: list.id, name: "Beach weekend", emoji: "🏖️" });

    const seen = (await tom().list()).find((l) => l.id === list.id);
    expect(seen).toMatchObject({ name: "Beach weekend", emoji: "🏖️" });
    expect(seen?.items.map((i) => [i.text, i.checked])).toEqual([["sun hats", false]]);
    unsubscribe();
    expect(topics.filter((t) => t === "lists").length).toBeGreaterThanOrEqual(7);

    await tom().removeList({ id: list.id });
    expect((await priya().list()).some((l) => l.id === list.id)).toBe(false);
  });

  test("[CAP-6] a new list goes after the others; new items go at the bottom", async () => {
    const before = await priya().list();
    const list = await freshList("Garden centre", ["compost", "bulbs"]);
    expect(list.position).toBeGreaterThan(Math.max(...before.map((l) => l.position)));
    expect(list.items.map((i) => i.text)).toEqual(["compost", "bulbs"]);
    expect(list.items[1]?.position).toBeGreaterThan(list.items[0]?.position ?? Infinity);
  });

  test("[CAP-6] an item is on a list once, ignoring case and surrounding spaces; fixing its capitalisation still works", async () => {
    const list = await freshList("Dup check", ["Bin bags", "Milk"]);
    const again = await tom().addItem({ listId: list.id, text: "  bin BAGS ", sourceMessage: null });
    expect(again.outcome).toBe(ListWriteOutcome.duplicate);
    expect(again.item.text).toBe("Bin bags");
    const [binBags, milk] = list.items;
    expect((await priya().renameItem({ id: milk?.id ?? "", text: "BIN BAGS" })).outcome).toBe(ListWriteOutcome.duplicate);
    expect((await priya().renameItem({ id: binBags?.id ?? "", text: "bin bags" })).outcome).toBe(ListWriteOutcome.renamed);
    expect((await listNamed("Dup check")).items.map((i) => i.text)).toEqual(["bin bags", "Milk"]);
    // The same thing on a different list is fine.
    const other = await freshList("Other", []);
    expect((await priya().addItem({ listId: other.id, text: "milk", sourceMessage: null })).outcome).toBe(ListWriteOutcome.added);
  });

  test("[CAP-6] the duplicate rule is enforced in the database too, so two phones racing cannot both add it", async () => {
    const list = await freshList("Race", ["Eggs"]);
    const raw = h.rt.dbs.lists.$client;
    await expect(raw.query("insert into items (id, list_id, text, source) values ('race-1', $1, ' EGGS ', 'person')", [list.id])).rejects.toMatchObject({ code: "23505" });
    const results = await Promise.all([priya().addItem({ listId: list.id, text: "Flour", sourceMessage: null }), tom().addItem({ listId: list.id, text: "flour ", sourceMessage: null })]);
    expect(results.map((r) => r.outcome).sort()).toEqual([ListWriteOutcome.added, ListWriteOutcome.duplicate]);
    expect((await listNamed("Race")).items.map((i) => i.text.toLowerCase())).toEqual(["eggs", "flour"]);
  });
});

describe("The house only ever adds to a list (PRV-1)", () => {
  test("[CAP-6][PRV-1] anything said adds to a list, as the person who said it; saying it again does not add it twice", async () => {
    await h.sayAndWait("add wrapping paper to the christmas presents list", { person: "tom" });
    await h.sayAndWait("add Wrapping paper to the christmas presents list", { person: "priya" });
    const presents = await listNamed("Christmas presents");
    const added = presents.items.filter((i) => i.text.toLowerCase() === "wrapping paper");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ source: ListItemSource.agent, createdBy: "tom", checked: false });
    expect(presents.items.map((i) => i.text).slice(0, 2)).toEqual(["Lego for Noah", "Book for Ivy"]);
  });

  test("[CAP-6][AUT-1] 'add … to the shopping list' goes on the Shopping list; 'we're out of …' still goes to the supermarket", async () => {
    await h.sayAndWait("add batteries to the shopping list", { person: "tom" });
    expect((await listNamed("Shopping")).items.map((i) => i.text)).toContain("batteries");
    const requests = await h.rt.system("test").shopping.recent();
    expect(requests.map((r) => r.item)).not.toContain("batteries");
    await h.sayAndWait("we're out of oat milk", { person: "tom" });
    expect((await h.rt.system("test").shopping.recent()).map((r) => r.item)).toContain("oat milk");
    expect((await listNamed("Shopping")).items.map((i) => i.text)).not.toContain("oat milk");
  });

  test("[CAP-6][PLT-2] a job step re-run after a crash does not add its item again, even if someone renamed it in between", async () => {
    const list = await freshList("Replay", []);
    const first = await job("m-replay").addItem({ listId: list.id, text: "String", sourceMessage: "m-replay" });
    expect(first.outcome).toBe(ListWriteOutcome.added);
    await tom().renameItem({ id: first.item.id, text: "Garden twine" });
    const replay = await job("m-replay").addItem({ listId: list.id, text: "String", sourceMessage: "m-replay" });
    expect(replay).toMatchObject({ outcome: ListWriteOutcome.duplicate, item: { id: first.item.id, text: "Garden twine" } });
    expect((await listNamed("Replay")).items.map((i) => i.text)).toEqual(["Garden twine"]);
    // A different message asking for the same thing again is a new add.
    expect((await job("m-later").addItem({ listId: list.id, text: "String", sourceMessage: "m-later" })).outcome).toBe(ListWriteOutcome.added);
  });

  test("[PRV-1] a job can add an item, but never delete, rename, tick or untick one a person wrote, or change a list", async () => {
    const list = await freshList("Guarded", ["Batteries", "Tape"]);
    const [batteries, tape] = list.items;
    if (batteries === undefined || tape === undefined) throw new Error("items missing");
    await priya().setChecked({ id: tape.id, checked: true });

    const added = await job("m-1").addItem({ listId: list.id, text: "String", sourceMessage: "m-1" });
    expect(added).toMatchObject({ outcome: ListWriteOutcome.added, item: { source: ListItemSource.agent, createdBy: "priya" } });

    await expect(job().removeItem({ id: batteries.id })).rejects.toThrow(/PRV-1/);
    await expect(job().renameItem({ id: batteries.id, text: "AA batteries" })).rejects.toThrow(/PRV-1/);
    await expect(job().setChecked({ id: tape.id, checked: false })).rejects.toThrow(/PRV-1/);
    await expect(job().setChecked({ id: batteries.id, checked: true })).rejects.toThrow(/PRV-1/);
    await expect(job().updateList({ id: list.id, name: "Mine now" })).rejects.toThrow(/PRV-1/);
    await expect(job().removeList({ id: list.id })).rejects.toThrow(/PRV-1/);
    await expect(job().createList({ name: "Agent list", emoji: "🤖" })).rejects.toThrow(/PRV-1/);
    // Only what the message it is handling asked for, and only for a person.
    await expect(job("m-1").addItem({ listId: list.id, text: "Glue", sourceMessage: "some-other-message" })).rejects.toThrow(/PRV-1/);
    const noOne = h.rt.as({ kind: ActorKind.agent, job: "job-2", onBehalfOf: null, message: "m-2" }).lists;
    await expect(noOne.addItem({ listId: list.id, text: "Glue", sourceMessage: "m-2" })).rejects.toThrow(/PRV-1/);
    await expect(h.rt.system("timer").lists.addItem({ listId: list.id, text: "Glue", sourceMessage: null })).rejects.toThrow(/needs a person/);

    const after = await listNamed("Guarded");
    expect(after.items.map((i) => [i.text, i.checked])).toEqual([
      ["Batteries", false],
      ["Tape", true],
      ["String", false],
    ]);
  });

  test("[PRV-7] a person's list items are in their export; deleting them forgets who wrote them but leaves the shared list", async () => {
    const list = await freshList("Export", ["Candles"]);
    const dump = await exportPerson(h.rt, "priya");
    expect(JSON.stringify(dump["lists"])).toContain("Candles");
    await deletePerson(h.rt, "priya");
    const after = await listNamed("Export");
    expect(after.items).toEqual([expect.objectContaining({ text: "Candles", createdBy: null })]);
    expect(list.id).toBe(after.id);
  });
});
