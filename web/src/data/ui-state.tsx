import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

export type About = { ref: string; title: string };
type Said = { at: number; before: string | null | undefined };

type UiState = {
  /** Blocks the person just acted on: hidden at once, before the server confirms (HOME-5). */
  hidden: ReadonlySet<string>;
  hide: (id: string) => void;
  /** The item the next message is about (MOM-7). */
  about: About | null;
  setAbout: (about: About | null) => void;
  /**
   * When the person last said something, and the newest reply they had then (`undefined` if the
   * replies weren't loaded yet). The answer above the composer is the first reply after it.
   */
  said: Said | null;
  markSaid: (before: string | null | undefined) => void;
};

const Ctx = createContext<UiState | null>(null);

export function UiStateProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [about, setAbout] = useState<About | null>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const hide = useCallback((id: string) => setHidden((prev) => new Set([...prev, id])), []);
  const markSaid = useCallback((before: string | null | undefined) => setSaid({ at: Date.now(), before }), []);
  const value = useMemo(() => ({ hidden, hide, about, setAbout, said, markSaid }), [hidden, hide, about, said, markSaid]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUiState(): UiState {
  const value = useContext(Ctx);
  if (value === null) throw new Error("UiStateProvider missing");
  return value;
}
