/**
 * HOME-6 / HOU-154: register the service worker, and pick up a deploy without anyone touching the
 * screen. Each deploy serves a new worker (it carries the build id); when a worker takes over whose
 * build is not the one this page was served by, the page reloads itself once. Comparing builds, not
 * "was there a worker before", also covers a page opened with none (a first visit, a hard reload).
 *
 * Why a reload and not a "tap to reload" note: the kitchen iPad is left open and nobody taps it, so a
 * note would sit there while the old build runs. The plan comes back from the server on reload, so
 * nothing is lost — except a half-typed line, so while a text field has something in it the reload
 * waits until it is left.
 */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker;
  // The build that served this page (server/http/app.ts); absent under `vite dev`, which never reloads.
  const page = document.querySelector<HTMLMetaElement>('meta[name="household-build"]')?.content ?? null;
  let reloading = false;
  const reloadWhenIdle = () => {
    if (reloading) return;
    if (typing()) {
      document.addEventListener("focusout", () => setTimeout(reloadWhenIdle, 0), { once: true });
      return;
    }
    reloading = true;
    window.location.reload();
  };
  container.addEventListener("controllerchange", () => {
    const worker = container.controller;
    if (page === null || worker === null) return;
    void (async () => {
      const build = await buildOf(worker);
      if (build !== null && build !== page) reloadWhenIdle();
    })();
  });
  void container.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
}

/**
 * HOU-154: ask whether a newer worker is out. Called when the live connection (re)opens: a deploy
 * restarts the server, so an open screen reconnects, and this finds the new build straight away.
 */
export function checkForUpdate(): void {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker
    .getRegistration()
    .then((r) => r?.update())
    .catch(() => {});
}

/** The build a worker carries, asked over a message channel (web/public/sw.js); null if it cannot say. */
function buildOf(worker: ServiceWorker): Promise<string | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.addEventListener("message", (e: MessageEvent) => resolve(typeof e.data === "string" ? e.data : null), { once: true });
    channel.port1.start();
    worker.postMessage("build", [channel.port2]);
  });
}

function typing(): boolean {
  const el = document.activeElement;
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value !== "";
}
