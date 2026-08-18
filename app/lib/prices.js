// Store price estimates for the shopping list: match list items against the
// shared prices.json catalogue (data-repo root), per-store trip totals, and
// grocery sales tax by US state. All display-only — never blocks shopping.

import { canonicalFood, canonicalUnit, convertUnit, dimensionOf, toGrams } from "./ingredients.js";

/** @typedef {{ price: number, size?: string, estimate?: boolean }} StorePrice */
/** @typedef {{ id: string, name: string, prices: Record<string, StorePrice> }} PriceItem */
/** @typedef {{ updated?: string, region?: string, stores?: string[], items: PriceItem[] }} PriceCatalogue */

/**
 * Grocery (food-at-home) sales tax rate by US state. Most states exempt
 * groceries entirely — absent = 0. IL's statewide 1% died 2026-01-01 but
 * many Chicagoland municipalities re-levied their own 1%, so IL carries the
 * conservative 1%. Non-USA country: rate 0 until someone abroad needs it.
 * @type {Record<string, number>}
 */
export const GROCERY_TAX_RATE = {
  IL: 0.01,
  MO: 0.01225,
  VA: 0.01,
  UT: 0.03,
  HI: 0.04,
  ID: 0.06,
  KS: 0.0,
  OK: 0.045,
  AL: 0.03,
  MS: 0.05,
  SD: 0.042,
  TN: 0.04,
  AR: 0.00125,
};

/**
 * Grocery tax rate for a profile's region (targets.region, absent = 0).
 * @param {{ country?: string, state?: string } | undefined} region
 * @returns {number}
 */
export function taxRateFor(region) {
  if (!region || (region.country && region.country !== "USA")) return 0;
  return GROCERY_TAX_RATE[region.state ?? ""] ?? 0;
}

/** Meaningless filler words ignored when matching item names to the catalogue. */
const STOP_WORDS = new Set(["a", "an", "the", "of", "no", "added", "with", "per"]);

/**
 * Cheap plural stem so "banana" finds catalogue "bananas" (and vice versa).
 * Only a trailing s, only on words long enough to survive it, and never on
 * -ss/-us/-is endings (hummus, couscous, swiss) where the s is not a plural.
 * @param {string} w
 */
const stem = (w) => (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);

/** @param {string} s */
function words(s) {
  return new Set(
    s
      .toLowerCase()
      .replace(/\(.*?\)/g, " ") // "(15 oz can)" is packaging, not identity
      .split(/[^a-z]+/)
      .filter((w) => w && !STOP_WORDS.has(w))
      .map(stem),
  );
}

/**
 * Best catalogue entry for a shopping-list food name: score = fraction of the
 * catalogue entry's words present in the item's words, threshold 0.6 so
 * "fine salt" never matches "no salt added peanut butter". Null when nothing
 * clears the bar.
 * @param {string} food
 * @param {PriceItem[]} items
 * @returns {PriceItem | null}
 */
export function matchPrice(food, items) {
  const itemWords = words(food);
  const overlap = (/** @type {Set<string>} */ candidate) => {
    if (!candidate.size) return 0;
    let hit = 0;
    for (const w of candidate) if (itemWords.has(w)) hit += 1;
    return hit / candidate.size;
  };
  let best = null;
  let bestScore = 0;
  for (const p of items) {
    // the id is a second chance for synonym-carrying slugs ("olive-oil-evoo")
    const score = Math.max(overlap(words(p.name)), overlap(words(p.id.replace(/-/g, " "))));
    if (score >= 0.6 && score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

/** Units bought as N discrete priced things (price × qty). Everything else prices × qty only when the catalogue is per-lb. */
const COUNTED = new Set(["each", "can", "cans", "eggs", "egg", "head", "heads"]);

/**
 * Package quantity encoded in a catalogue size string, in a canonical unit,
 * or null when the string carries none ("per lb" is the per-lb path, not a
 * package). Understands the shapes the live catalogue actually uses:
 * "32 oz", "2 lb bag", "1 L", "2 x 28 oz", "5.35 lb @ 0.69/lb", "dozen",
 * "24 ct cage-free", "sleeve of ~5 heads", "each", "head", "2 @ 0.79".
 * @param {string | undefined} size
 * @returns {{ qty: number, unit: string } | null}
 */
export function parsePackSize(size) {
  const s = String(size ?? "").toLowerCase();
  if (!s || s.includes("per lb")) return null;
  if (s.includes("dozen")) return { qty: 12, unit: "each" };
  const multi = s.match(/^(\d+)\s*[x@]\s/); // "2 x 28 oz", "2 @ 0.79"
  const mult = multi ? Number(multi[1]) : 1;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(fl oz|oz|lbs?|kg|g|ml|l)\b/);
  if (m) return { qty: mult * Number(m[1]), unit: m[2] === "lbs" ? "lb" : String(m[2]) };
  const ct = s.match(/(\d+)\s*ct\b/);
  if (ct) return { qty: mult * Number(ct[1]), unit: "each" };
  const heads = s.match(/~?\s*(\d+)\s*heads?\b/); // "sleeve of ~5 heads"
  if (heads) return { qty: Number(heads[1]), unit: "each" };
  if (multi) return { qty: mult, unit: "each" }; // "2 @ 0.79"
  if (/\b(each|head|jumbo)\b/.test(s)) return { qty: 1, unit: "each" };
  return null;
}

/**
 * Estimated shelf cost of one list row at one store. Null when the catalogue
 * has no entry for the item or the store doesn't stock it.
 *
 * Charges whole PACKAGES: a 2.3 kg tofu need against a 14 oz block is six
 * blocks, not one (the pre-2026-08-18 behavior charged one package for any
 * non-counted, non-per-lb unit, which is how a $170 basket read $16.72).
 * When the need cannot be converted into the package's unit the row falls
 * back to one package and is flagged `estimate`, never silently precise.
 * @param {{ food: string, qty: number, unit: string }} item
 * @param {PriceCatalogue | null | undefined} catalogue
 * @param {string} store store slug, e.g. "trader-joes"
 * @returns {{ cost: number, estimate: boolean, size?: string, packs?: number } | null}
 */
export function itemCost(item, catalogue, store) {
  const entry = catalogue?.items ? matchPrice(item.food, catalogue.items) : null;
  const sp = entry?.prices?.[store];
  if (!sp) return null;
  const round = (/** @type {number} */ n) => Math.round(n * 100) / 100;
  const u = canonicalUnit(item.unit);
  const pack = parsePackSize(sp.size);

  // counted rows: each counted thing is one priced thing, unless the size
  // says the priced thing is a multi-count package ("dozen", "24 ct") or a
  // weighed bundle ("5.35 lb @ 0.69/lb": 13 bananas are one bundle, not 13)
  if (COUNTED.has(item.unit.toLowerCase()) || dimensionOf(u) === "count") {
    if (pack && dimensionOf(pack.unit) !== "count") {
      const key = canonicalFood(item.food);
      const needG = toGrams(item.qty, u, key);
      const packG = toGrams(pack.qty, pack.unit, key);
      if (needG != null && packG != null && packG > 0) {
        const packs = Math.max(1, Math.ceil(needG / packG));
        return {
          cost: round(sp.price * packs),
          estimate: sp.estimate === true,
          size: sp.size,
          packs,
        };
      }
    }
    const per = pack && dimensionOf(pack.unit) === "count" && pack.qty > 0 ? pack.qty : 1;
    const packs = Math.max(1, Math.ceil(item.qty / per));
    return { cost: round(sp.price * packs), estimate: sp.estimate === true, size: sp.size, packs };
  }

  // per-lb rows: pay what it weighs, whatever unit the row is written in
  if ((sp.size ?? "").toLowerCase().includes("per lb")) {
    const lbs =
      u === "lb" ? item.qty : (convertUnit(item.qty, u, "lb") ?? gramsFor(item) / 453.59237);
    if (Number.isFinite(lbs) && lbs > 0) {
      return { cost: round(sp.price * lbs), estimate: sp.estimate === true, size: sp.size };
    }
    return { cost: round(sp.price), estimate: true, size: sp.size };
  }

  // packaged rows: how many packages cover the need
  if (pack) {
    let packs = null;
    const inPackUnit = convertUnit(item.qty, u, pack.unit);
    if (inPackUnit != null) {
      packs = Math.max(1, Math.ceil(inPackUnit / pack.qty));
    } else {
      // cross-dimension (cups of spinach vs an oz bag) via the food's weight
      const key = canonicalFood(item.food);
      const needG = toGrams(item.qty, u, key);
      const packG = toGrams(pack.qty, pack.unit, key);
      if (needG != null && packG != null && packG > 0) {
        packs = Math.max(1, Math.ceil(needG / packG));
      }
    }
    if (packs != null) {
      return { cost: round(sp.price * packs), estimate: sp.estimate === true, size: sp.size, packs };
    }
  }

  // unknowable: one package, flagged as an estimate instead of silently exact
  return { cost: round(sp.price), estimate: true, size: sp.size };
}

/** @param {{ food: string, qty: number, unit: string }} item */
function gramsFor(item) {
  return toGrams(item.qty, item.unit, canonicalFood(item.food)) ?? NaN;
}

/**
 * Trip summary for one store: subtotal over priced items, grocery tax from
 * the profile's region, and how many rows the catalogue could not price
 * (unpriced rows cost SOMETHING — the total is a floor, never a promise).
 * @param {{ food: string, qty: number, unit: string, checked?: boolean }[]} items
 * @param {PriceCatalogue | null | undefined} catalogue
 * @param {string} store
 * @param {{ country?: string, state?: string } | undefined} region
 * @returns {{ subtotal: number, tax: number, total: number, priced: number, unpriced: number, estimates: number }}
 */
export function tripTotal(items, catalogue, store, region) {
  let subtotal = 0;
  let priced = 0;
  let estimates = 0;
  for (const item of items) {
    const c = itemCost(item, catalogue, store);
    if (!c) continue;
    subtotal += c.cost;
    priced += 1;
    if (c.estimate) estimates += 1;
  }
  subtotal = Math.round(subtotal * 100) / 100;
  const tax = Math.round(subtotal * taxRateFor(region) * 100) / 100;
  return {
    subtotal,
    tax,
    total: Math.round((subtotal + tax) * 100) / 100,
    priced,
    unpriced: items.length - priced,
    estimates,
  };
}

/** Receipt store-name text → catalogue store slug. */
const STORE_ALIASES = /** @type {Record<string, string>} */ ({
  "trader joe": "trader-joes",
  "trader joe's": "trader-joes",
  mariano: "marianos",
  "mariano's": "marianos",
  jewel: "jewel-osco",
  "jewel-osco": "jewel-osco",
  "jewel osco": "jewel-osco",
  costco: "costco",
});

/**
 * Best catalogue store slug for a receipt's printed store name (substring
 * match on the alias table). Null when nothing recognizable, so the caller
 * can ask the user which store it was.
 * @param {string} storeText
 * @param {string[]} knownStores catalogue.stores
 * @returns {string | null}
 */
export function storeSlugFromReceipt(storeText, knownStores) {
  const t = (storeText ?? "").toLowerCase();
  for (const [alias, slug] of Object.entries(STORE_ALIASES)) {
    if (t.includes(alias) && knownStores.includes(slug)) return slug;
  }
  return null;
}

/**
 * Merge a reviewed receipt into the catalogue: for one store, each receipt
 * line either updates an existing item's price (matched by word overlap) as
 * a CONFIRMED price (estimate flag cleared), or is ADDED as a new catalogue
 * row.
 *
 * Adding used to be refused, on the reasoning that a till prints "ORG BLK
 * BEAN" and we cannot safely map it. That reasoning was already obsolete:
 * `decodeReceiptLine` expands till shorthand and resolves what is left
 * against the week's list BEFORE these lines arrive, and the user reviews,
 * edits and ticks every line in the approve sheet. So the names reaching
 * here are human-confirmed food names, not raw till text.
 *
 * The cost of refusing was severe and silent. The catalogue held 24 items
 * against weekly receipts of 30 to 50 lines, so the overwhelming majority of
 * every scan was read, priced and discarded, and nothing ever said so. That
 * is why David scanned receipts for weeks and saw no improvement, and why a
 * week for four once priced at sixteen dollars: `tripTotal` was summing the
 * handful of rows it knew and not labelling its coverage.
 *
 * A row is only added when the name looks like a food rather than till junk
 * (letters, at least three characters, not a pure number or a tender line).
 * @param {PriceCatalogue} catalogue
 * @param {string} store slug
 * @param {{ name: string, price: number, size?: string }[]} lines
 * @param {string} updatedIso today, for catalogue.updated
 * @returns {{ catalogue: PriceCatalogue, applied: { name: string, matchedId: string, price: number }[], added: { name: string, id: string, price: number }[], unmatched: { name: string, price: number }[] }}
 */
export function applyReceipt(catalogue, store, lines, updatedIso) {
  const items = (catalogue.items ?? []).map((i) => ({ ...i, prices: { ...i.prices } }));
  const applied = [];
  const added = [];
  const unmatched = [];
  const taken = new Set(items.map((i) => i.id));
  for (const line of lines) {
    const match = matchPrice(line.name, items);
    if (!match) {
      // not in the catalogue yet: learn it, unless the name is till junk
      const clean = String(line.name ?? "").trim();
      if (!isFoodName(clean)) {
        unmatched.push({ name: line.name, price: line.price });
        continue;
      }
      let id = slugId(clean);
      while (taken.has(id)) id = `${id}-2`;
      taken.add(id);
      const row = {
        id,
        name: clean.toLowerCase(),
        prices: {
          [store]: {
            price: Math.round(line.price * 100) / 100,
            ...(line.size ? { size: line.size } : {}),
          },
        },
      };
      items.push(row);
      added.push({ name: clean, id, price: line.price });
      continue;
    }
    match.prices[store] = {
      price: Math.round(line.price * 100) / 100,
      ...(line.size
        ? { size: line.size }
        : match.prices[store]?.size
          ? { size: match.prices[store].size }
          : {}),
      // a real receipt is the confirmed price: drop the estimate flag
    };
    applied.push({ name: line.name, matchedId: match.id, price: line.price });
  }
  return {
    catalogue: { ...catalogue, items, ...(updatedIso ? { updated: updatedIso } : {}) },
    applied,
    added,
    unmatched,
  };
}

/** Words a till prints that are never food. */
const TILL_JUNK = new Set([
  "subtotal", "total", "tax", "change", "cash", "debit", "credit", "visa",
  "mastercard", "balance", "savings", "tender", "amex", "discover", "cashback",
]);

/**
 * Till junk vs a food name we are willing to learn.
 * @param {unknown} s
 * @returns {boolean}
 */
function isFoodName(s) {
  const t = String(s ?? "").trim();
  if (t.length < 3) return false;
  if (!/[a-z]/i.test(t)) return false;
  const first = t.toLowerCase().split(/[^a-z]+/).filter(Boolean)[0] || "";
  if (TILL_JUNK.has(first)) return false;
  return true;
}

/**
 * Stable catalogue id from a food name.
 * @param {string} s
 * @returns {string}
 */
function slugId(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Which catalogue store runs this list cheapest, honestly: only stores that
 * price at least as many rows as the best-covered store are compared (a
 * store missing half the basket always "wins" otherwise). Returns the
 * ranked list, best first.
 * @param {{ food: string, qty: number, unit: string }[]} items
 * @param {PriceCatalogue | null | undefined} catalogue
 * @param {{ country?: string, state?: string } | undefined} region
 * @returns {{ store: string, summary: ReturnType<typeof tripTotal> }[]}
 */
export function rankStores(items, catalogue, region) {
  const stores = catalogue?.stores ?? [];
  const ranked = stores.map((store) => ({
    store,
    summary: tripTotal(items, catalogue, store, region),
  }));
  const maxPriced = Math.max(0, ...ranked.map((r) => r.summary.priced));
  return ranked
    .filter((r) => r.summary.priced >= maxPriced)
    .sort((a, b) => a.summary.total - b.summary.total);
}
