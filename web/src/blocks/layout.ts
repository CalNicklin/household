import { type Block, BlockType, type Placement, type Section } from "@household/contracts";

export type Run = { key: string; section: Section; blocks: Block[] };
export type Slots = Record<Placement, Run[]>;

/**
 * HOME-7: the only "layout" the client does. Blocks arrive in the server's order; consecutive
 * blocks of the same section form a run, and each run goes to the generic slot its placement names.
 * No screen-specific rules live here.
 */
export function slotBlocks(blocks: readonly Block[]): Slots {
  const slots: Slots = { header: [], main: [], aside: [], focus: [], footer: [] };
  for (const block of blocks) {
    const runs = slots[block.placement];
    const last = runs.at(-1);
    if (last !== undefined && last.section === block.section) last.blocks.push(block);
    else runs.push({ key: `${block.placement}:${block.section}:${block.id}`, section: block.section, blocks: [block] });
  }
  return slots;
}

/** The composer is always present (Components canvas: "always present"). */
export function hasComposer(blocks: readonly Block[]): boolean {
  return blocks.some((b) => b.type === BlockType.composer);
}

export type Piece = { kind: "events"; blocks: Extract<Block, { type: "event" }>[] } | { kind: "arrivals"; blocks: Extract<Block, { type: "arrival" }>[] } | { kind: "single"; block: Block };

/** Within a run, neighbouring calendar events (and arrivals) share one list card, as on the canvas. */
export function piecesOf(run: Run): Piece[] {
  const pieces: Piece[] = [];
  for (const block of run.blocks) {
    const last = pieces.at(-1);
    if (block.type === BlockType.event) {
      if (last?.kind === "events") last.blocks.push(block);
      else pieces.push({ kind: "events", blocks: [block] });
    } else if (block.type === BlockType.arrival) {
      if (last?.kind === "arrivals") last.blocks.push(block);
      else pieces.push({ kind: "arrivals", blocks: [block] });
    } else {
      pieces.push({ kind: "single", block });
    }
  }
  return pieces;
}
