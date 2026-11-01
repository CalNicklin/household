import { ActionKind, type Block, BlockType, Placement, Provenance, Section } from "@household/contracts";

/** What the planner knows about how much the house has in it yet (HOU-149). */
export type HouseFill = {
  /** Whether any of the house's calendars has ever been read (a first sync exists). */
  calendarConnected: boolean;
  /** Active backlog jobs. */
  backlogItems: number;
};

/** Refs of the first-day blocks. They are about the app, not a job, so they are never "the one thing" (MOM-2). */
export const START_REF_PREFIX = "start:";

function startBlock(key: string, title: string, reason: string): Block {
  const ref = `${START_REF_PREFIX}${key}`;
  return {
    id: ref,
    type: BlockType.suggestion,
    section: Section.start,
    placement: Placement.main,
    reason,
    provenance: Provenance.planner,
    title,
    ref,
    // Planner-made, so a no-guilt dismiss (design/README.md). It comes back tomorrow if it still applies.
    actions: [{ kind: ActionKind.notToday, label: "Not now", ref }],
  };
}

/**
 * HOU-149: a house with no calendar or an empty backlog says so and shows how to start, in the
 * ordinary block vocabulary: say a few jobs, connect the calendar, ask for the one thing.
 */
export function firstDayBlocks(fill: HouseFill): Block[] {
  const out: Block[] = [];
  if (fill.backlogItems === 0)
    out.push(startBlock("backlog", "Say a few jobs into the box below", "The backlog is empty, so there is nothing to fit into today's gaps yet. Type or talk: “fix the gate”, “book the boiler service”."));
  if (!fill.calendarConnected) out.push(startBlock("calendar", "Calendars aren't connected yet", "None of your calendars has been read yet, so Now, Later today and Tomorrow have nothing from them."));
  if (out.length > 0) out.push(startBlock("ask", "Ask “if I do one thing, what should it be?”", "The house has little in it yet, so this screen shows little on its own; asking gets one answer with its reason."));
  return out;
}
