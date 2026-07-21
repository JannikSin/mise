// Store price estimates for the shopping list: match list items against the
// shared prices.json catalogue (data-repo root), per-store trip totals, and
// grocery sales tax by US state. All display-only — never blocks shopping.

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

/** @param {string} s */
function words(s) {
  return new Set(
    s
      .toLowerCase()
      .replace(/\(.*?\)/g, " ") // "(15 oz can)" is packaging, not identity
      .split(/[^a-z]+/)
      .filter((w) => w && !STOP_WORDS.has(w)),
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
 * Estimated shelf cost of one list row at one store. Null when the catalogue
 * has no entry for the item or the store doesn't stock it.
 * @param {{ food: string, qty: number, unit: string }} item
 * @param {PriceCatalogue | null | undefined} catalogue
 * @param {string} store store slug, e.g. "trader-joes"
 * @returns {{ cost: number, estimate: boolean, size?: string } | null}
 */
export function itemCost(item, catalogue, store) {
  const entry = catalogue?.items ? matchPrice(item.food, catalogue.items) : null;
  const sp = entry?.prices?.[store];
  if (!sp) return null;
  const perLb = (sp.size ?? "").toLowerCase().includes("per lb");
  const u = item.unit.toLowerCase();
  const mult = COUNTED.has(u) ? item.qty : perLb && (u === "lb" || u === "lbs") ? item.qty : 1;
  return {
    cost: Math.round(sp.price * mult * 100) / 100,
    estimate: sp.estimate === true,
    size: sp.size,
  };
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
 * a CONFIRMED price (estimate flag cleared), or is skipped if it matches
 * nothing (we never invent catalogue rows from a receipt — a receipt names
 * "ORG BLK BEAN" that we cannot safely map, so confirmed-only-on-match keeps
 * the catalogue clean). Returns a new catalogue plus a per-line report.
 * @param {PriceCatalogue} catalogue
 * @param {string} store slug
 * @param {{ name: string, price: number, size?: string }[]} lines
 * @param {string} updatedIso today, for catalogue.updated
 * @returns {{ catalogue: PriceCatalogue, applied: { name: string, matchedId: string, price: number }[], unmatched: { name: string, price: number }[] }}
 */
export function applyReceipt(catalogue, store, lines, updatedIso) {
  const items = (catalogue.items ?? []).map((i) => ({ ...i, prices: { ...i.prices } }));
  const applied = [];
  const unmatched = [];
  for (const line of lines) {
    const match = matchPrice(line.name, items);
    if (!match) {
      unmatched.push({ name: line.name, price: line.price });
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
    unmatched,
  };
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
