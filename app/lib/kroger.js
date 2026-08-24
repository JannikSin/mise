// Kroger pricing loop, pure logic (fix list Tier 3, promises P4 + P5).
// The flow (Mise-Store-Pricing): resolution is learn-once. An ingredient is
// searched at a store at most once, ever: the shopper confirms a product and
// that pin (ingredient key -> UPC per store) prices the row forever after,
// refreshed by UPC. The pin's key is `canonicalFood`, and it is the ledger's
// PRIMARY KEY (PF.3): pantry rows, list rows, catalogue rows and pins all
// meet on this one key instead of per-render fuzzy matching.
// Network lives in lib/worker.js (krogerSearch/krogerPricesById); this module
// never fetches.

import { aisleOf, canonicalFood, canonicalUnit, convertUnit, toGrams } from "./ingredients.js";
import { matchPrice, parsePackSize } from "./prices.js";

/** @typedef {{ upc: string, description: string, brand: string, categories: string[], size: string, soldBy: string, price: { regular: number | null, promo: number | null }, stock: string, aisle: string, shelf?: { number?: string, side?: string, bay?: string, shelf?: string, description?: string } }} KrogerProduct */
/** @typedef {{ upc: string, description: string, size: string, soldBy: string, aisle?: string, shelf?: { number?: string, side?: string, bay?: string, shelf?: string, description?: string }, brand?: string, categories?: string[], seenAt?: string, confirmedAt?: string, provisional?: boolean }} Pin */
/** @typedef {{ updated?: string, redList: string[], stores: Record<string, { locationId: string, name: string }>, pins: Record<string, Record<string, Pin>> }} PinBook */

/** A live price older than this renders visibly stale (fix list 3.5). */
export const STALE_PRICE_DAYS = 14;

/**
 * pins.json in a shape the rest of this module can trust.
 * @param {any} raw
 * @returns {PinBook}
 */
export function normalizePins(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    ...(typeof r.updated === "string" ? { updated: r.updated } : {}),
    redList: Array.isArray(r.redList) ? r.redList.map(String) : [],
    stores: r.stores && typeof r.stores === "object" ? r.stores : {},
    pins: r.pins && typeof r.pins === "object" ? r.pins : {},
  };
}

/**
 * The ledger key a food is pinned under.
 * @param {string} food
 */
export function pinKey(food) {
  return canonicalFood(food);
}

/**
 * The pin for a food at a store, or null.
 * @param {PinBook | null | undefined} pins
 * @param {string} food
 * @param {string} store
 * @returns {Pin | null}
 */
export function pinFor(pins, food, store) {
  return pins?.pins?.[pinKey(food)]?.[store] ?? null;
}

/**
 * Write (or overwrite) a pin. `confirmed` = the shopper tapped it in the
 * confirm-once flow; false = auto-picked (seed script, cheapest survivor),
 * which still prices the row but renders as provisional until confirmed.
 * @param {PinBook} pins
 * @param {string} food
 * @param {string} store
 * @param {KrogerProduct} product
 * @param {string} todayIso
 * @param {boolean} confirmed
 * @returns {PinBook}
 */
export function setPin(pins, food, store, product, todayIso, confirmed) {
  const key = pinKey(food);
  /** @type {Pin} */
  const pin = {
    upc: product.upc,
    description: product.description,
    size: product.size,
    soldBy: product.soldBy,
    // THE STORE'S OWN ANSWER, KEPT (David, 2026-08-22). `trimProduct` has
    // always returned the per-store aisle, brand and categories on every
    // lookup, free, under the scope we already hold, and this writer used to
    // drop all three on the floor. The list then sorted by a hardcoded
    // taxonomy identical for every store on earth, so Mise asked Pay Less
    // where things were, was told, and used a guess instead.
    // Aisle is per-STORE, which is why it lives on the pin (keyed by store)
    // and not on the catalogue row. Empty string is a real answer meaning
    // "Kroger did not say", and is stored as absent rather than "".
    ...(product.aisle ? { aisle: product.aisle } : {}),
    // WHERE IT PHYSICALLY IS, when the store says. `aisle` is a merchandising
    // label ("NATURAL FOODS"): good for sorting a list into store order, no
    // use for walking to a shelf. `shelf` carries the navigable half -- aisle
    // number, side, bay -- which Kroger returns on the same payload and this
    // writer also dropped. Absent when the store said nothing, which is
    // common on independent banners, so every reader needs a fallback.
    ...(product.shelf && Object.keys(product.shelf).length ? { shelf: product.shelf } : {}),
    ...(product.brand ? { brand: product.brand } : {}),
    ...(Array.isArray(product.categories) && product.categories.length
      ? { categories: product.categories.slice(0, 6) }
      : {}),
    // when this store data was last observed; a store reset moves aisles, so
    // an aisle is only as good as its date and the UI can say so
    seenAt: todayIso,
    ...(confirmed ? { confirmedAt: todayIso } : { provisional: true }),
  };
  return {
    ...pins,
    updated: todayIso,
    pins: { ...pins.pins, [key]: { ...(pins.pins[key] ?? {}), [store]: pin } },
  };
}

/**
 * Refresh the STORE FACTS on an existing pin from a live product payload,
 * without touching what the pin means.
 *
 * The weekly refresh already holds a fresh product for every pinned UPC and
 * used to spend it on price alone, so aisle, brand and pack size on a pin
 * made months ago stayed frozen forever and pins made before 2026-08-22
 * could never gain an aisle at all. This is the backfill: it runs on every
 * refresh and costs nothing, because the payload is already in hand.
 *
 * It deliberately does NOT touch `upc` (identity), `confirmedAt` or
 * `provisional` (what a human decided). Re-pinning to a different product is
 * `setPin`'s job and requires a person; this only updates what the store says
 * about the product already pinned.
 * @param {PinBook} pins
 * @param {string} food
 * @param {string} store
 * @param {KrogerProduct} product
 * @param {string} todayIso
 * @returns {PinBook} unchanged (same reference) when nothing moved
 */
export function refreshPinFacts(pins, food, store, product, todayIso) {
  const key = pinKey(food);
  const cur = pins.pins?.[key]?.[store];
  if (!cur || cur.upc !== product.upc) return pins;
  /** @type {Pin} */
  const next = {
    ...cur,
    ...(product.description ? { description: product.description } : {}),
    ...(product.size ? { size: product.size } : {}),
    ...(product.soldBy ? { soldBy: product.soldBy } : {}),
    ...(product.aisle ? { aisle: product.aisle } : {}),
    ...(product.brand ? { brand: product.brand } : {}),
    ...(Array.isArray(product.categories) && product.categories.length
      ? { categories: product.categories.slice(0, 6) }
      : {}),
    seenAt: todayIso,
  };
  const same = Object.keys(next).every(
    (k) =>
      k === "seenAt" ||
      JSON.stringify(/** @type {any} */ (next)[k]) === JSON.stringify(/** @type {any} */ (cur)[k]),
  );
  // a pin whose only change is "we looked again today" still records the
  // look, because an aisle's age is what tells a shopper whether to trust it
  if (same && cur.seenAt === todayIso) return pins;
  return {
    ...pins,
    updated: todayIso,
    pins: { ...pins.pins, [key]: { ...pins.pins[key], [store]: next } },
  };
}

/**
 * The confirm-once tap on an existing (provisional) pin.
 * @param {PinBook} pins
 * @param {string} food
 * @param {string} store
 * @param {string} todayIso
 * @returns {PinBook}
 */
export function confirmPin(pins, food, store, todayIso) {
  const key = pinKey(food);
  const cur = pins.pins[key]?.[store];
  if (!cur) return pins;
  const rest = { ...cur };
  delete rest.provisional;
  // a human just stood in front of this product, so whatever store data the
  // pin carries was true today
  if (rest.aisle) rest.seenAt = todayIso;
  return {
    ...pins,
    updated: todayIso,
    pins: {
      ...pins.pins,
      [key]: { ...pins.pins[key], [store]: { ...rest, confirmedAt: todayIso } },
    },
  };
}

/**
 * WHERE THE THING ACTUALLY IS, at this store, in the store's own words.
 *
 * The store's answer beats our taxonomy every time: `aisleOf()` in
 * ingredients.js is one hardcoded walk order applied to every shop on earth,
 * whereas this is what Kroger says about THIS location. Absent means Kroger
 * did not say, which is common enough that a caller must always have a
 * fallback rather than treat "" as an error.
 * @param {PinBook | null | undefined} pins
 * @param {string} food
 * @param {string} store
 * @returns {string} the store's aisle description, or "" when unknown
 */
export function shelfAisle(pins, food, store) {
  const a = pinFor(pins, food, store)?.aisle;
  return typeof a === "string" ? a.trim() : "";
}

/**
 * How stale a pin's store data is, in days, or null when it carries no date.
 * An aisle survives a store reset only by luck, so the age is what tells a
 * shopper whether to trust it.
 * @param {PinBook | null | undefined} pins
 * @param {string} food
 * @param {string} store
 * @param {string} todayIso
 * @returns {number | null}
 */
export function shelfAisleAgeDays(pins, food, store, todayIso) {
  const seen = pinFor(pins, food, store)?.seenAt;
  if (typeof seen !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(seen)) return null;
  const ms = Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${seen}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86400000)) : null;
}

/**
 * Aisle labels for a store's section headers, DERIVED from what the store
 * itself said about the products we have pinned there.
 *
 * `prices.json` has always supported a hand-curated `aisles: { <store>: {
 * order, labels } }` map, on the reasoning that "a store's layout is a stable
 * fact that no chain publishes". Kroger does publish it, per product, per
 * location, and Mise has been fetching it all along. This turns those pins
 * into the map nobody had to curate.
 *
 * One section spans several real aisles (produce is a wall, not an aisle), so
 * the label is the MODAL aisle among that section's pinned foods, and it is
 * only offered when it actually dominates: a section whose pins are scattered
 * across five aisles gets no label rather than a misleading one. Ties break
 * alphabetically so the same pin book always yields the same map.
 * @param {PinBook | null | undefined} pins
 * @param {string} store
 * @param {number} [minShare] fraction of a section's pins that must agree
 * @returns {Record<string, string>} section → aisle label
 */
export function aisleLabelsFromPins(pins, store, minShare = 0.5) {
  /** @type {Record<string, Record<string, number>>} */
  const tally = {};
  for (const [key, byStore] of Object.entries(pins?.pins ?? {})) {
    const aisle = typeof byStore?.[store]?.aisle === "string" ? byStore[store].aisle.trim() : "";
    if (!aisle) continue;
    const section = aisleOf(key);
    (tally[section] ??= {})[aisle] = (tally[section][aisle] ?? 0) + 1;
  }
  /** @type {Record<string, string>} */
  const labels = {};
  for (const [section, counts] of Object.entries(tally)) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best && best[1] / total >= minShare) labels[section] = best[0];
  }
  return labels;
}

/**
 * Kroger locationId for a catalogue store slug, or "" when the store has no
 * registered location (not a Kroger banner, or not set up yet).
 * @param {PinBook | null | undefined} pins
 * @param {string} store
 */
export function locationIdFor(pins, store) {
  return pins?.stores?.[store]?.locationId ?? "";
}

// ---- candidate picking (matcher v2, ported from tools/kroger_price.py) ----

/** Categories that are never groceries. */
const CAT_DENY = [
  "baby",
  "personal care",
  "beauty",
  "health",
  "household",
  "pet",
  "cleaning",
  "paper",
  "home",
  "office",
  "floral",
  "garden",
  "apparel",
  "toys",
  "electronics",
  "hardware",
  "automotive",
  "tobacco",
];

/** Product forms that are never the raw ingredient (a chocolate bar is not
 *  almond butter, ramen is not soy sauce, a muffin mix is not walnuts,
 *  Gatorade is not a cucumber), unless the term itself asks. */
const FORM_DENY = [
  "ramen",
  "noodle",
  "candy",
  "chocolate",
  "protein bar",
  "granola bar",
  "snack pack",
  "yogurt",
  "ice cream",
  "cracker",
  "chips",
  "cookie",
  "baklava",
  "cereal bar",
  "trail mix",
  "drink mix",
  "seasoning packet",
  "pizza",
  "sandwich",
  "burrito",
  "smoothie",
  "soda",
  "sports drink",
  "nectar",
  "muffin mix",
  "cake mix",
  "juice drink",
  "shaker",
  "salad kit",
  "chopped salad",
  "dip",
  "hoagie",
  "kombucha",
  "popcorn",
  "granola",
  "smoked",
  "skewer",
];

/**
 * Store sections → Kroger categories a match may live in (the section gate
 * from matcher v2: without it "cucumber" ranks a lime-cucumber sports drink,
 * because every word matched). Empty/unknown section = any non-denied food
 * category. Keys are the app's AISLES taxonomy.
 * @type {Record<string, string[]>}
 */
const CAT_OK = {
  produce: ["produce", "natural & organic", "snacks"],
  meat: ["meat", "seafood", "poultry"],
  seafood: ["meat", "seafood"],
  dairy: ["dairy", "deli", "natural & organic", "eggs"],
  bakery: ["bakery", "bread"],
  baking: ["baking goods", "natural & organic"],
  spices: ["baking goods", "condiment & sauces", "natural & organic", "international"],
  canned: ["canned & packaged", "pantry", "natural & organic", "international", "soup"],
  condiments: ["condiment & sauces", "international", "natural & organic", "pantry"],
  grains: [
    "pasta, sauces, grain",
    "breakfast",
    "baking goods",
    "natural & organic",
    "canned & packaged",
    "pantry",
  ],
  frozen: ["frozen"],
  snacks: ["snacks", "natural & organic", "candy"],
  beverages: ["beverages", "adult beverage", "natural & organic"],
};

/** Descriptor words that never disqualify a match. */
const MATCH_STOP = new Set(["fresh", "raw", "whole", "large", "small", "organic"]);

/** Marketing/prep words that do not count as description NOISE (see noiseOf). */
const NOISE_STOP = new Set([
  "kroger",
  "roundy",
  "roundys",
  "simple",
  "truth",
  "organic",
  "natural",
  "naturally",
  "fresh",
  "big",
  "deal",
  "value",
  "family",
  "size",
  "pack",
  "bag",
  "tub",
  "tray",
  "roll",
  "jar",
  "bottle",
  "box",
  "carton",
  "jug",
  "sleeve",
  "count",
  "grade",
  "large",
  "small",
  "whole",
  "premium",
  "select",
  "selection",
  "private",
  "heritage",
  "farm",
  "style",
  "original",
  "classic",
  "traditional",
  "creamy",
  "plain",
  "unsweetened",
  "unsalted",
  "salted",
  "roasted",
  "sea",
  "raw",
  "boneless",
  "skinless",
  "bone",
  "skin",
  "pitted",
  "shredded",
  "sliced",
  "halves",
  "pieces",
  "chunk",
  "wild",
  "caught",
  "farmed",
  "raised",
  "sustainably",
  "sourced",
  "pure",
  "extra",
  "thick",
  "grain",
  "long",
  "peeled",
  "deveined",
  "service",
  "counter",
  "cage",
  "free",
  "stir",
]);

/** @param {string} s */
const flat = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/**
 * How many description words are neither the searched food, its brand, nor
 * routine packaging/marketing language. "Halves & Pieces Walnuts" scores 0
 * for walnuts; "Blueberry & Walnut Salad" scores 2 — the number of words
 * that say this is really a DIFFERENT product wearing the ingredient's name.
 * @param {KrogerProduct} p
 * @param {string[]} needFlat the food's meaningful words, flattened
 * @returns {number}
 */
function noiseOf(p, needFlat) {
  const brandW = new Set(
    String(p.brand ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  let n = 0;
  for (const w of String(p.description ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    const fw = flat(w);
    if (fw.length < 3) continue;
    if (brandW.has(w) || NOISE_STOP.has(w)) continue;
    if (needFlat.some((t) => t.includes(fw) || fw.includes(t))) continue;
    n += 1;
  }
  return n;
}

/**
 * Filter + rank live search results for one ingredient: drop non-food
 * categories, categories outside the row's own store section, wrong forms,
 * red-listed brands, out-of-stock and unpriced rows; require every
 * meaningful word of the food to appear (space-insensitive, so "corn starch"
 * matches "cornstarch"); rank by unit price, cheapest first. Returns
 * candidates decorated with `unitPrice`/`unitLabel` for display.
 * @param {KrogerProduct[]} products
 * @param {string} food
 * @param {string[]} [redList] brand names never auto-picked (P5's red list)
 * @param {string} [section] the list row's store section (AISLES taxonomy);
 *   SOFT-gates candidate categories: in-section candidates win outright, but
 *   when none exist the off-section survivors return rather than an empty
 *   list (store category taxonomies differ per banner, and a hard gate
 *   silently unpriced 40 real foods at one store while passing them at
 *   another, seed run 2026-08-19)
 * @param {{ qty: number, unit: string } | null} [need] the row's actual
 *   quantity. When known, candidates rank by COST TO COVER THE NEED
 *   (fix list 3.6, matcher v2 rule 5): a 3 lb tray always beats a 1 lb tray
 *   per pound, which is exactly wrong for a 450 g need. Unit price stays the
 *   tiebreak and the no-need fallback.
 * @returns {(KrogerProduct & { unitPrice: number | null, unitLabel: string, noise: number, spend: number | null })[]}
 */
export function rankCandidates(products, food, redList = [], section = "", need = null) {
  const term = String(food ?? "")
    .replace(/\s*\([^)]*\)/g, "")
    .trim();
  const words = term
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !MATCH_STOP.has(w));
  const needFlat = words.map(flat);
  const termFlat = flat(term);
  const red = redList.map((b) => b.toLowerCase());
  const allowed = CAT_OK[section] ?? [];
  // protein powders live in the store's Health aisle, which is otherwise
  // (correctly) a denied category — a whey search must be allowed to enter it
  const denyCats =
    termFlat.includes("protein") || termFlat.includes("whey")
      ? CAT_DENY.filter((c) => c !== "health")
      : CAT_DENY;
  /** @type {(KrogerProduct & { unitPrice: number | null, unitLabel: string, noise: number, spend: number | null })[]} */
  const inCat = [];
  /** @type {typeof inCat} */
  const offCat = [];
  for (const p of products) {
    const d = flat(p.description);
    const cats = (p.categories ?? []).map((c) => c.toLowerCase());
    if (cats.some((c) => denyCats.some((deny) => c.includes(deny)))) continue;
    if (FORM_DENY.some((f) => d.includes(flat(f)) && !termFlat.includes(flat(f)))) continue;
    if (p.price.regular == null) continue;
    if (p.stock === "TEMPORARILY_OUT_OF_STOCK") continue;
    if (red.some((b) => b && (p.brand ?? "").toLowerCase().includes(b))) continue;
    if (!words.every((w) => d.includes(flat(w)))) continue;
    const { unitPrice, unitLabel } = unitPriceOf(p);
    const cand = {
      ...p,
      unitPrice,
      unitLabel,
      noise: noiseOf(p, needFlat),
      spend: need ? coverSpend(p, food, need.qty, need.unit) : null,
    };
    const fits =
      allowed.length === 0 ||
      (cats.length > 0 && cats.some((c) => allowed.some((ok) => c.includes(ok))));
    (fits ? inCat : offCat).push(cand);
  }
  // cleanest description first (a product whose name is mostly the food);
  // then cost-to-cover-the-need when the need is known (3.6), unit price as
  // the tiebreak and the no-need fallback — never shelf price
  const rank = (/** @type {typeof inCat} */ arr) =>
    arr.sort(
      (a, b) =>
        a.noise - b.noise ||
        (need ? (a.spend ?? Infinity) - (b.spend ?? Infinity) : 0) ||
        (a.unitPrice ?? Infinity) - (b.unitPrice ?? Infinity),
    );
  return inCat.length > 0 ? rank(inCat) : rank(offCat);
}

/**
 * What covering the row's actual quantity costs with this product: whole
 * packages (never fractions), or pay-what-it-weighs for WEIGHT-sold items.
 * Null when the need cannot be expressed in the product's terms — the caller
 * falls back to unit price.
 * @param {KrogerProduct} p
 * @param {string} food
 * @param {number} qty
 * @param {string} unit
 * @returns {number | null}
 */
function coverSpend(p, food, qty, unit) {
  // the EFFECTIVE price ranks the pick: a promo is the card price David
  // actually pays (he scans his rewards number), so a sale item legitimately
  // wins the cover-the-need comparison while the sale lasts
  const reg =
    p.price.promo != null && p.price.promo > 0 && p.price.regular != null
      ? Math.min(p.price.promo, p.price.regular)
      : p.price.regular;
  if (reg == null || !(qty > 0)) return null;
  const u = canonicalUnit(unit);
  const key = pinKey(food);
  if (p.soldBy === "WEIGHT") {
    const g = toGrams(qty, u, key);
    const lbs = g != null ? g / 453.59237 : u === "lb" ? qty : null;
    // a service counter rarely sells under a quarter pound
    return lbs != null ? Math.round(reg * Math.max(lbs, 0.25) * 100) / 100 : null;
  }
  const pack = parsePackSize(p.size);
  if (!pack || !(pack.qty > 0)) return null;
  let inPack = convertUnit(qty, u, pack.unit);
  if (inPack == null) {
    const needG = toGrams(qty, u, key);
    const packG = toGrams(pack.qty, pack.unit, key);
    if (needG != null && packG != null && packG > 0) inPack = (needG / packG) * pack.qty;
  }
  if (inPack == null) return null;
  return Math.round(reg * Math.max(1, Math.ceil(inPack / pack.qty)) * 100) / 100;
}

/**
 * A comparable unit price for ranking and display. Weight-sold items are
 * already per-lb; packaged items derive from the size string. Sorting on
 * unit price, never shelf price, is a P5 pricing rule.
 * @param {KrogerProduct} p
 * @returns {{ unitPrice: number | null, unitLabel: string }}
 */
export function unitPriceOf(p) {
  // effective (promo-aware) price, matching coverSpend: without it a sale
  // item ranked and displayed at its regular price while the covers-yours
  // figure used the promo — two prices for one product in one line
  // (reviewer catch 2026-08-19)
  const reg =
    p.price.promo != null && p.price.promo > 0 && p.price.regular != null
      ? Math.min(p.price.promo, p.price.regular)
      : p.price.regular;
  if (reg == null) return { unitPrice: null, unitLabel: "" };
  if (p.soldBy === "WEIGHT") {
    return { unitPrice: reg / 16, unitLabel: `$${reg.toFixed(2)}/lb` };
  }
  const pack = parsePackSize(p.size);
  if (!pack) return { unitPrice: null, unitLabel: "" };
  const OZ = /** @type {Record<string, number>} */ ({
    oz: 1,
    "fl oz": 1,
    lb: 16,
    kg: 35.274,
    g: 1 / 28.35,
    ml: 1 / 29.57,
    l: 33.814,
  });
  const factor = OZ[pack.unit];
  if (factor && pack.qty > 0) {
    const per = reg / (pack.qty * factor);
    return { unitPrice: per, unitLabel: `$${per.toFixed(2)}/oz` };
  }
  if (pack.qty > 0) {
    const per = reg / pack.qty;
    return { unitPrice: per, unitLabel: `$${per.toFixed(2)} each` };
  }
  return { unitPrice: null, unitLabel: "" };
}

// ---- price write-through (fix list 3.5) -----------------------------------

/**
 * Write one live product price into the catalogue for one store: per-item,
 * timestamped (`at`), estimate flag cleared — a live API price is a real
 * shelf price. The row is found by ledger key first (a row whose id IS the
 * pin key), then by the fuzzy matcher, and is created when absent, so a
 * newly pinned ingredient always gains a catalogue home.
 * Weight-sold products store as "per lb" so `itemCost` prices what the row
 * weighs.
 * @param {import("./prices.js").PriceCatalogue} catalogue
 * @param {string} store
 * @param {string} food the list row's name (its `canonicalFood` is the key)
 * @param {KrogerProduct} product
 * @param {string} todayIso
 * @returns {import("./prices.js").PriceCatalogue}
 */
export function applyLivePrice(catalogue, store, food, product, todayIso) {
  if (product.price.regular == null) return catalogue;
  const key = pinKey(food);
  const items = (catalogue.items ?? []).map((i) => ({ ...i, prices: { ...i.prices } }));
  let row = items.find((i) => i.id === key) ?? matchPrice(food, items);
  if (!row) {
    row = { id: key, name: String(food).toLowerCase(), prices: {} };
    items.push(row);
  }
  const perLb = product.soldBy === "WEIGHT";
  // SALES ARE REAL PRICES (David 2026-08-19: "can you find sales?"): the
  // API's promo field is the card/sale price at this location, and David
  // scans his rewards number at the till, so when a promo undercuts the
  // regular price the promo IS what he pays. The regular price rides along
  // so the row can say it's a sale and the refresh can see it end.
  const regular = Math.round(product.price.regular * 100) / 100;
  // compare AFTER rounding both, or a 3.997 promo against a 3.995→4.00
  // regular flags a "sale" of identical prices (reviewer nit 2026-08-19)
  const promoRounded =
    product.price.promo != null && product.price.promo > 0
      ? Math.round(product.price.promo * 100) / 100
      : null;
  const promo = promoRounded != null && promoRounded < regular ? promoRounded : null;
  row.prices[store] = {
    price: promo ?? regular,
    ...(promo != null ? { regular, sale: true } : {}),
    size: perLb ? "per lb" : product.size,
    at: todayIso,
  };
  const stores = catalogue.stores ?? [];
  return {
    ...catalogue,
    updated: todayIso,
    ...(stores.includes(store) ? {} : { stores: [...stores, store] }),
    items,
  };
}

/**
 * Days since this store price was written, or null when it predates
 * timestamps (rows from before 2026-08-19 carry no `at`).
 * @param {{ at?: string } | undefined} sp
 * @param {string} todayIso
 * @returns {number | null}
 */
export function priceAgeDays(sp, todayIso) {
  if (!sp?.at) return null;
  const ms = Date.parse(todayIso) - Date.parse(sp.at);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86400000)) : null;
}

/**
 * Visibly stale (fix list 3.5): a timestamped price older than
 * STALE_PRICE_DAYS. Un-timestamped rows are governed by the estimate flag
 * instead — calling them stale would mark the whole legacy catalogue.
 * @param {{ at?: string } | undefined} sp
 * @param {string} todayIso
 */
export function isStalePrice(sp, todayIso) {
  const age = priceAgeDays(sp, todayIso);
  return age != null && age > STALE_PRICE_DAYS;
}

// ---- substitution classes (fix list 3.4) ----------------------------------

/**
 * Gate on swap CLASS, not dollar amount (David, 2026-08-18): a swap that
 * keeps the ingredient's identity (fresh to frozen, brand to brand, pack to
 * pack) is a FORM swap and may auto-apply at any value. A swap that changes
 * what the dish is (salmon to tilapia, butter to oil) is a DISH swap and must
 * ask. Identity is the ledger key: same `canonicalFood`, same food.
 * @param {string} originalFood
 * @param {string} candidateFood
 * @returns {"form" | "dish"}
 */
export function swapClassFor(originalFood, candidateFood) {
  return pinKey(originalFood) === pinKey(candidateFood) ? "form" : "dish";
}

/**
 * Allergen screen on the OUTPUT (fix list 3.4): the product actually being
 * offered, never just the search term. Substring on the flattened
 * description + categories per avoid term, so "peanut" catches "Peanut
 * Butter Cups" wherever the term appears. Case- and space-insensitive.
 * @param {KrogerProduct} product
 * @param {string[]} avoid the profile's allergens/hard avoids
 * @returns {string[]} the avoid terms this product hits
 */
export function allergenHits(product, avoid) {
  const hay = flat(`${product.description} ${(product.categories ?? []).join(" ")}`);
  return (avoid ?? []).map((a) => String(a ?? "").trim()).filter((a) => a && hay.includes(flat(a)));
}

/**
 * WHERE TO WALK, in the words a person standing in the store would use.
 *
 * David, 2026-08-24: "I was just at Pay Less the other day and it would be
 * nice if I could have navigated that better." The pin's `aisle` is a
 * merchandising label; the aisle NUMBER and SIDE are what get you there.
 *
 * Kroger populates these unevenly -- a big Mariano's returns far more than an
 * independent banner like Pay Less -- so this degrades in steps rather than
 * all-or-nothing: number+side if both are known, number alone, else the
 * merchandising label, else "".
 *
 * @param {PinBook | null | undefined} pins
 * @param {string} food
 * @param {string} store
 * @returns {string} e.g. "aisle 12, right side" — "" when the store said nothing
 */
export function shelfDirections(pins, food, store) {
  const pin = pinFor(pins, food, store);
  const sh = pin?.shelf ?? {};
  const num = String(sh.number ?? "").trim();
  const side = String(sh.side ?? "")
    .trim()
    .toLowerCase();
  if (num) {
    const sideWord = side === "l" ? "left side" : side === "r" ? "right side" : side;
    const bay = String(sh.bay ?? "").trim();
    return [`aisle ${num}`, sideWord, bay ? `bay ${bay}` : ""].filter(Boolean).join(", ");
  }
  return shelfAisle(pins, food, store);
}
