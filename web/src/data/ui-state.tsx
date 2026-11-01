import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

export type About = { ref: string; title: string };

type UiState = {
  /** Blocks the person just acted on: hidden at once, before the server confirms (HOME-5). */
  hidden: ReadonlySet<string>;
  hide: (id: string) => void;
  /** The item the next message is about (MOM-7). */
  about: About | null;
  setAbout: (about: About | null) => void;
  /** When the person last said something; the reply under the composer is shown after this. */
  lastSaidAt: number | null;
  markSaid: () => void;
};

const Ctx = createContext<UiState | null>(null);

export function UiStateProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [about, setAbout] = useState<About | null>(null);
  const [lastSaidAt, setLastSaidAt] = useState<number | null>(null);
  const hide = useCallback((id: string) => setHidden((prev) => new Set([...prev, id])), []);
  const markSaid = useCallback(() => setLastSaidAt(Date.now()), []);
  const value = useMemo(() => ({ hidden, hide, about, setAbout, lastSaidAt, markSaid }), [hidden, hide, about, lastSaidAt, markSaid]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUiState(): UiState {
  const value = useContext(Ctx);
  if (value === null) throw new Error("UiStateProvider missing");
  return value;
}
