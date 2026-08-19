// Seed the price catalogue + pin book with LIVE Kroger prices (fix list 3.1:
// "live prices must populate the expensive protein rows first").
//
// Runs the app's OWN logic (rankCandidates / applyLivePrice / setPin from
// app/lib/kroger.js) so the seeded rows are byte-what-the-app-would-write:
// ids are ledger keys, prices are timestamped, pins are PROVISIONAL until
// David's confirm-once tap in the app (fix list 3.2).
//
// Usage (creds via env, never argv):
//   $env:KROGER_CLIENT_ID = ...; $env:KROGER_CLIENT_SECRET = ...
//   node tools/kroger-seed.mjs [--dry]
//
// One search per food per store — ~90 calls against a 10k/day quota.

import { readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyLivePrice, normalizePins, pinKey, rankCandidates, setPin } from "../app/lib/kroger.js";
import { sectionOf } from "../app/lib/shopping.js";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "mise-data");
const DRY = process.argv.includes("--dry");
const TODAY = process.argv.find((a) => a.startsWith("--today="))?.slice(8) ??
  new Date().toISOString().slice(0, 10);

const STORES = {
  marianos: { locationId: "53100502", name: "Mariano's Vernon Hills" },
  "pay-less": { locationId: "02100824", name: "Pay Less Super Markets W Lafayette" },
};

// the expensive half of the basket (fix list 3.1) — every dollar lives here
const PRIORITY_FOODS = [
  "salmon fillet", "chicken breast", "chicken thighs", "ground beef",
  "ground turkey", "shrimp", "cod fillet", "cashews", "almonds", "walnuts",
  "almond butter", "peanut butter", "whey protein powder", "medjool dates",
  "greek yogurt", "cottage cheese", "eggs", "extra firm tofu", "tempeh",
  "olive oil", "frozen blueberries", "frozen mixed vegetables", "feta cheese",
  "cheddar cheese", "mozzarella", "quinoa", "brown rice", "black beans",
];

const cid = process.env.KROGER_CLIENT_ID;
const csec = process.env.KROGER_CLIENT_SECRET;
if (!cid || !csec) {
  console.error("KROGER_CLIENT_ID / KROGER_CLIENT_SECRET env vars required");
  process.exit(1);
}

const tokenRes = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    authorization: "Basic " + Buffer.from(`${cid}:${csec}`).toString("base64"),
  },
  body: new URLSearchParams({ grant_type: "client_credentials", scope: "product.compact" }),
});
if (!tokenRes.ok) {
  console.error("token failed", tokenRes.status);
  process.exit(1);
}
const TOKEN = (await tokenRes.json()).access_token;

/** same trim as worker/src/kroger.js trimProduct */
function trim(p) {
  const it = (Array.isArray(p?.items) ? p.items[0] : null) ?? {};
  const price = it.price ?? {};
  return {
    upc: String(p?.upc ?? ""),
    description: String(p?.description ?? ""),
    brand: typeof p?.brand === "string" ? p.brand : "",
    categories: (Array.isArray(p?.categories) ? p.categories : []).map(String),
    size: typeof it.size === "string" ? it.size : "",
    soldBy: typeof it.soldBy === "string" ? it.soldBy : "",
    price: {
      regular: typeof price.regular === "number" ? price.regular : null,
      promo: typeof price.promo === "number" && price.promo > 0 ? price.promo : null,
    },
    stock: String(it.inventory?.stockLevel ?? ""),
    aisle: String((Array.isArray(p?.aisleLocations) ? p.aisleLocations[0] : null)?.description ?? ""),
  };
}

async function search(term, locationId) {
  const q = new URLSearchParams({
    "filter.term": term,
    "filter.locationId": locationId,
    "filter.limit": "30",
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://api.kroger.com/v1/products?${q}`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json" },
    });
    if (res.ok) return ((await res.json()).data ?? []).map(trim);
    if (![429, 502, 503].includes(res.status)) return [];
    await new Promise((r) => setTimeout(r, 1200));
  }
  return [];
}

// foods = current shopping list + the priority list, deduped on the ledger key
const shopping = JSON.parse(readFileSync(join(DATA, "shopping.json"), "utf8"));
const foods = new Map();
for (const f of PRIORITY_FOODS) foods.set(pinKey(f), { food: f, section: sectionOf(f) });
for (const it of shopping.items ?? []) {
  if (it.checked) continue;
  const key = pinKey(it.food);
  if (!foods.has(key)) foods.set(key, { food: it.food, section: it.section ?? sectionOf(it.food) });
}

let catalogue = JSON.parse(readFileSync(join(DATA, "prices.json"), "utf8"));
let pins;
try {
  pins = normalizePins(JSON.parse(readFileSync(join(DATA, "pins.json"), "utf8")));
} catch {
  pins = normalizePins(null);
}
pins = { ...pins, updated: TODAY, stores: { ...pins.stores, ...STORES } };

const report = {};
for (const [store, { locationId }] of Object.entries(STORES)) {
  report[store] = { priced: [], missed: [] };
  for (const [key, { food, section }] of foods) {
    const existingPin = pins.pins[key]?.[store];
    if (existingPin) continue; // learn-once: never re-search a pinned food
    const ranked = rankCandidates(await search(food, locationId), food, pins.redList, section);
    const best = ranked[0];
    if (!best) {
      report[store].missed.push(food);
      continue;
    }
    // an unattended seed refuses a noisy best match: a wrong pin lies with
    // authority, an honest miss gets one tap in the app's pick sheet
    if (best.noise > 2) {
      report[store].missed.push(`${food} (too noisy: ${best.description})`);
      continue;
    }
    catalogue = applyLivePrice(catalogue, store, food, best, TODAY);
    pins = setPin(pins, food, store, best, TODAY, false);
    report[store].priced.push(
      `${food} -> ${best.description} | ${best.size} | $${best.price.regular}` +
        (best.soldBy === "WEIGHT" ? "/lb" : "") +
        (best.unitLabel ? ` (${best.unitLabel})` : ""),
    );
    await new Promise((r) => setTimeout(r, 250));
  }
}

for (const [store, r] of Object.entries(report)) {
  console.log(`\n=== ${store}: ${r.priced.length} priced, ${r.missed.length} missed`);
  for (const line of r.priced) console.log("  " + line);
  if (r.missed.length) console.log("  MISSED: " + r.missed.join("; "));
}

if (DRY) {
  console.log("\n--dry: nothing written");
} else {
  writeFileSync(join(DATA, "prices.json"), JSON.stringify(catalogue, null, 2) + "\n");
  writeFileSync(join(DATA, "pins.json"), JSON.stringify(pins, null, 2) + "\n");
  console.log(`\nwrote prices.json (${catalogue.items.length} items) + pins.json`);
}
