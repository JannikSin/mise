// Mise service worker — Task 10 hardening.
//
// Strategy (kills the old reopen-twice staleness):
//   - app code + index (unhashed filenames that change per deploy):
//     NETWORK-FIRST with cache fallback — online users always get the
//     current deploy in one load; offline serves the last good copy.
//   - vendor/, fonts, icons (version-pinned, replaced wholesale):
//     CACHE-FIRST — immutable until a deploy changes CACHE_VERSION.
//   - GitHub API: never intercepted (the data layer owns freshness).
// P4: CACHE_VERSION is bumped AUTOMATICALLY by the pre-commit hook (tools/bump-sw-version.mjs)
// whenever a commit touches app code — a deploy therefore always ships a
// byte-different sw.js, the browser installs it (skipWaiting+claim), and
// main.js reloads once on controllerchange so no load ever runs a half-old
// module graph. tests/sw.test.js pins the SHELL list to the real app files.
const CACHE_VERSION = "mise-shell-v20";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./app/styles.css",
  "./app/main.js",
  "./app/types.js",
  "./app/lib/dates.js",
  "./app/lib/db.js",
  "./app/lib/dozen.js",
  "./app/lib/drag.js",
  "./app/lib/fitness.js",
  "./app/lib/github.js",
  "./app/lib/merge.js",
  "./app/lib/plan.js",
  "./app/lib/portions.js",
  "./app/lib/prices.js",
  "./app/lib/remedies.js",
  "./app/lib/router.js",
  "./app/lib/scan.js",
  "./app/lib/shopping.js",
  "./app/lib/store.js",
  "./app/lib/sync.js",
  "./app/lib/tour.js",
  "./app/lib/vitals.js",
  "./app/lib/weekbuilder.js",
  "./app/lib/weight.js",
  "./app/lib/worker.js",
  "./app/views/confirm-modal.js",
  "./app/views/cookbook.js",
  "./app/views/dozen-tally.js",
  "./app/views/fitness.js",
  "./app/views/home.js",
  "./app/views/interval-timer.js",
  "./app/views/onboard.js",
  "./app/views/planner.js",
  "./app/views/profile-gate.js",
  "./app/views/recipe-row.js",
  "./app/views/recipe.js",
  "./app/views/remedies.js",
  "./app/views/shopping.js",
  "./app/views/system.js",
  "./app/views/today.js",
  "./app/views/tour.js",
  "./app/views/vitals.js",
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

/** Cache a successful response without blocking its delivery.
 * @param {Request} req @param {Response} res */
function putInCache(req, res) {
  if (!res.ok) return;
  const copy = res.clone();
  caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
}

/** @param {Request} req */
async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  putInCache(req, res);
  return res;
}

/** @param {Request} req */
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    putInCache(req, res);
    return res;
  } catch {
    const hit = await caches.match(req, { ignoreSearch: req.mode === "navigate" });
    if (hit) return hit;
    throw new Error("offline and not cached: " + req.url);
  }
}
