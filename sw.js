// Mise service worker — app-shell precache, cache-first.
// Bump CACHE_VERSION on every deploy that changes shell files.
// Hardening (update prompts, stale-while-revalidate) lands at Task 10.

const CACHE_VERSION = "mise-shell-v5";

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
  "./app/views/planner.js",
  "./app/views/home.js",
  "./app/views/quiz.js",
  "./app/views/cookbook.js",
  "./app/views/recipe.js",
  "./app/views/recipe-row.js",
  "./app/views/system.js",
  "./vendor/fonts/archivo-var.woff2",
  "./vendor/fonts/jetbrains-mono-var.woff2",
  "./vendor/preact/preact.module.js",
  "./vendor/preact/hooks.module.js",
  "./vendor/htm/htm.module.js",
  "./vendor/htm/preact.module.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

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

  event.respondWith(
    caches.match(req, { ignoreSearch: req.mode === "navigate" }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
