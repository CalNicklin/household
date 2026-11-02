// HOME-6: the kitchen iPad keeps showing today's plan even if the network blips.
// HOU-154: pages are network first, so a reload after a deploy gets the new build; the cache is only
// the offline fallback. Hashed assets are cache first (a new build has new names); icons refresh in
// the background. Views (/api/trpc/*): network first, falling back to the last good answer. Nothing
// else is cached; messages always go to the network.
// The server writes its build id over __BUILD__ (server/http/app.ts), so every deploy is a new worker:
// it installs, takes over, drops the older build's shell cache, and the open page reloads once.
// HOU-165: views are kept per person, in a cache named for whoever the server says the answer is for
// (VIEW_PERSON_HEADER in contracts/src/views.ts). Only one person's cache is ever kept: an answer for
// someone else, a login, a logout or a "login required" drops the rest first. Answers sent `no-store`
// (NO_STORE_VIEWS) are never kept, so on a shared iPad no one sees another's views, online or not.
const BUILD = "__BUILD__";
const SHELL = `household-shell-${BUILD}`;
const VIEWS = "household-views:"; // VIEWS_CACHE_PREFIX in contracts/src/views.ts
const PERSON_HEADER = "x-household-person";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(["/", "/manifest.webmanifest"]).catch(() => undefined)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && !k.startsWith(VIEWS)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Drop every person's views except `keep`'s (all of them when `keep` is null). */
async function dropViews(keep) {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith(VIEWS) && k !== keep).map((k) => caches.delete(k)));
}

async function views(request) {
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    // Offline: the last good answer, from the one person's views kept on this device.
    const name = (await caches.keys()).find((k) => k.startsWith(VIEWS));
    const cached = name === undefined ? undefined : await (await caches.open(name)).match(request);
    if (cached !== undefined) return cached;
    throw error;
  }
  const person = response.headers.get(PERSON_HEADER);
  if (response.status === 401) await dropViews(null);
  else if (response.ok && person !== null && person !== "") {
    const name = VIEWS + encodeURIComponent(person);
    await dropViews(name);
    const cache = await caches.open(name);
    if (/no-store/i.test(response.headers.get("cache-control") ?? "")) await cache.delete(request);
    else await cache.put(request, response.clone());
  }
  return response;
}

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
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // HOU-165: someone is signing in or out; the views kept for whoever was here go first.
  if (request.method === "POST" && (url.pathname === "/api/login" || url.pathname === "/api/logout")) {
    event.respondWith(dropViews(null).catch(() => undefined).then(() => fetch(request)));
    return;
  }
  if (request.method !== "GET") return;
  if (url.pathname === "/api/live") return;
  if (url.pathname.startsWith("/api/trpc/")) {
    event.respondWith(views(request));
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
