/* AhaReading service worker (spec 12.2, hand-written — no next-pwa).
 *
 * - App shell + offline page precached.
 * - /_next/static/*: cache-first (content-hashed, immutable).
 * - GET /api/notebook*, /api/review, /api/articles*: network-first, cached
 *   copy when offline or when the server answers 5xx (database down, PO-12),
 *   marked with x-aha-from-cache: 1. The page wipes these caches on sign-out,
 *   on a 401 and when a different user signs in (SEC-3, local-data.js).
 * - Never cached: /api/auth/*, /api/explain, /api/translate, /api/health,
 *   /api/admin/*, /api/client-error, /api/me and every non-GET request.
 * - Navigations: network-first; signed-in app pages fall back to their last
 *   cached copy, everything else to /offline.html.
 */
const VERSION = "v2";
const SHELL = `aha-shell-${VERSION}`;
const STATIC = `aha-static-${VERSION}`;
const API = `aha-api-${VERSION}`;
const PAGES = `aha-pages-${VERSION}`;
const KEEP = [SHELL, STATIC, API, PAGES];

const PRECACHE = [
  "/offline.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

const API_CACHEABLE = [/^\/api\/notebook(\/|$)/, /^\/api\/review$/, /^\/api\/articles(\/|$)/];
const API_NEVER = [/^\/api\/auth(\/|$)/, /^\/api\/explain/, /^\/api\/translate/, /^\/api\/health/, /^\/api\/admin(\/|$)/, /^\/api\/client-error/, /^\/api\/me(\/|$)/];
const APP_PAGES = [/^\/read(\/|$)/, /^\/notebook(\/|$)/, /^\/review$/, /^\/settings$/];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("aha-") && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function markFromCache(response) {
  const headers = new Headers(response.headers);
  headers.set("x-aha-from-cache", "1");
  return response.blob().then((body) => new Response(body, { status: response.status, statusText: response.statusText, headers }));
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(STATIC);
    cache.put(request, response.clone());
  }
  return response;
}

async function cachedApi(cache, request, url) {
  let cached = await cache.match(request);
  // Offline search/filter: fall back to the unfiltered list (filtered client-side).
  if (!cached && url.pathname === "/api/notebook") cached = await cache.match("/api/notebook?");
  if (!cached && url.pathname === "/api/notebook") cached = await cache.match("/api/notebook", { ignoreSearch: true });
  return cached || null;
}

async function apiNetworkFirst(request, url) {
  const cache = await caches.open(API);
  let response;
  try {
    response = await fetch(request);
  } catch (err) {
    const cached = await cachedApi(cache, request, url);
    if (cached) return markFromCache(cached);
    throw err;
  }
  // Only successful, user-specific data; 401s etc. must never be replayed.
  if (response.ok) {
    cache.put(request, response.clone());
    return response;
  }
  // Server trouble (5xx): the last good copy beats an error page. A 4xx is
  // a real answer (401 signed out, 404 deleted) and is passed through.
  if (response.status >= 500) {
    const cached = await cachedApi(cache, request, url);
    if (cached) return markFromCache(cached);
  }
  return response;
}

async function navigate(request, url) {
  const isAppPage = APP_PAGES.some((re) => re.test(url.pathname));
  try {
    const response = await fetch(request);
    if (isAppPage && response.ok && response.type === "basic") {
      const cache = await caches.open(PAGES);
      cache.put(url.pathname, response.clone());
    }
    return response;
  } catch {
    if (isAppPage) {
      const cache = await caches.open(PAGES);
      const exact = await cache.match(url.pathname);
      if (exact) return exact;
    }
    return (await caches.match("/offline.html")) || new Response("You're offline.", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

// After sign-in the page asks for the offline-critical pages to be saved, so
// Notebook and Review open offline even if they were never visited (PO-12).
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "warm" || !Array.isArray(data.paths)) return;
  if (event.origin && event.origin !== self.location.origin) return;
  const paths = data.paths.filter((p) => typeof p === "string" && APP_PAGES.some((re) => re.test(p))).slice(0, 5);
  event.waitUntil(
    caches.open(PAGES).then((cache) =>
      Promise.all(
        paths.map((path) =>
          fetch(path, { credentials: "same-origin", headers: { Accept: "text/html" } })
            .then((response) => (response.ok && response.type === "basic" ? cache.put(path, response) : undefined))
            .catch(() => {})
        )
      )
    )
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(navigate(request, url));
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    if (API_NEVER.some((re) => re.test(url.pathname))) return;
    if (API_CACHEABLE.some((re) => re.test(url.pathname))) event.respondWith(apiNetworkFirst(request, url));
    return;
  }
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});
