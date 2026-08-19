// Kroger pricing loop, pure logic (fix list Tier 3, promises P4 + P5).
// The flow (Mise-Store-Pricing): resolution is learn-once. An ingredient is
// searched at a store at most once, ever: the shopper confirms a product and
// that pin (ingredient key -> UPC per store) prices the row forever after,
// refreshed by UPC. The pin's key is `canonicalFood`, and it is the ledger's
// PRIMARY KEY (PF.3): pantry rows, list rows, catalogue rows and pins all
// meet on this one key instead of per-render fuzzy matching.
// Network lives in lib/worker.js (krogerSearch/krogerPricesById); this module
// never fetches.

import { canonicalFood, canonicalUnit, convertUnit, toGrams } from "./ingredients.js";
import { matchPrice, parsePackSize } from "./prices.js";

/** @typedef {{ upc: string, description: string, brand: string, categories: string[], size: string, soldBy: string, price: { regular: number | null, promo: number | null }, stock: string, aisle: string }} KrogerProduct */
/** @typedef {{ upc: string, description: string, size: string, soldBy: string, confirmedAt?: string, provisional?: boolean }} Pin */
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
    ...(confirmed ? { confirmedAt: todayIso } : { provisional: true }),
  };
  return {
    ...pins,
    updated: todayIso,
    pins: { ...pins.pins, [key]: { ...(pins.pins[key] ?? {}), [store]: pin } },
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
  "baby", "personal care", "beauty", "health", "household", "pet", "cleaning",
  "paper", "home", "office", "floral", "garden", "apparel", "toys",
  "electronics", "hardware", "automotive", "tobacco",
];

/** Product forms that are never the raw ingredient (a chocolate bar is not
 *  almond butter, ramen is not soy sauce, a muffin mix is not walnuts,
 *  Gatorade is not a cucumber), unless the term itself asks. */
const FORM_DENY = [
  "ramen", "noodle", "candy", "chocolate", "protein bar", "granola bar",
  "snack pack", "yogurt", "ice cream", "cracker", "chips", "cookie", "baklava",
  "cereal bar", "trail mix", "drink mix", "seasoning packet", "pizza",
  "sandwich", "burrito", "smoothie", "soda", "sports drink", "nectar",
  "muffin mix", "cake mix", "juice drink", "shaker", "salad kit",
  "chopped salad", "dip", "hoagie", "kombucha", "popcorn", "granola",
  "smoked", "skewer",
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
  grains: ["pasta, sauces, grain", "breakfast", "baking goods", "natural & organic", "canned & packaged", "pantry"],
  frozen: ["frozen"],
  snacks: ["snacks", "natural & organic", "candy"],
  beverages: ["beverages", "adult beverage", "natural & organic"],
};

/** Descriptor words that never disqualify a match. */
const MATCH_STOP = new Set(["fresh", "raw", "whole", "large", "small", "organic"]);

/** Marketing/prep words that do not count as description NOISE (see noiseOf). */
const NOISE_STOP = new Set([
  "kroger", "roundy", "roundys", "simple", "truth", "organic", "natural",
  "naturally", "fresh", "big", "deal", "value", "family", "size", "pack",
  "bag", "tub", "tray", "roll", "jar", "bottle", "box", "carton", "jug",
  "sleeve", "count", "grade", "large", "small", "whole",
  "premium", "select", "selection", "private", "heritage", "farm", "style",
  "original", "classic", "traditional", "creamy", "plain", "unsweetened",
  "unsalted", "salted", "roasted", "sea", "raw", "boneless", "skinless",
  "bone", "skin", "pitted", "shredded", "sliced", "halves", "pieces",
  "chunk", "wild", "caught", "farmed", "raised", "sustainably", "sourced",
  "pure", "extra", "thick", "grain", "long", "peeled", "deveined",
  "service", "counter", "cage", "free", "stir",
]);

/** @param {string} s */
const flat = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

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
    String(p.brand ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  );
  let n = 0;
  for (const w of String(p.description ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
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
  const term = String(food ?? "").replace(/\s*\([^)]*\)/g, "").trim();
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
  const reg = p.price.regular;
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
  const reg = p.price.regular;
  if (reg == null) return { unitPrice: null, unitLabel: "" };
  if (p.soldBy === "WEIGHT") {
    return { unitPrice: reg / 16, unitLabel: `$${reg.toFixed(2)}/lb` };
  }
  const pack = parsePackSize(p.size);
  if (!pack) return { unitPrice: null, unitLabel: "" };
  const OZ = /** @type {Record<string, number>} */ ({
    oz: 1, "fl oz": 1, lb: 16, kg: 35.274, g: 1 / 28.35, ml: 1 / 29.57, l: 33.814,
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
  row.prices[store] = {
    price: Math.round(product.price.regular * 100) / 100,
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
  return (avoid ?? [])
    .map((a) => String(a ?? "").trim())
    .filter((a) => a && hay.includes(flat(a)));
}
