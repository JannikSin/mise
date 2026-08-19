// Need-aware re-pick pass (2026-08-19, David: "price things correctly").
// The seed ran before 3.6, so provisional pins were chosen on UNIT price and
// small needs got big packages (a 3 lb beef tray for a 450 g need, a 32 oz
// cashew tub for 0.75 cup). This pass, per store:
//   1. merges alias-collapsed duplicate keys (eggs→egg, chicken-thighs→
//      chicken-thigh, ...) in pins + catalogue, keeping the cheaper cover;
//   2. re-searches every PROVISIONAL pin whose row need is known, ranks with
//      the need (3.6), and re-pins when the new pick covers the need ≥15%
//      cheaper;
//   3. retries previously-unpriced foods with alternate search terms.
// Confirmed pins are never touched: David's tap outranks any optimizer.
//
// Usage: $env:KROGER_CLIENT_ID/SECRET set; node tools/kroger-repick.mjs [--today=...]

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyLivePrice, normalizePins, pinKey, rankCandidates, setPin } from "../app/lib/kroger.js";
import { deriveShoppingList, normalizePantry, sectionOf } from "../app/lib/shopping.js";
import { recipesById } from "../app/lib/plan.js";
import { itemCost, tripTotal } from "../app/lib/prices.js";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "mise-data");
const TODAY = process.argv.find((a) => a.startsWith("--today="))?.slice(8) ??
  new Date().toISOString().slice(0, 10);

// old duplicate key -> canonical key (NAME_ALIASES now collapses these)
const KEY_MERGES = {
  eggs: "egg",
  "chicken-thighs": "chicken-thigh",
  onions: "onion",
  scallions: "scallion",
  "bay-leaves": "bay-leaf",
  // David 2026-08-19: fresh/frozen mixed berries are ONE identity (both
  // list rows were charging a whole package each), and the plural
  // sweet-potatoes row was a stale duplicate of sweet-potato
  "frozen-mixed-berries": "mixed-berries",
  "sweet-potatoes": "sweet-potato",
};

// pins the seed got WRONG (2026-08-19 walk): product is not the food, or a
// specialty variant when the plain one was asked for. Dropped so the retry
// terms below re-price them honestly.
const BAD_PINS = [
  ["gochujang", "pay-less", "pinned gochujang-flavored ALMONDS, not the paste"],
  ["milk", "marianos", "pinned CARBMaster lactose-free skim, not plain milk"],
];

// foods the seed missed, with alternate live search terms worth one try each
const RETRY_TERMS = {
  "mixed-berries": ["frozen berry medley", "frozen triple berry blend", "frozen mixed berries"],
  "chia-seeds": ["organic chia seeds", "chia seeds"],
  "bulgogi-marinade": ["bulgogi sauce", "korean bbq sauce"],
  "red-pepper-flakes": ["crushed red pepper"],
  // 2026-08-19 second seed round misses
  "crusty-bread": ["french bread loaf", "italian bread"],
  "whole-wheat-angel-hair-pasta": ["whole wheat thin spaghetti", "angel hair pasta"],
  "cauliflower-head": ["cauliflower"],
  scallion: ["green onions bunch", "green onions"],
  tempeh: ["lightlife tempeh", "tempeh original"],
  chickpeas: ["garbanzo beans", "canned chickpeas"],
  "shelled-edamame": ["frozen shelled edamame"],
  gochujang: ["gochujang paste", "korean chili paste"],
  milk: ["whole milk half gallon", "whole milk"],
  "frozen-mango": ["frozen mango chunks", "frozen mango"],
};

const cid = process.env.KROGER_CLIENT_ID;
const csec = process.env.KROGER_CLIENT_SECRET;
if (!cid || !csec) { console.error("KROGER env creds required"); process.exit(1); }
const tokenRes = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded",
    authorization: "Basic " + Buffer.from(`${cid}:${csec}`).toString("base64") },
  body: new URLSearchParams({ grant_type: "client_credentials", scope: "product.compact" }),
});
const TOKEN = (await tokenRes.json()).access_token;

function trim(p) {
  const it = (Array.isArray(p?.items) ? p.items[0] : null) ?? {};
  const price = it.price ?? {};
  return {
    upc: String(p?.upc ?? ""), description: String(p?.description ?? ""),
    brand: typeof p?.brand === "string" ? p.brand : "",
    categories: (Array.isArray(p?.categories) ? p.categories : []).map(String),
    size: typeof it.size === "string" ? it.size : "",
    soldBy: typeof it.soldBy === "string" ? it.soldBy : "",
    price: { regular: typeof price.regular === "number" ? price.regular : null,
      promo: typeof price.promo === "number" && price.promo > 0 ? price.promo : null },
    stock: String(it.inventory?.stockLevel ?? ""),
    aisle: String((Array.isArray(p?.aisleLocations) ? p.aisleLocations[0] : null)?.description ?? ""),
  };
}
async function search(term, locationId) {
  const q = new URLSearchParams({ "filter.term": term, "filter.locationId": locationId, "filter.limit": "30" });
  for (let a = 0; a < 3; a++) {
    const res = await fetch(`https://api.kroger.com/v1/products?${q}`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json" } });
    if (res.ok) return ((await res.json()).data ?? []).map(trim);
    if (![429, 502, 503].includes(res.status)) return [];
    await new Promise((r) => setTimeout(r, 1200));
  }
  return [];
}

// the real derived week: needs per canonical key
const recipes = readdirSync(join(DATA, "recipes")).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(DATA, "recipes", f), "utf8")));
const byId = recipesById(recipes);
const plan = JSON.parse(readFileSync(join(DATA, "plans", "2026-W34.json"), "utf8"));
const pantry = normalizePantry(JSON.parse(readFileSync(join(DATA, "households", "taranowski", "pantry.json"), "utf8")));
const listItems = deriveShoppingList(plan, byId, pantry, null, undefined, undefined, byId)
  .items.filter((i) => !i.checked);
const needByKey = new Map();
for (const i of listItems) needByKey.set(pinKey(i.food), { qty: i.qty, unit: i.unit, food: i.food, section: i.section });

let catalogue = JSON.parse(readFileSync(join(DATA, "prices.json"), "utf8"));
let pins = normalizePins(JSON.parse(readFileSync(join(DATA, "pins.json"), "utf8")));

// ---- 1. merge alias-collapsed duplicate keys --------------------------------
for (const [oldKey, newKey] of Object.entries(KEY_MERGES)) {
  const oldPin = pins.pins[oldKey];
  if (oldPin) {
    pins.pins[newKey] = { ...(oldPin ?? {}), ...(pins.pins[newKey] ?? {}) };
    // per store, keep whichever product covers the need cheaper
    for (const store of Object.keys(oldPin)) {
      const need = needByKey.get(newKey);
      const oldRow = catalogue.items.find((i) => i.id === oldKey);
      const newRow = catalogue.items.find((i) => i.id === newKey);
      const cost = (row) => {
        if (!row?.prices?.[store] || !need) return Infinity;
        const c = itemCost({ food: need.food, qty: need.qty, unit: need.unit },
          { items: [{ ...row, id: "probe", name: need.food }], stores: [store] }, store);
        return c ? c.cost : Infinity;
      };
      // David's tap outranks any optimizer: a CONFIRMED pin under the
      // canonical key is never overwritten by a cheaper legacy duplicate
      // (reviewer catch 2026-08-19)
      if (pins.pins[newKey][store]?.confirmedAt) continue;
      if (cost(oldRow) < cost(newRow)) {
        pins.pins[newKey][store] = oldPin[store];
        if (oldRow?.prices?.[store]) {
          if (!newRow) catalogue.items.push({ id: newKey, name: newKey.replace(/-/g, " "), prices: {} });
          catalogue.items.find((i) => i.id === newKey).prices[store] = oldRow.prices[store];
        }
        console.log(`merged ${oldKey} -> ${newKey} @ ${store} (old product covers cheaper)`);
      }
    }
  }
  delete pins.pins[oldKey];
  catalogue.items = catalogue.items.filter((i) => i.id !== oldKey);
}

// water is free from the tap: pin and catalogue rows leave
for (const k of ["water", "tap-water"]) {
  if (pins.pins[k]) { delete pins.pins[k]; console.log(`dropped pin: ${k} (free from the tap)`); }
  catalogue.items = catalogue.items.filter((i) => i.id !== k);
}

// wrong-product pins leave before the retry pass re-prices them
for (const [key, store, why] of BAD_PINS) {
  if (pins.pins[key]?.[store]) {
    delete pins.pins[key][store];
    if (Object.keys(pins.pins[key]).length === 0) delete pins.pins[key];
    const row = catalogue.items.find((i) => i.id === key);
    if (row?.prices?.[store]) delete row.prices[store];
    console.log(`dropped pin: ${key} @ ${store} (${why})`);
  }
}

// ---- 2. need-aware repick of provisional pins -------------------------------
for (const [store, { locationId }] of Object.entries(pins.stores)) {
  for (const [key, byStore] of Object.entries(pins.pins)) {
    const pin = byStore[store];
    if (!pin || !pin.provisional) continue;
    const need = needByKey.get(key);
    if (!need) continue;
    const row = catalogue.items.find((i) => i.id === key) ??
      catalogue.items.find((i) => i.name === need.food.toLowerCase());
    const cur = row ? itemCost({ food: need.food, qty: need.qty, unit: need.unit },
      { items: [{ ...row, id: "probe-" + key, name: need.food }], stores: [store] }, store) : null;
    const ranked = rankCandidates(await search(need.food, locationId), need.food, pins.redList,
      need.section ?? sectionOf(need.food), { qty: need.qty, unit: need.unit });
    const best = ranked[0];
    if (!best || best.noise > 2 || best.spend == null) continue;
    if (cur && best.spend >= cur.cost * 0.85) continue; // not meaningfully cheaper
    pins = setPin(pins, need.food, store, best, TODAY, false);
    catalogue = applyLivePrice(catalogue, store, need.food, best, TODAY);
    console.log(`repick ${key} @ ${store}: ${cur ? "$" + cur.cost : "?"} -> $${best.spend} | ${best.description} | ${best.size}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---- 3. retry the unpriced foods with alternate terms -----------------------
for (const [store, { locationId }] of Object.entries(pins.stores)) {
  for (const [key, terms] of Object.entries(RETRY_TERMS)) {
    if (pins.pins[key]?.[store]) continue;
    const need = needByKey.get(key) ?? null;
    for (const term of terms) {
      const ranked = rankCandidates(await search(term, locationId), term, pins.redList,
        need?.section ?? sectionOf(key.replace(/-/g, " ")), need ? { qty: need.qty, unit: need.unit } : null);
      const best = ranked[0];
      if (!best || best.noise > 2) continue;
      pins = setPin(pins, key.replace(/-/g, " "), store, best, TODAY, false);
      catalogue = applyLivePrice(catalogue, store, key.replace(/-/g, " "), best, TODAY);
      console.log(`priced ${key} @ ${store} via "${term}": $${best.price.regular} | ${best.description} | ${best.size}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

pins.updated = TODAY;
writeFileSync(join(DATA, "prices.json"), JSON.stringify(catalogue, null, 2) + "\n");
writeFileSync(join(DATA, "pins.json"), JSON.stringify(pins, null, 2) + "\n");
for (const store of Object.keys(pins.stores)) {
  const t = tripTotal(listItems, catalogue, store, { country: "USA", state: "IL" });
  console.log(`${store}: priced ${t.priced}/${listItems.length}, subtotal $${t.subtotal.toFixed(2)}`);
}
