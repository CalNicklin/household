import { type Query, type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { flushOutbox } from "./send.ts";
import { checkForUpdate } from "./sw.ts";

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
  // Stale again, and refetched now if a screen shows it; one no screen shows waits for its next mount.
  const refetch = (query: Query) => void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false });
  const stop = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || (event.action.type !== "success" && event.action.type !== "error")) return;
    // HOU-161: Lists' optimistic setQueryData mid-fetch is a "success" too; the fetch is still on its way.
    if (event.query.state.fetchStatus !== "idle") return;
    if (owed.delete(event.query.queryHash)) refetch(event.query);
  });
  const refresh = () => {
    // Stale everywhere, so an inactive screen refetches when it is next shown; nothing refetched here.
    void queryClient.invalidateQueries({ refetchType: "none" });
    // A fetch still on its way is owed one more even when its screen is gone: coming back joins it.
    for (const query of queryClient.getQueryCache().findAll()) {
      if (query.state.fetchStatus !== "idle") owed.add(query.queryHash);
      else if (query.isActive()) refetch(query);
    }
  };
  return { refresh, stop };
}

/**
 * PLT-11 / MOM-3 / CH-10: listen for changes and refetch. EventSource reconnects by itself; every
 * (re)connect refetches, so a screen left open all week catches up (HOME-6). The local date is
 * checked every minute and whenever the screen becomes visible.
 *
 * HOU-154: a deploy answers the reconnect with a 502 while the new server starts, and EventSource
 * gives up for good on that. So the minute check opens it again when it has closed, and also asks
 * whether a new service worker is out: an open screen finds a deploy within a minute either way.
 */
export function useLive(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const { refresh, stop } = refresher(queryClient);
    const live: { source: EventSource | null } = { source: null };
    const connect = () => {
      const source = new EventSource("/api/live");
      live.source = source;
      source.addEventListener("change", refresh);
      source.addEventListener("hello", () => {
        refresh();
        void flushOutbox();
        // HOU-154: a reconnect is often a deploy (the server restarted); see if a new build is out.
        checkForUpdate();
      });
    };
    connect();

    let day = localDay();
    const checkDay = () => {
      const now = localDay();
      if (now !== day) {
        day = now;
        refresh();
      }
    };
    // HOU-154: a connection EventSource gave up on is opened again, and a new build is looked for.
    const keepUp = () => {
      if (live.source?.readyState === EventSource.CLOSED) connect();
      checkForUpdate();
    };
    const timer = window.setInterval(() => {
      checkDay();
      keepUp();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        checkDay();
        refresh();
        keepUp();
      }
    };
    const onOnline = () => {
      void flushOutbox();
      refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      live.source?.close();
      stop();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [queryClient]);
}
