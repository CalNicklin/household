import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { flushOutbox } from "./send.ts";

function localDay(): string {
  return new Date().toDateString();
}

/**
 * HOU-161: run `task` one at a time. A burst of changes (a job and the re-plan it starts) would
 * otherwise cancel every in-flight fetch on each change, so a slow screen like Shop never landed
 * until the burst ended. Calls made while it runs are folded into one more run after it.
 */
function oneAtATime(task: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          again = false;
          await task();
        } while (again);
      } finally {
        running = false;
      }
    })();
  };
}

/**
 * PLT-11 / MOM-3 / CH-10: listen for changes and refetch. EventSource reconnects by itself; every
 * (re)connect refetches, so a screen left open all week catches up (HOME-6). The local date is
 * checked every minute and whenever the screen becomes visible.
 */
export function useLive(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    // Cancel first: a query still on its first load ignores invalidation and keeps the answer it is
    // fetching, so a change landing while the screen opens would otherwise never be shown (HOME-1).
    const refresh = oneAtATime(async () => {
      await queryClient.cancelQueries();
      await queryClient.invalidateQueries();
    });
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
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [queryClient]);
}
