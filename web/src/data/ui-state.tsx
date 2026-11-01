import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

export type About = { ref: string; title: string };
type Said = { before: string | null | undefined; text: string };

type UiState = {
  /** Blocks the person just acted on: hidden at once, before the server confirms (HOME-5). */
  hidden: ReadonlySet<string>;
  hide: (id: string) => void;
  /** The item the next message is about (MOM-7). */
  about: About | null;
  setAbout: (about: About | null) => void;
  /**
   * What the person last said, and the newest of today's
   * exchanges they had then (`undefined` if the conversation wasn't loaded yet). Until the server has
   * a newer one, what they said is shown as waiting for an answer (HOU-159).
   */
  said: Said | null;
  markSaid: (before: string | null | undefined, text: string) => void;
  /** Forget what was last said, once the server has it, so it can't come back as waiting later. */
  clearSaid: () => void;
  /** HOU-159: whether today's conversation is open above the composer. Saying something opens it. */
  conversationOpen: boolean;
  setConversationOpen: (open: boolean) => void;
};

const Ctx = createContext<UiState | null>(null);

export function UiStateProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [about, setAbout] = useState<About | null>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const hide = useCallback((id: string) => setHidden((prev) => new Set([...prev, id])), []);
  const [conversationOpen, setConversationOpen] = useState(false);
  const markSaid = useCallback((before: string | null | undefined, text: string) => {
    setSaid({ before, text });
    setConversationOpen(true);
  }, []);
  const clearSaid = useCallback(() => setSaid(null), []);
  const value = useMemo(() => ({ hidden, hide, about, setAbout, said, markSaid, clearSaid, conversationOpen, setConversationOpen }), [hidden, hide, about, said, markSaid, clearSaid, conversationOpen]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUiState(): UiState {
  const value = useContext(Ctx);
  if (value === null) throw new Error("UiStateProvider missing");
  return value;
}
