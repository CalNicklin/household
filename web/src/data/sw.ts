/**
 * HOME-6 / HOU-154: register the service worker, and pick up a deploy without anyone touching the
 * screen. Each deploy serves a new worker (it carries the build id); when it takes over a page that
 * an older worker was controlling, the page reloads itself once.
 *
 * Why a reload and not a "tap to reload" note: the kitchen iPad is left open and nobody taps it, so a
 * note would sit there while the old build runs. The plan comes back from the server on reload, so
 * nothing is lost — except a half-typed line, so while a text field has something in it the reload
 * waits until it is left.
 */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker;
  // The first install takes over a page that had no worker: that is not a new build, so no reload.
  const hadWorker = container.controller !== null;
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
    if (hadWorker) reloadWhenIdle();
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

function typing(): boolean {
  const el = document.activeElement;
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value !== "";
}
