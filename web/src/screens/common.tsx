import type { Block, NotifyAction } from "@household/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { BlockHandlers } from "../blocks/BlockRenderer.tsx";
import { say } from "../data/send.ts";
import { useTRPC } from "../data/trpc.ts";
import { useUiState } from "../data/ui-state.tsx";
import { Composer, Footer, type NavLink, Reply } from "../design-system/index.ts";

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

/** Everything a person says or taps goes in as one message (CH-1, CH-8). */
function useSay() {
  const { about, setAbout, markSaid } = useUiState();
  const queryClient = useQueryClient();
  return (text: string, spoken: boolean) => {
    markSaid();
    const ref = about?.ref;
    setAbout(null);
    void say({ text, ...(ref === undefined ? {} : { ref }), ...(spoken ? { spoken } : {}) }).then(() => queryClient.invalidateQueries());
  };
}

/** One-tap buttons: hide the block straight away (HOME-5), then send the tap as a message. */
export function useBlockHandlers(version: number): BlockHandlers & { isHidden: (block: Block) => boolean } {
  const { hidden, hide, markSaid } = useUiState();
  const queryClient = useQueryClient();
  return {
    isHidden: (block) => hidden.has(`${version}:${block.id}`),
    onAction: (block: Block, action: NotifyAction) => {
      hide(`${version}:${block.id}`);
      markSaid();
      void say({ text: action.label, ref: action.ref, action: action.kind, ...(action.value === undefined ? {} : { value: action.value }) }).then(() => queryClient.invalidateQueries());
    },
  };
}

const REPLY_SHOWN_MS = 60_000;

/** The latest answer from the house, for a minute after you last said something (MOM-2). */
function LatestReply() {
  const trpc = useTRPC();
  const { lastSaidAt } = useUiState();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (lastSaidAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [lastSaidAt]);
  const conversation = useQuery({ ...trpc.conversation.queryOptions(), enabled: lastSaidAt !== null });
  if (lastSaidAt === null || now - lastSaidAt > REPLY_SHOWN_MS) return null;
  const latest = conversation.data?.[0];
  if (latest === undefined || new Date(latest.createdAt).getTime() < lastSaidAt - 5_000) return null;
  return <Reply text={latest.text} />;
}

export function FooterComposer({ placeholder, label }: { placeholder: string; label?: string }) {
  const { about, setAbout } = useUiState();
  const onSend = useSay();
  return (
    <Footer>
      <Composer placeholder={placeholder} {...(label === undefined ? {} : { label })} about={about?.title ?? null} onClearAbout={() => setAbout(null)} onSend={onSend} />
      <LatestReply />
    </Footer>
  );
}
