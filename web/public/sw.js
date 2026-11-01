// HOME-6: the kitchen iPad keeps showing today's plan even if the network blips.
// HOU-154: pages are network first, so a reload after a deploy gets the new build; the cache is only
// the offline fallback. Hashed assets are cache first (a new build has new names); icons refresh in
// the background. Views (/api/trpc/*): network first, falling back to the last good answer. Nothing
// else is cached; messages always go to the network.
// The server writes its build id over __BUILD__ (server/http/app.ts), so every deploy is a new worker:
// it installs, takes over, drops the older build's shell cache, and the open page reloads once.
const BUILD = "__BUILD__";
const SHELL = `household-shell-${BUILD}`;
const VIEWS = "household-views-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(["/", "/manifest.webmanifest"]).catch(() => undefined)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== VIEWS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached !== undefined) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  const html = (response.headers.get("content-type") ?? "").startsWith("text/html");
  if (response.ok && !html) await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request);
  const fresh = fetch(request)
    .then((response) => {
      if (response.ok) void cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached ?? fresh;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api/live") return;
  if (url.pathname.startsWith("/api/trpc/")) {
    event.respondWith(networkFirst(request, VIEWS));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request, SHELL).catch(async () => {
        const cache = await caches.open(SHELL);
        return (await cache.match("/")) ?? Response.error();
      }),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/")) event.respondWith(cacheFirst(request));
  else if (url.pathname.startsWith("/icon")) event.respondWith(staleWhileRevalidate(request));
});
