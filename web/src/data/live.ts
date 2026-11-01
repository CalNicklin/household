import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { flushOutbox } from "./send.ts";
import { checkForUpdate } from "./sw.ts";

function localDay(): string {
  return new Date().toDateString();
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
    // Cancel first: a query still on its first load ignores invalidation and keeps the answer it is
    // fetching, so a change landing while the screen opens would otherwise never be shown (HOME-1).
    const refresh = () => {
      void queryClient.cancelQueries().then(() => queryClient.invalidateQueries());
    };
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
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [queryClient]);
}
