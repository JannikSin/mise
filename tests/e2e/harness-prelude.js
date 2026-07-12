// E2E harness prelude for Playwright-MCP run_code sessions. ASCII ONLY.
// Not a module: raw statements, concatenated before a scenario body inside
// `async (page) => { const events = []; try { <prelude+scenario> } ... }`
// via PowerShell (see tests/e2e/README.md). The MCP sandbox has NO Node
// globals (no Buffer/URL/require), hence the hand-rolled UTF-8 base64.

const B64A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const b64bytes = (bytes) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const c1 = bytes[i],
      c2 = bytes[i + 1],
      c3 = bytes[i + 2];
    out += B64A[c1 >> 2] + B64A[((c1 & 3) << 4) | (c2 === undefined ? 0 : c2 >> 4)];
    out += c2 === undefined ? "=" : B64A[((c2 & 15) << 2) | (c3 === undefined ? 0 : c3 >> 6)];
    out += c3 === undefined ? "=" : B64A[c3 & 63];
  }
  return out;
};
const utf8bytes = (s) => {
  const b = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) b.push(cp);
    else if (cp < 0x800) b.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) b.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      b.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return b;
};
const enc = (s) => b64bytes(utf8bytes(s));
const dec8 = (b) => {
  b = b.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = [];
  for (let i = 0; i < b.length; i += 4) {
    const n =
      (B64A.indexOf(b[i]) << 18) |
      (B64A.indexOf(b[i + 1]) << 12) |
      ((B64A.indexOf(b[i + 2]) & 63) << 6) |
      (B64A.indexOf(b[i + 3]) & 63);
    bytes.push((n >> 16) & 255);
    if (b[i + 2] !== undefined) bytes.push((n >> 8) & 255);
    if (b[i + 3] !== undefined) bytes.push(n & 255);
  }
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCodePoint(((c & 31) << 6) | (bytes[++i] & 63));
    else if (c < 0xf0)
      s += String.fromCodePoint(((c & 15) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63));
    else
      s += String.fromCodePoint(
        ((c & 7) << 18) | ((bytes[++i] & 63) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63),
      );
  }
  return s;
};

const SEED_RECIPES = [
  "beef-bulgogi-rice-bowl",
  "breakfast-plate",
  "chicken-bulgogi-rice-bowl",
  "chicken-rice-congee",
  "cottage-cheese-pre-bed",
  "doner-style-kebab-bowl",
  "ginger-honey-lemon-tea",
  "nicoise-style-lunch-salad",
  "office-lunch-box",
  "porcini-mushroom-risotto",
  "sunday-meal-prep",
  "training-smoothie",
];
const BASE = "http://127.0.0.1:8378";
const localText = async (p) => (await page.context().request.get(BASE + "/" + p)).text();
const shaOf = (p) => "sha-" + p.replace(/[^a-z0-9-]/gi, "");
const repoFiles = new Map(); // dynamic files written by the app during the run
let shaCounter = 0;

// Mock the GitHub Contents API: seed files served from seed-data/generated,
// dynamic files (plans/shopping/pantry/meta) accept PUTs with sha semantics.
// pantry.json starts from seed unless overwritten.
const mountMock = async () => {
  await page.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    try {
      const full = req.url().split("?")[0];
      const authed = Boolean(req.headers()["authorization"]);
      if (/\/repos\/JannikSin\/mise-data$/.test(full)) {
        return route.fulfill({ status: authed ? 200 : 404, json: authed ? { private: true } : {} });
      }
      if (/\/contents\/recipes$/.test(full)) {
        return route.fulfill({
          status: 200,
          json: SEED_RECIPES.map((n) => ({
            name: n + ".json",
            path: "recipes/" + n + ".json",
            sha: shaOf("recipes/" + n + ".json"),
            type: "file",
          })),
        });
      }
      const seedM = full.match(/\/contents\/(recipes\/[-a-z]+\.json)$/);
      if (seedM && req.method() === "GET") {
        return route.fulfill({
          status: 200,
          json: {
            content: enc(await localText("seed-data/generated/" + seedM[1])),
            sha: shaOf(seedM[1]),
          },
        });
      }
      // dynamic files: readable AND writable with sha semantics; seed-backed
      // ones start from seed-data/generated until first overwritten
      const dynM = full.match(
        /\/contents\/(plans\/[-A-Za-z0-9]+\.json|meta\.json|shopping\.json|pantry\.json|fitness\/[a-z]+\.json)$/,
      );
      if (dynM) {
        const path = dynM[1];
        const SEEDED = [
          "pantry.json",
          "fitness/targets.json",
          "fitness/workouts.json",
          "fitness/daily.json",
          "fitness/activities.json",
        ];
        const seedSha = SEEDED.includes(path) ? "sha-seed-" + shaOf(path) : undefined;
        if (req.method() === "GET") {
          const f = repoFiles.get(path);
          if (f) return route.fulfill({ status: 200, json: { content: enc(f.json), sha: f.sha } });
          if (seedSha)
            return route.fulfill({
              status: 200,
              json: { content: enc(await localText("seed-data/generated/" + path)), sha: seedSha },
            });
          return route.fulfill({ status: 404, json: {} });
        }
        if (req.method() === "PUT") {
          const body = JSON.parse(req.postData());
          const ex = repoFiles.get(path);
          const expected = ex ? ex.sha : seedSha;
          if ((expected && body.sha !== expected) || (!expected && body.sha)) {
            return route.fulfill({ status: 409, json: {} });
          }
          const next = { json: dec8(body.content), sha: "sha-" + ++shaCounter };
          repoFiles.set(path, next);
          return route.fulfill({ status: 201, json: { content: { sha: next.sha } } });
        }
      }
      return route.fulfill({ status: 404, json: {} });
    } catch (e) {
      events.push("ROUTE ERROR: " + e.message);
      return route.fulfill({ status: 500, json: {} });
    }
  });
};

// Fresh app boot: wipes SW/caches/IDB/localStorage, sets iPhone viewport,
// connects the fake token via the real SYS UI, waits for recipes to load.
const freshBoot = async () => {
  await page.context().setOffline(false);
  page.on("pageerror", (e) => events.push("PAGEERROR: " + e.message));
  await mountMock();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + "/index.html");
  await page.evaluate(async () => {
    localStorage.clear();
    // multi-profile gate: e2e scenarios exercise David's app, not the
    // chooser, so land straight past it exactly like an existing device.
    localStorage.setItem("mise.activeProfile", "david");
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
    await new Promise((r) => {
      const q = indexedDB.deleteDatabase("mise");
      q.onsuccess = r;
      q.onerror = r;
      q.onblocked = r;
    });
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.goto(BASE + "/index.html#/system");
  await page.fill(".token-form input", "fake-pat-for-e2e");
  await page.getByRole("button", { name: "SAVE", exact: true }).click();
  await page.waitForTimeout(4500);
};

const go = async (hash, ms) => {
  await page.goto(BASE + "/index.html" + hash);
  await page.waitForTimeout(ms === undefined ? 500 : ms);
};

const cleanupMock = async () => {
  await page.unroute("https://api.github.com/**");
};
