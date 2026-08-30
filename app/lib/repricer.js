// The build-time repricer (P4/P5): BUILD prices its own list, honestly and
// within quota, instead of leaving 79 rows for a human to tap "$?" through.
// Runs AFTER the list is built and saved, never awaited by the build itself:
// a dead network prices nothing and breaks nothing. This is the ONLY
// automatic pricing path — the plan generator and the OUT re-derive call
// deriveShoppingList without repricing, deliberately, so quota is only ever
// spent on a list the user asked to BUILD.
//
// Quota discipline (RATE_MAX is 30 units per 10 minutes, /kroger/byId weighs
// 2 units per call): at most BYID_MAX_CHUNKS byId calls (3 x 2 = 6 units)
// plus SEARCH_BUDGET searches (12 units) = 18 of 30, leaving room for the
// human's own taps in the same window. Two BUILDs inside one window can
// still reach the cap; the second run then reports "live pricing
// unreachable" and the list stays built. Never widen these constants
// without re-doing that arithmetic against the worker's allowRequest
// weights.
//
// The negative cache (`pins.misses`): a search whose PRODUCTS came back
// empty records food -> store -> date, and that food is not searched again
// at that store for MISS_EXPIRY_DAYS — Kroger's catalogue does not grow
// "fresh dill" by Thursday, and re-searching a known miss burns the budget
// the unpriced expensive rows needed. Products that came back but were all
// gated out (stock-outs, red-listed brands, allergen hits, sizeless packs)
// record NOTHING — a stock-out ends by Thursday, and poisoning the food for
// 30 days over it would lie about the store (Red Team, 2026-08-30). A
// THROWN search (network, 429) also records nothing: failure to ask is not
// an answer.

import {
  allergenHits,
  applyLivePrice,
  isStalePrice,
  locationIdFor,
  normalizePins,
  pinFor,
  pinKey,
  rankCandidates,
  refreshPinFacts,
  setPin,
} from "./kroger.js";
import { itemCost } from "./prices.js";
import { plentyKey } from "./shopping.js";

/** Days a recorded miss suppresses re-searching a food at a store. */
export const MISS_EXPIRY_DAYS = 30;
/** UPCs per /kroger/byId call (the worker caps at 60; 40 keeps headroom). */
export const BYID_CHUNK = 40;
/** byId calls per build: 3 x weight 2 = 6 rate units. */
export const BYID_MAX_CHUNKS = 3;
/** Live searches per build: 12 rate units. */
export const SEARCH_BUDGET = 12;

/**
 * Is this food inside its unexpired miss window at this store?
 * @param {import("./kroger.js").PinBook} pins normalized
 * @param {string} food
 * @param {string} store
 * @param {string} todayIso
 * @returns {boolean}
 */
export function isMissed(pins, food, store, todayIso) {
  // keyed by plentyKey, the SAME key phase 2 dedupes rows by — under pinKey,
  // "banana" and "bananas" were one search slot but two miss keys, so a
  // shift in which spelling arrives first would dodge the cache and re-spend
  // the budget (Loyalist, 2026-08-30)
  const at = pins.misses?.[plentyKey(food)]?.[store];
  if (!at) return false;
  const days = (Date.parse(todayIso) - Date.parse(at)) / 86400000;
  return Number.isFinite(days) && days >= 0 && days < MISS_EXPIRY_DAYS;
}

/**
 * Record a genuine empty search result. Also prunes expired entries so the
 * file cannot grow without bound.
 * @param {import("./kroger.js").PinBook} pins normalized
 * @param {string} food
 * @param {string} store
 * @param {string} todayIso
 * @returns {import("./kroger.js").PinBook}
 */
export function recordMiss(pins, food, store, todayIso) {
  /** @type {Record<string, Record<string, string>>} */
  const misses = {};
  for (const [f, byStore] of Object.entries(pins.misses ?? {})) {
    for (const [s, at] of Object.entries(byStore)) {
      const days = (Date.parse(todayIso) - Date.parse(at)) / 86400000;
      if (Number.isFinite(days) && days >= 0 && days < MISS_EXPIRY_DAYS) {
        (misses[f] ??= {})[s] = at;
      }
    }
  }
  (misses[plentyKey(food)] ??= {})[store] = todayIso;
  return { ...pins, misses };
}

/**
 * One recorded action of a reprice run, replayable onto a NEWER book pair
 * when the user edited pins/prices while the run was in flight.
 * @typedef {{ kind: "facts" | "pin" | "miss", food: string, product?: import("./kroger.js").KrogerProduct }} RepriceOp
 */

/**
 * Price a freshly built list: refresh the stale pinned rows by UPC (chunked),
 * then spend the search budget on pinless rows: the ones this store knows
 * NOTHING about first, then the most expensive still-estimated
 * rows. Pure over its inputs — the caller saves the returned books, ONCE
 * each, only when `pinsChanged` / `pricesChanged` say something moved. If
 * the live books moved while the run was in flight (a $? tap, a receipt),
 * replay `ops` onto the LIVE books with `reapplyOps` instead of saving the
 * returned ones — the user's own writes always win.
 *
 * @param {{
 *   items: { food: string, qty: number, unit: string, section?: string, checked?: boolean }[],
 *   pins: any,
 *   prices: import("./prices.js").PriceCatalogue,
 *   store: string,
 *   avoid?: string[],
 *   todayIso: string,
 *   api: {
 *     pricesById: (upcs: string[], locationId: string) => Promise<{ products: import("./kroger.js").KrogerProduct[], failed: string[], requested: number }>,
 *     search: (term: string, locationId: string) => Promise<import("./kroger.js").KrogerProduct[]>,
 *   },
 *   onProgress?: (note: string) => void,
 * }} opts
 * @returns {Promise<{
 *   pins: import("./kroger.js").PinBook,
 *   prices: import("./prices.js").PriceCatalogue,
 *   pinsChanged: boolean,
 *   pricesChanged: boolean,
 *   ops: RepriceOp[],
 *   refreshed: number,
 *   autoPicked: number,
 *   missed: number,
 *   needPick: number,
 *   truncated: number,
 *   note: string,
 * }>}
 */
export async function repriceList({ items, pins, prices, store, avoid = [], todayIso, api, onProgress }) {
  const book0 = normalizePins(pins);
  let book = book0;
  let cat = prices;
  let refreshed = 0;
  let autoPicked = 0;
  let missed = 0;
  let needPick = 0;
  let truncated = 0;
  /** @type {RepriceOp[]} */
  const ops = [];
  const done = (/** @type {string} */ note) => ({
    pins: book,
    prices: cat,
    pinsChanged: book !== book0,
    pricesChanged: cat !== prices,
    ops,
    refreshed,
    autoPicked,
    missed,
    needPick,
    truncated,
    note,
  });

  const locId = locationIdFor(book, store);
  if (!locId) return done("");
  const progress = onProgress ?? (() => {});

  // one search per RENDERED line, not per canonical key: "banana" and
  // "bananas" are distinct pinKeys but one plentyKey (and one visual row) —
  // spending two of twelve slots on them is the double-buy in new clothes
  /** @type {Map<string, { food: string, qty: number, unit: string, section?: string }>} */
  const byKey = new Map();
  for (const it of items) {
    const k = plentyKey(it.food);
    if (!byKey.has(k)) byKey.set(k, it);
  }
  const rows = [...byKey.values()];

  // ---- phase 1: byId refresh for pinned rows whose price is stale or absent
  const needsRefresh = rows.flatMap((it) => {
    const pin = pinFor(book, it.food, store);
    if (!pin?.upc) return [];
    const row = (cat.items ?? []).find((r) => r.id === pinKey(it.food));
    const sp = /** @type {any} */ (row?.prices?.[store]);
    return !sp || isStalePrice(sp, todayIso) || !sp.at ? [{ food: it.food, upc: pin.upc }] : [];
  });
  const chunks = [];
  for (let i = 0; i < needsRefresh.length && chunks.length < BYID_MAX_CHUNKS; i += BYID_CHUNK) {
    chunks.push(needsRefresh.slice(i, i + BYID_CHUNK));
  }
  truncated = Math.max(0, needsRefresh.length - BYID_MAX_CHUNKS * BYID_CHUNK);
  // a pin whose UPC the store no longer returns is effectively pinless —
  // fold it into phase 2 so it can re-pin, instead of burning a byId slot
  // on every future build forever
  const failedFoods = new Set();
  for (const [ci, chunk] of chunks.entries()) {
    progress(`pricing pinned rows… ${ci + 1}/${chunks.length}`);
    let res;
    try {
      res = await api.pricesById(
        chunk.map((c) => c.upc),
        locId,
      );
    } catch {
      // network/quota: stop asking, keep what already landed, change nothing else
      return done(refreshed > 0 ? `${refreshed} priced, then the store stopped answering` : "live pricing unreachable");
    }
    if (res.requested < chunk.length) truncated += chunk.length - res.requested;
    for (const upc of res.failed) {
      const hit = chunk.find((c) => c.upc === upc);
      if (hit) failedFoods.add(plentyKey(hit.food));
    }
    for (const p of res.products) {
      const hit = chunk.find((c) => c.upc === p.upc);
      if (!hit) continue;
      book = refreshPinFacts(book, hit.food, store, p, todayIso);
      ops.push({ kind: "facts", food: hit.food, product: p });
      if (p.price.regular == null) continue;
      const next = applyLivePrice(cat, store, hit.food, p, todayIso);
      if (next !== cat) {
        cat = next;
        refreshed += 1;
      }
    }
  }

  // ---- phase 2: search budget on pinless rows — dark rows first, then
  // most expensive estimate. "Estimate" = this store's own estimate row;
  // a row with none is dark and jumps the queue (see the sort comment).
  const searchable = rows
    .filter((it) => !pinFor(book, it.food, store) || failedFoods.has(plentyKey(it.food)))
    .filter((it) => !isMissed(book, it.food, store, todayIso))
    .filter((it) => {
      if (failedFoods.has(plentyKey(it.food))) return true;
      const row = (cat.items ?? []).find((r) => r.id === pinKey(it.food));
      const sp = /** @type {any} */ (row?.prices?.[store]);
      return !sp || sp.estimate || isStalePrice(sp, todayIso);
    })
    .map((it) => ({ it, est: itemCost(it, cat, store)?.cost ?? null }))
    .sort((a, b) => {
      // DARK ROWS FIRST (David, 2026-08-30: "I know Payless sells
      // blueberries... why would that not get priced?"). A row this store
      // has an estimate for already counts toward the total; a row it knows
      // NOTHING about silently turns the total into a floor. The old
      // most-expensive-first sort estimated dark rows at $0 and parked
      // every one of them behind the estimate-refreshes — exactly
      // backwards. Within each group, most expensive first still holds.
      if ((a.est == null) !== (b.est == null)) return a.est == null ? -1 : 1;
      return (b.est ?? 0) - (a.est ?? 0);
    })
    .slice(0, SEARCH_BUDGET);
  for (const [si, { it }] of searchable.entries()) {
    progress(`finding prices… ${si + 1}/${searchable.length}`);
    let products;
    try {
      products = await api.search(it.food, locId);
    } catch {
      // a failed ASK is not a miss — leave the food eligible for next build
      return done(summaryNote(refreshed, autoPicked, missed, needPick, truncated) || "live pricing cut short");
    }
    const best = rankCandidates(products, it.food, book.redList, it.section ?? "", it.qty > 0 ? { qty: it.qty, unit: it.unit } : null)
      .filter((c) => allergenHits(c, avoid).length === 0)
      // a pack-sold product with no size can be pinned but never priced
      // (applyLivePrice's P4 guard) — pinning it would trap the row: priced
      // by nothing, excluded from every future search by its own pin
      .filter((c) => c.soldBy === "WEIGHT" || c.size)[0];
    if (best) {
      book = setPin(book, it.food, store, best, todayIso, false);
      ops.push({ kind: "pin", food: it.food, product: best });
      const next = applyLivePrice(cat, store, it.food, best, todayIso);
      if (next !== cat) {
        cat = next;
        autoPicked += 1;
      }
    } else if (products.length === 0) {
      // the store genuinely carries nothing under this name
      book = recordMiss(book, it.food, store, todayIso);
      ops.push({ kind: "miss", food: it.food });
      missed += 1;
    } else {
      // products exist but every one was gated out (stock-out, red list,
      // allergen, sizeless): say so, record nothing, leave $? to the human
      needPick += 1;
    }
  }

  return done(summaryNote(refreshed, autoPicked, missed, needPick, truncated));
}

/**
 * Replay a finished run's ops onto LIVE books that moved while the run was
 * in flight (the user tapped $?, confirmed a pin, applied a receipt). Rule:
 * an op only lands where the live pin for that food+store is still exactly
 * what the run started from — any human write in the window wins outright,
 * price included (Red Team + Engineer, 2026-08-30: the coalesced save was
 * silently clobbering concurrent picks).
 * @param {import("./kroger.js").PinBook} livePins normalized, current
 * @param {import("./prices.js").PriceCatalogue} livePrices current
 * @param {import("./kroger.js").PinBook} basePins the run's starting book
 * @param {RepriceOp[]} ops
 * @param {string} store
 * @param {string} todayIso
 * @returns {{ pins: import("./kroger.js").PinBook, prices: import("./prices.js").PriceCatalogue, pinsChanged: boolean, pricesChanged: boolean }}
 */
export function reapplyOps(livePins, livePrices, basePins, ops, store, todayIso) {
  let book = livePins;
  let cat = livePrices;
  for (const op of ops) {
    const liveEntry = pinFor(livePins, op.food, store);
    const baseEntry = pinFor(basePins, op.food, store);
    const untouched = JSON.stringify(liveEntry) === JSON.stringify(baseEntry);
    if (!untouched) continue;
    if (op.kind === "facts" && op.product) {
      book = refreshPinFacts(book, op.food, store, op.product, todayIso);
      if (op.product.price.regular != null) cat = applyLivePrice(cat, store, op.food, op.product, todayIso);
    } else if (op.kind === "pin" && op.product) {
      book = setPin(book, op.food, store, op.product, todayIso, false);
      cat = applyLivePrice(cat, store, op.food, op.product, todayIso);
    } else if (op.kind === "miss") {
      book = recordMiss(book, op.food, store, todayIso);
    }
  }
  return { pins: book, prices: cat, pinsChanged: book !== livePins, pricesChanged: cat !== livePrices };
}

/**
 * @param {number} refreshed
 * @param {number} autoPicked
 * @param {number} missed
 * @param {number} needPick
 * @param {number} truncated
 */
function summaryNote(refreshed, autoPicked, missed, needPick, truncated) {
  const parts = [];
  if (refreshed > 0) parts.push(`${refreshed} re-priced`);
  if (autoPicked > 0) parts.push(`${autoPicked} auto-picked`);
  if (missed > 0) parts.push(`${missed} not carried at this store`);
  if (needPick > 0) parts.push(`${needPick} need a manual pick ($?)`);
  if (truncated > 0) parts.push(`${truncated} left for the next build`);
  return parts.join(", ");
}
