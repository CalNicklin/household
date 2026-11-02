import { ActionKind, ActionLabel, type Block, type ConversationView, ExchangeState, type NotifyAction } from "@household/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { BlockHandlers } from "../blocks/BlockRenderer.tsx";
import { say } from "../data/send.ts";
import { useTRPC } from "../data/trpc.ts";
import { useUiState } from "../data/ui-state.tsx";
import { useUndo } from "../data/undo.tsx";
import { Composer, Conversation, type ExchangeLine, Footer, type NavLink } from "../design-system/index.ts";

const ALL: readonly NavLink[] = [
  { to: "/", label: "Today" },
  { to: "/backlog", label: "Backlog" },
  { to: "/shop", label: "Shop" },
  { to: "/lists", label: "Lists" },
  { to: "/week", label: "Week" },
  { to: "/settings", label: "Settings" },
];

/** HOME-9: plain secondary links, never a tab bar, never a badge. */
export function navFor(current: string): NavLink[] {
  return ALL.filter((n) => n.to !== current);
}

/** The newest of today's exchanges this screen has, so what is said next can be told apart from it. */
function useNewestExchange(): () => string | null | undefined {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () => {
    const exchanges = queryClient.getQueryData(trpc.conversation.queryKey());
    return exchanges === undefined ? undefined : (exchanges.at(-1)?.id ?? null);
  };
}

/** Everything a person says or taps goes in as one message (CH-1, CH-8). */
function useSay() {
  const { about, setAbout, markSaid } = useUiState();
  const { flush } = useUndo();
  const queryClient = useQueryClient();
  const newestExchange = useNewestExchange();
  return (text: string, spoken: boolean) => {
    markSaid(newestExchange(), text);
    const ref = about?.ref;
    setAbout(null);
    // HOU-158: a delete still in its Undo window is sent first, so "add milk" after deleting milk adds it.
    void flush()
      .then(() => say({ text, ...(ref === undefined ? {} : { ref }), ...(spoken ? { spoken } : {}) }))
      .then(() => queryClient.invalidateQueries());
  };
}

/** One-tap buttons: hide the block straight away (HOME-5), then send the tap as a message. */
export function useBlockHandlers(version: number): BlockHandlers & { isHidden: (block: Block) => boolean } {
  const { hidden, hide } = useUiState();
  const { isDeleted, remove } = useUndo();
  const queryClient = useQueryClient();
  const send = (action: NotifyAction) =>
    say({ text: action.label, ref: action.ref, action: action.kind, ...(action.value === undefined ? {} : { value: action.value }) }).then(() => queryClient.invalidateQueries());
  return {
    isHidden: (block) => hidden.has(`${version}:${block.id}`) || isDeleted(`block:${block.id}`),
    onAction: (block: Block, action: NotifyAction) => {
      hide(`${version}:${block.id}`);
      void send(action);
    },
    // HOU-174: the card stays until the screen is redrawn with its new time.
    onRetime: (_block, ref, time) => void send({ kind: ActionKind.retime, label: `Change time to ${time}`, ref, value: time }),
    // HOU-174: like a backlog item's Delete (HOU-158): gone at once, sent when the Undo window ends.
    onDelete: (block, ref, title) => remove(`block:${block.id}`, `Deleted “${title}”`, () => send({ kind: ActionKind.cancel, label: ActionLabel[ActionKind.cancel], ref })),
  };
}

/** HOU-159: how many of today's exchanges show when the conversation is open ("the last few"). */
const SHOWN_EXCHANGES = 3;

const WAITING = { heading: "Asking the house", title: null, detail: "One moment…" };

/** The house's side of one exchange, as the conversation shows it. */
function houseLine(e: ConversationView[number]): ExchangeLine["house"] {
  switch (e.state) {
    case ExchangeState.waiting:
      return WAITING;
    case ExchangeState.failed:
      return { heading: "From the house", title: null, detail: "That didn't go through. Try saying it again in a moment." };
    case ExchangeState.quiet:
      return null;
    case ExchangeState.answered: {
      if (e.reply === null) return null;
      if (e.reply.pick !== null) return { heading: "The one thing", title: e.reply.pick.title, detail: e.reply.pick.why };
      return { heading: "From the house", title: null, detail: e.reply.text };
    }
  }
}

/**
 * HOU-159: today's conversation with the house, above the composer on every screen that has one.
 * What you just said shows at once, waiting for its answer, until the server has it; the answer
 * lands in the same place (MOM-2, HOU-149). Hiding it leaves one quiet link to open it again.
 */
function TodaysConversation() {
  const trpc = useTRPC();
  const { said, clearSaid, conversationOpen, setConversationOpen } = useUiState();
  const conversation = useQuery(trpc.conversation.queryOptions());
  const exchanges: ExchangeLine[] = (conversation.data ?? []).map((e) => ({ id: e.id, said: e.said, house: houseLine(e) }));
  // Ids, not times, tell what is new: the server's clock (the practice clock) can differ from this device's.
  const newest = conversation.data === undefined ? undefined : (conversation.data.at(-1)?.id ?? null);
  // The server has something newer than when it was said, so it has this: stop holding it as waiting.
  // Otherwise, after midnight empties the view, the day's first message would look unsent again.
  const arrived = said !== null && newest !== undefined && newest !== said.before;
  useEffect(() => {
    if (arrived) clearSaid();
  }, [arrived, clearSaid]);
  if (said !== null && !arrived) exchanges.push({ id: "pending", said: said.text, house: WAITING });
  return <Conversation exchanges={exchanges.slice(-SHOWN_EXCHANGES)} total={exchanges.length} open={conversationOpen} onOpen={() => setConversationOpen(true)} onClose={() => setConversationOpen(false)} />;
}

export function FooterComposer({ placeholder, label }: { placeholder: string; label?: string }) {
  const { about, setAbout } = useUiState();
  const onSend = useSay();
  return (
    <Footer>
      <TodaysConversation />
      <Composer placeholder={placeholder} {...(label === undefined ? {} : { label })} about={about?.title ?? null} onClearAbout={() => setAbout(null)} onSend={onSend} />
    </Footer>
  );
}
