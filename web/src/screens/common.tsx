import type { Block, NotifyAction } from "@household/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { BlockHandlers } from "../blocks/BlockRenderer.tsx";
import { say } from "../data/send.ts";
import { useTRPC } from "../data/trpc.ts";
import { useUiState } from "../data/ui-state.tsx";
import { Answer, Composer, Footer, type NavLink } from "../design-system/index.ts";

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

/** The newest reply this screen has, so the answer to what is said next can be told apart from it. */
function useNewestReply(): () => string | null | undefined {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () => {
    const replies = queryClient.getQueryData(trpc.conversation.queryKey());
    return replies === undefined ? undefined : (replies[0]?.id ?? null);
  };
}

/** Everything a person says or taps goes in as one message (CH-1, CH-8). */
function useSay() {
  const { about, setAbout, markSaid } = useUiState();
  const queryClient = useQueryClient();
  const newestReply = useNewestReply();
  return (text: string, spoken: boolean) => {
    markSaid(newestReply());
    const ref = about?.ref;
    setAbout(null);
    void say({ text, ...(ref === undefined ? {} : { ref }), ...(spoken ? { spoken } : {}) }).then(() => queryClient.invalidateQueries());
  };
}

/** One-tap buttons: hide the block straight away (HOME-5), then send the tap as a message. */
export function useBlockHandlers(version: number): BlockHandlers & { isHidden: (block: Block) => boolean } {
  const { hidden, hide, markSaid } = useUiState();
  const queryClient = useQueryClient();
  const newestReply = useNewestReply();
  return {
    isHidden: (block) => hidden.has(`${version}:${block.id}`),
    onAction: (block: Block, action: NotifyAction) => {
      hide(`${version}:${block.id}`);
      markSaid(newestReply());
      void say({ text: action.label, ref: action.ref, action: action.kind, ...(action.value === undefined ? {} : { value: action.value }) }).then(() => queryClient.invalidateQueries());
    },
  };
}

const REPLY_SHOWN_MS = 60_000;

type ReplyId = string | null;

/**
 * The latest answer from the house, for a minute after you last said something (MOM-2), shown
 * right above the composer (HOU-149). Until it arrives, a calm line says the house is on it.
 */
function LatestAnswer() {
  const trpc = useTRPC();
  const { said } = useUiState();
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<ReplyId>(null);
  const conversation = useQuery(trpc.conversation.queryOptions());
  useEffect(() => {
    if (said === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [said]);
  if (said === null || Math.max(now, said.at) - said.at > REPLY_SHOWN_MS) return null;
  const latest = conversation.data?.[0];
  // Ids, not times, tell the answer apart: the server's clock (the practice clock) can differ from this device's.
  const fresh = latest !== undefined && (said.before === undefined ? new Date(latest.createdAt).getTime() >= said.at - 5_000 : latest.id !== said.before);
  if (latest === undefined || !fresh) return <Answer heading="Asking the house" title={null} detail="One moment…" onDismiss={null} />;
  if (latest.id === dismissed) return null;
  const hide = () => setDismissed(latest.id);
  if (latest.pick !== null) return <Answer heading="The one thing" title={latest.pick.title} detail={latest.pick.why} onDismiss={hide} />;
  return <Answer heading="From the house" title={null} detail={latest.text} onDismiss={hide} />;
}

export function FooterComposer({ placeholder, label }: { placeholder: string; label?: string }) {
  const { about, setAbout } = useUiState();
  const onSend = useSay();
  return (
    <Footer>
      <LatestAnswer />
      <Composer placeholder={placeholder} {...(label === undefined ? {} : { label })} about={about?.title ?? null} onClearAbout={() => setAbout(null)} onSend={onSend} />
    </Footer>
  );
}
