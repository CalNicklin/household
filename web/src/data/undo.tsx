import { Limits } from "@household/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { setLeaving } from "./trpc.ts";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * HOU-158: a person's delete, with Undo. The thing goes from the screen at once; the delete itself is
 * sent when the Undo window ends, when the next delete is made, or when the page is put away. Undo
 * before then and nothing was sent. If the delete fails, the thing comes back and the toast says so.
 */
type Pending = { key: string; message: string; commit: () => Promise<unknown> };
type Shown = { key: string; message: string; undoable: boolean };

type Undo = {
  /** What the toast shows now: a delete that can still be undone, or one that failed and came back. */
  pending: Shown | null;
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
  const [pending, setPending] = useState<Shown | null>(null);
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
      () => {
        restore(p.key);
        // Shown until the next delete or the next window ends, whichever is first; never over a newer delete.
        setPending((now) => now ?? { key: p.key, message: `Couldn't delete that — it's back. Check the connection and try again.`, undoable: false });
        // limit: undoWindowMs
        window.setTimeout(() => setPending((now) => (now?.key === p.key && !now.undoable ? null : now)), Limits.undoWindowMs.value);
      },
    );
  }, [clearTimer, queryClient, restore]);

  const remove = useCallback(
    (key: string, message: string, commit: () => Promise<unknown>) => {
      flush();
      setDeleted((prev) => new Set([...prev, key]));
      current.current = { key, message, commit };
      setPending({ key, message, undoable: true });
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

  // Put away (another app, the screen locked, the tab closed): send it now, with keepalive, rather
  // than lose it when the page goes.
  useEffect(() => {
    const onVisibility = () => {
      const hidden = document.visibilityState === "hidden";
      setLeaving(hidden);
      if (hidden) flush();
    };
    const onPageHide = () => {
      setLeaving(true);
      flush();
    };
    const onPageShow = () => setLeaving(false);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
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
