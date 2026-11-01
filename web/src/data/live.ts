import { type Query, type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { flushOutbox } from "./send.ts";

function localDay(): string {
  return new Date().toDateString();
}

/**
 * HOU-161: refetch every active query, but never cancel one already on its way. A burst of changes
 * (a job and the re-plan it starts) used to cancel every in-flight fetch on each change, so a slow
 * screen like Shop never landed until the burst ended. A query still fetching (retrying or paused
 * included) is owed one more fetch, made the moment it settles: it may be carrying an answer from
 * before the change (HOME-1). Each query waits only on itself, so a failing one holds up no other.
 */
function refresher(queryClient: QueryClient): { refresh: () => void; stop: () => void } {
  const owed = new Set<string>();
  const refetch = (query: Query) => void queryClient.refetchQueries({ queryKey: query.queryKey, exact: true, type: "active" }, { cancelRefetch: false });
  const stop = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || (event.action.type !== "success" && event.action.type !== "error")) return;
    if (owed.delete(event.query.queryHash)) refetch(event.query);
  });
  const refresh = () => {
    // Stale everywhere, so an inactive screen refetches when it is next shown; nothing refetched here.
    void queryClient.invalidateQueries({ refetchType: "none" });
    for (const query of queryClient.getQueryCache().findAll({ type: "active" })) {
      if (query.state.fetchStatus === "idle") refetch(query);
      else owed.add(query.queryHash);
    }
  };
  return { refresh, stop };
}

/**
 * PLT-11 / MOM-3 / CH-10: listen for changes and refetch. EventSource reconnects by itself; every
 * (re)connect refetches, so a screen left open all week catches up (HOME-6). The local date is
 * checked every minute and whenever the screen becomes visible.
 */
export function useLive(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const { refresh, stop } = refresher(queryClient);
    const source = new EventSource("/api/live");
    source.addEventListener("change", refresh);
    source.addEventListener("hello", () => {
      refresh();
      void flushOutbox();
    });

    let day = localDay();
    const checkDay = () => {
      const now = localDay();
      if (now !== day) {
        day = now;
        refresh();
      }
    };
    const timer = window.setInterval(checkDay, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        checkDay();
        refresh();
      }
    };
    const onOnline = () => {
      void flushOutbox();
      refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      source.close();
      stop();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [queryClient]);
}
