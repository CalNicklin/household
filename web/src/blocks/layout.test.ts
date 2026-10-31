import { type Block, BlockType, Placement, Provenance, Section } from "@household/contracts";
import { describe, expect, it } from "vitest";
import { hasComposer, piecesOf, slotBlocks } from "./layout.ts";

const base = { reason: "r", provenance: Provenance.calendar } as const;
const event = (id: string, section: Section, placement: Placement): Block => ({ ...base, id, section, placement, type: BlockType.event, time: "09:00", title: id, detail: "", ref: id });
const suggestion = (id: string, section: Section, placement: Placement): Block => ({
  ...base,
  provenance: Provenance.planner,
  id,
  section,
  placement,
  type: BlockType.suggestion,
  title: id,
  ref: id,
  actions: [],
});

describe("server-driven layout", () => {
  it("[HOME-7] keeps the server's order and puts each run of a section in the slot its placement names", () => {
    const blocks = [event("a", Section.now, Placement.main), suggestion("b", Section.now, Placement.main), event("c", Section.later, Placement.main), event("d", Section.arriving, Placement.aside)];
    const slots = slotBlocks(blocks);
    expect(slots.main.map((r) => [r.section, r.blocks.map((b) => b.id)])).toEqual([
      [Section.now, ["a", "b"]],
      [Section.later, ["c"]],
    ]);
    expect(slots.aside.map((r) => r.section)).toEqual([Section.arriving]);
    expect(slots.focus).toEqual([]);
  });

  it("[HOME-7][HOME-8] the same client renders a different composition when the server reorders blocks", () => {
    const normal = slotBlocks([event("a", Section.now, Placement.main), event("b", Section.later, Placement.main)]);
    const slow = slotBlocks([event("b", Section.focus, Placement.focus), event("a", Section.focus, Placement.focus)]);
    expect(normal.main).toHaveLength(2);
    expect(slow.main).toHaveLength(0);
    expect(slow.focus[0]?.blocks.map((b) => b.id)).toEqual(["b", "a"]);
  });

  it("groups neighbouring events into one list and keeps others separate", () => {
    const run = { key: "k", section: Section.later, blocks: [event("a", Section.later, Placement.main), event("b", Section.later, Placement.main), suggestion("c", Section.later, Placement.main), event("d", Section.later, Placement.main)] };
    expect(piecesOf(run).map((p) => p.kind)).toEqual(["events", "single", "events"]);
  });

  it("knows whether the server sent a composer", () => {
    expect(hasComposer([event("a", Section.now, Placement.main)])).toBe(false);
  });
});
