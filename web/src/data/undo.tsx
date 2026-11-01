import { Limits } from "@household/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * HOU-158: a person's delete, with Undo. The thing goes from the screen at once; the delete itself is
 * sent when the Undo window ends, when the next delete is made, or when the page is put away. Undo
 * before then and nothing was sent. If the delete fails, the thing comes back.
 */
type Pending = { key: string; message: string; commit: () => Promise<unknown> };

type Undo = {
  /** What is showing Undo now. */
  pending: { key: string; message: string } | null;
  /** True for a thing deleted on this screen, sent or not: the screen leaves it out. */
  isDeleted: (key: string) => boolean;
  /** Take `key` off the screen, show `message` with Undo, and run `commit` when the window ends. */
  remove: (key: string, message: string, commit: () => Promise<unknown>) => void;
  undo: () => void;
};

const Ctx = createContext<Undo | null>(null);

export function UndoProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<{ key: string; message: string } | null>(null);
  const current = useRef<Pending | null>(null);
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const restore = useCallback((key: string) => setDeleted((prev) => new Set([...prev].filter((k) => k !== key))), []);

  /** Send the pending delete now. */
  const flush = useCallback(() => {
    clearTimer();
    const p = current.current;
    current.current = null;
    setPending(null);
    if (p === null) return;
    void p.commit().then(
      () => queryClient.invalidateQueries(),
      () => restore(p.key),
    );
  }, [clearTimer, queryClient, restore]);

  const remove = useCallback(
    (key: string, message: string, commit: () => Promise<unknown>) => {
      flush();
      setDeleted((prev) => new Set([...prev, key]));
      current.current = { key, message, commit };
      setPending({ key, message });
      // limit: undoWindowMs
      timer.current = window.setTimeout(flush, Limits.undoWindowMs.value);
    },
    [flush],
  );

  const undo = useCallback(() => {
    clearTimer();
    const p = current.current;
    current.current = null;
    setPending(null);
    if (p !== null) restore(p.key);
  }, [clearTimer, restore]);

  // Put away (another app, the screen locked, the tab closed): send it rather than lose it.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, [flush]);

  const isDeleted = useCallback((key: string) => deleted.has(key), [deleted]);
  const value = useMemo(() => ({ pending, isDeleted, remove, undo }), [pending, isDeleted, remove, undo]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUndo(): Undo {
  const value = useContext(Ctx);
  if (value === null) throw new Error("UndoProvider missing");
  return value;
}
