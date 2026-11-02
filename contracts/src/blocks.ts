/**
 * The block vocabulary the planner composes from (HOME-7). The server returns an
 * ordered list; the client maps `type` to a component and `placement` to a generic slot.
 */
import { z } from "zod";
import { BlockType, zModeKind, zPlacement, zProvenance, zSection } from "./enums.ts";
import { zIsoDateTime, zLocalDate, zNotifyAction } from "./message.ts";

const base = {
  /** Stable across re-plans of the same day, so dismissals stick (HOME-4). */
  id: z.string(),
  section: zSection,
  placement: zPlacement,
  /** One line you could check yourself (HOME-3). */
  reason: z.string(),
  provenance: zProvenance,
};

export const zContextBlock = z.object({
  ...base,
  type: z.literal(BlockType.context),
  title: z.string(),
  line: z.string(),
});

export const zModeBlock = z.object({
  ...base,
  type: z.literal(BlockType.mode),
  mode: zModeKind,
  heading: z.string(),
  /** The one suggested thing; null when there is nothing worth doing. */
  pick: z
    .object({
      ref: z.string(),
      title: z.string(),
      why: z.string(),
      actions: z.array(zNotifyAction),
    })
    .nullable(),
  /** Fixed things still happening anyway (MOM-5). */
  stillHappening: z.array(z.object({ id: z.string(), text: z.string(), provenance: zProvenance })),
});

export const zEventBlock = z.object({
  ...base,
  type: z.literal(BlockType.event),
  time: z.string().nullable(),
  title: z.string(),
  detail: z.string(),
  ref: z.string(),
});

export const zSuggestionBlock = z.object({
  ...base,
  type: z.literal(BlockType.suggestion),
  title: z.string(),
  ref: z.string(),
  actions: z.array(zNotifyAction),
});

export const zAlertBlock = z.object({
  ...base,
  type: z.literal(BlockType.alert),
  title: z.string(),
  ref: z.string(),
  /** At most one action (Components canvas: "one action"). */
  action: zNotifyAction.nullable(),
});

export const zArrivalBlock = z.object({
  ...base,
  type: z.literal(BlockType.arrival),
  shop: z.string(),
  when: z.string(),
  ref: z.string(),
});

export const zBacklogPickBlock = z.object({
  ...base,
  type: z.literal(BlockType.backlogPick),
  title: z.string(),
  ref: z.string(),
  actions: z.array(zNotifyAction),
});

export const zComposerBlock = z.object({
  ...base,
  type: z.literal(BlockType.composer),
  placeholder: z.string(),
});

export const zBlock = z.discriminatedUnion("type", [
  zContextBlock,
  zModeBlock,
  zEventBlock,
  zSuggestionBlock,
  zAlertBlock,
  zArrivalBlock,
  zBacklogPickBlock,
  zComposerBlock,
]);
export type Block = z.infer<typeof zBlock>;
export type ContextBlock = z.infer<typeof zContextBlock>;
export type ModeBlock = z.infer<typeof zModeBlock>;
export type EventBlock = z.infer<typeof zEventBlock>;
export type SuggestionBlock = z.infer<typeof zSuggestionBlock>;
export type AlertBlock = z.infer<typeof zAlertBlock>;
export type ArrivalBlock = z.infer<typeof zArrivalBlock>;
export type BacklogPickBlock = z.infer<typeof zBacklogPickBlock>;
export type ComposerBlock = z.infer<typeof zComposerBlock>;

/** PLT-4: a day's plan is one row of ordered blocks; every version is kept. */
export const zPlan = z.object({
  date: zLocalDate,
  version: z.number().int(),
  createdAt: zIsoDateTime,
  blocks: z.array(zBlock),
  /** HOU-154: the build that made it (null before builds were recorded); an older one is redone once. */
  build: z.string().nullable(),
});
export type Plan = z.infer<typeof zPlan>;

/** What the screen reads: the latest plan with responses already applied. */
export const zScreen = z.object({
  date: zLocalDate,
  version: z.number().int(),
  generatedAt: zIsoDateTime,
  blocks: z.array(zBlock),
});
export type Screen = z.infer<typeof zScreen>;
