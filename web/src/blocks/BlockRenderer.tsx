import { type Block, BlockType, type NotifyAction, Section, SectionLabel } from "@household/contracts";
import type { ReactNode } from "react";
import { type About, useUiState } from "../data/ui-state.tsx";
import {
  AlertCard,
  ArrivalRow,
  BacklogPickCard,
  type CardAction,
  Columns,
  EventCard,
  EventRow,
  Focus,
  Header,
  ListCard,
  ModeCard,
  type NavLink,
  Section as SectionView,
  SuggestionCard,
} from "../design-system/index.ts";
import { piecesOf, type Run, slotBlocks } from "./layout.ts";

export type BlockHandlers = {
  /** A one-tap button: becomes a normal message with the action's ref (CH-8). */
  onAction: (block: Block, action: NotifyAction) => void;
};

function cardActions(block: Block, actions: readonly NotifyAction[], handlers: BlockHandlers): CardAction[] {
  return actions.map((a) => ({ key: `${a.kind}:${a.ref}:${a.value ?? ""}`, label: a.label, onPress: () => handlers.onAction(block, a) }));
}

function useSelect(): { select: (about: About) => () => void; isSelected: (ref: string) => boolean } {
  const { about, setAbout } = useUiState();
  return { select: (a) => () => setAbout(a), isSelected: (ref) => about?.ref === ref };
}

/** HOME-7: block type → component. The switch is exhaustive over contracts' BlockType. */
function BlockView({ block, handlers, nav }: { block: Block; handlers: BlockHandlers; nav: readonly NavLink[] }): ReactNode {
  const { select, isSelected } = useSelect();
  switch (block.type) {
    case BlockType.context:
      return <Header title={block.title} line={block.line} nav={nav} />;
    case BlockType.mode:
      return (
        <ModeCard
          eyebrow={block.heading}
          title={block.pick?.title ?? null}
          why={block.pick?.why ?? block.reason}
          actions={block.pick === null ? [] : cardActions(block, block.pick.actions, handlers)}
          still={block.stillHappening}
          {...(block.pick === null ? {} : { onSelect: select({ ref: block.pick.ref, title: block.pick.title }), selected: isSelected(block.pick.ref) })}
        />
      );
    case BlockType.event:
      return <EventCard time={block.time} title={block.title} detail={block.detail} provenance={block.provenance} onSelect={select({ ref: block.ref, title: block.title })} selected={isSelected(block.ref)} />;
    case BlockType.suggestion:
      return <SuggestionBlock block={block} handlers={handlers} />;
    case BlockType.alert:
      return (
        <AlertCard
          title={block.title}
          reason={block.reason}
          action={block.action === null ? null : (cardActions(block, [block.action], handlers)[0] ?? null)}
          onSelect={select({ ref: block.ref, title: block.title })}
          selected={isSelected(block.ref)}
        />
      );
    case BlockType.arrival:
      return (
        <ListCard label="Arriving">
          <ArrivalRow shop={block.shop} when={block.when} />
        </ListCard>
      );
    case BlockType.backlogPick:
      return <BacklogPickCard title={block.title} reason={block.reason} actions={cardActions(block, block.actions, handlers)} onSelect={select({ ref: block.ref, title: block.title })} selected={isSelected(block.ref)} />;
    case BlockType.composer:
      // Rendered by the footer slot (BlockScreen), never inline.
      return null;
  }
}

function SuggestionBlock({ block, handlers }: { block: Extract<Block, { type: "suggestion" }>; handlers: BlockHandlers }) {
  const { select, isSelected } = useSelect();
  return <SuggestionCard title={block.title} reason={block.reason} actions={cardActions(block, block.actions, handlers)} onSelect={select({ ref: block.ref, title: block.title })} selected={isSelected(block.ref)} />;
}

/** HOU-153: sections whose names only make sense on today's screen ("Now", "Later today"). */
const TODAY_ONLY: ReadonlySet<Section> = new Set([Section.now, Section.later]);

function RunView({ run, handlers, nav, today }: { run: Run; handlers: BlockHandlers; nav: readonly NavLink[]; today: boolean }) {
  const { select, isSelected } = useSelect();
  // On another day (Week), its blocks sit straight under the day's heading, not under "Now".
  const label = today || !TODAY_ONLY.has(run.section) ? SectionLabel[run.section] : "";
  const content = piecesOf(run).map((piece) => {
    switch (piece.kind) {
      case "events": {
        const [only] = piece.blocks;
        if (piece.blocks.length === 1 && only !== undefined && run.section === Section.now) return <BlockView key={only.id} block={only} handlers={handlers} nav={nav} />;
        return (
          <ListCard key={piece.blocks.map((b) => b.id).join()} {...(label === "" ? {} : { label })}>
            {piece.blocks.map((b) => (
              <EventRow key={b.id} time={b.time} title={b.title} detail={b.detail} provenance={b.provenance} onSelect={select({ ref: b.ref, title: b.title })} selected={isSelected(b.ref)} />
            ))}
          </ListCard>
        );
      }
      case "arrivals":
        return (
          <ListCard key={piece.blocks.map((b) => b.id).join()} label="Arriving">
            {piece.blocks.map((b) => (
              <ArrivalRow key={b.id} shop={b.shop} when={b.when} />
            ))}
          </ListCard>
        );
      case "single":
        return <BlockView key={piece.block.id} block={piece.block} handlers={handlers} nav={nav} />;
    }
  });
  if (label === "") return <>{content}</>;
  return (
    <SectionView label={label} tone={run.section === Section.now || run.section === Section.focus ? "suggestion" : "muted"}>
      {content}
    </SectionView>
  );
}

function Runs({ runs, handlers, nav, today = true }: { runs: readonly Run[]; handlers: BlockHandlers; nav: readonly NavLink[]; today?: boolean }) {
  return (
    <>
      {runs.map((r) => (
        <RunView key={r.key} run={r} handlers={handlers} nav={nav} today={today} />
      ))}
    </>
  );
}

/**
 * Renders an ordered block list into the generic slots. `fallbackHeader` is shown only when the
 * server sent no context block (e.g. before the first plan of the day exists).
 */
export function BlockLayout({ blocks, handlers, nav, fallbackHeader }: { blocks: readonly Block[]; handlers: BlockHandlers; nav: readonly NavLink[]; fallbackHeader: ReactNode }) {
  const slots = slotBlocks(blocks);
  const hasHeader = slots.header.some((r) => r.blocks.some((b) => b.type === BlockType.context));
  const main = slots.main.length === 0 ? null : <Runs runs={slots.main} handlers={handlers} nav={nav} />;
  const aside = slots.aside.length === 0 ? null : <Runs runs={slots.aside} handlers={handlers} nav={nav} />;
  return (
    <>
      {hasHeader ? <Runs runs={slots.header} handlers={handlers} nav={nav} /> : fallbackHeader}
      {slots.focus.length === 0 ? null : (
        <Focus>
          <Runs runs={slots.focus} handlers={handlers} nav={nav} />
        </Focus>
      )}
      {main === null && aside === null ? null : <Columns main={main} aside={aside} />}
    </>
  );
}

/**
 * Plain list of blocks in order, for views like Week that lay days out themselves. `today` false
 * (a later day) drops the "Now" and "Later today" labels; the day's own heading says when.
 */
export function BlockList({ blocks, handlers, today }: { blocks: readonly Block[]; handlers: BlockHandlers; today: boolean }) {
  const slots = slotBlocks(blocks);
  const runs = [...slots.header, ...slots.focus, ...slots.main, ...slots.aside];
  return <Runs runs={runs} handlers={handlers} nav={[]} today={today} />;
}
