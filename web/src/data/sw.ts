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
    if (page === null || container.controller === null) return;
    void (async () => {
      const build = await currentBuild();
      if (build !== undefined && build !== page) reloadWhenIdle();
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

/**
 * The build the server's worker is now (the `x-household-build` header on /sw.js, server/http/app.ts):
 * the worker that just took over came from there. A worker from before builds were named has no
 * header (null): not this page's build, so it reloads. Unreachable (undefined): nothing to decide.
 */
async function currentBuild(): Promise<string | null | undefined> {
  try {
    const res = await fetch("/sw.js", { cache: "no-store" });
    return res.ok ? res.headers.get("x-household-build") : undefined;
  } catch {
    return undefined;
  }
}

function typing(): boolean {
  const el = document.activeElement;
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value !== "";
}
