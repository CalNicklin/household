/** A build comparison that could not finish (see registerServiceWorker); checkForUpdate retries it. */
let pending: (() => Promise<void>) | null = null;

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
  // A new worker took over: compare builds. If the server can't say right now (a Wi-Fi blip), the
  // comparison stays pending and the next check (checkForUpdate, at least once a minute) retries it.
  const compare = async () => {
    const build = await currentBuild();
    pending = build === undefined ? compare : null;
    if (build !== undefined && build !== page) reloadWhenIdle();
  };
  container.addEventListener("controllerchange", () => {
    if (page === null || container.controller === null) return;
    void compare();
  });
  void container
    .register("/sw.js", { updateViaCache: "none" })
    .then(watch)
    .catch(() => {});
}

/** HOU-166: a new worker that has installed is told to take over until it does (see nudge). */
function watch(registration: ServiceWorkerRegistration): void {
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed") nudge(registration, 1_000);
    });
  });
}

/**
 * HOU-166: ask a worker left waiting to take over (it calls skipWaiting() again, web/public/sw.js), then
 * ask again after `after` ms, twice as long each time, until none is waiting. Chromium can drop a
 * takeover: it stops the old worker to hand over, a fetch from this screen (the refetches that follow
 * a reconnect) starts it again in that instant, and the new worker is left waiting with nothing to look
 * again. The screen then never sees controllerchange, so it never reloads into the new build.
 */
function nudge(registration: ServiceWorkerRegistration, after: number): void {
  const waiting = registration.waiting;
  if (waiting === null) return;
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a ServiceWorker's postMessage has no target origin
  waiting.postMessage("skip-waiting");
  window.setTimeout(() => nudge(registration, after * 2), after);
}

/**
 * HOU-154: ask whether a newer worker is out, and finish a build comparison that couldn't. Called when
 * the live connection (re)opens (a deploy restarts the server), every minute, and on a glance.
 */
export function checkForUpdate(): void {
  if (!("serviceWorker" in navigator)) return;
  if (pending !== null) void pending();
  void navigator.serviceWorker
    .getRegistration()
    .then((r) => r?.update())
    .catch(() => {});
}

/**
 * The build the server is now: the `x-household-build` header on /sw.js (server/http/app.ts), which is
 * where the worker that just took over came from. Undefined when the server can't be asked right now.
 */
async function currentBuild(): Promise<string | undefined> {
  try {
    const res = await fetch("/sw.js", { cache: "no-store" });
    return (res.ok ? res.headers.get("x-household-build") : null) ?? undefined;
  } catch {
    return undefined;
  }
}

function typing(): boolean {
  const el = document.activeElement;
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value !== "";
}
