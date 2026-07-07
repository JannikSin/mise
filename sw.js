// Mise service worker — Task 10 hardening.
//
// Strategy (kills the old reopen-twice staleness):
//   - app code + index (unhashed filenames that change per deploy):
//     NETWORK-FIRST with cache fallback — online users always get the
//     current deploy in one load; offline serves the last good copy.
//   - vendor/, fonts, icons (version-pinned, replaced wholesale):
//     CACHE-FIRST — immutable until a deploy changes CACHE_VERSION.
//   - GitHub API: never intercepted (the data layer owns freshness).
// Bump CACHE_VERSION on deploys that change vendor/icon files; app-code
// changes no longer need it for freshness, only for precache hygiene.

const CACHE_VERSION = "mise-shell-v12";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./app/styles.css",
  "./app/main.js",
  "./app/lib/github.js",
  "./app/lib/merge.js",
  "./app/lib/sync.js",
  "./app/lib/db.js",
  "./app/lib/store.js",
  "./app/lib/router.js",
  "./app/lib/quiz.js",
  "./app/lib/dates.js",
  "./app/lib/plan.js",
  "./app/lib/drag.js",
  "./app/lib/shopping.js",
  "./app/lib/fitness.js",
  "./app/lib/remedies.js",
  "./app/views/home.js",
  "./app/views/quiz.js",
  "./app/views/cookbook.js",
  "./app/views/recipe.js",
  "./app/views/recipe-row.js",
  "./app/views/system.js",
  "./app/views/planner.js",
  "./app/views/shopping.js",
  "./app/views/fitness.js",
  "./app/views/remedies.js",
  "./vendor/preact/preact.module.js",
  "./vendor/preact/hooks.module.js",
  "./vendor/htm/htm.module.js",
  "./vendor/htm/preact.module.js",
  "./vendor/fonts/archivo-var.woff2",
  "./vendor/fonts/jetbrains-mono-var.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

/** version-pinned top-level dirs under the SW scope: cache-first
 *  (anchored to the scope so e.g. a future app/views/icons-*.js can never
 *  accidentally match) */
const SCOPE_PATH = new URL(
  self.registration ? self.registration.scope : self.location.href,
).pathname.replace(/[^/]*$/, "");
const IMMUTABLE = new RegExp(
  `^${SCOPE_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(vendor|icons)/`,
);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never intercept the GitHub API — the data layer owns freshness (rule 3).
  if (url.origin !== self.location.origin) return;

  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
  } else {
    event.respondWith(networkFirst(req));
  }
});

/** @param {Request} req */
async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
  }
  return res;
}

/** @param {Request} req */
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
    }
    return res;
  } catch {
    const hit = await caches.match(req, { ignoreSearch: req.mode === "navigate" });
    if (hit) return hit;
    throw new Error("offline and not cached: " + req.url);
  }
}
