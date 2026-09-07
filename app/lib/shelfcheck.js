// THE SHELF CHECK AND WHAT'S LEFT (P6, P11; David, 2026-09-06/07).
//
// "Best case scenario is the pantry self-updates by all of the stuff that I
// supposedly cook with automatically getting subtracted. Then I can do a
// quick check before setting the next week and see if all of that stuff is
// still there or how the week went." Cooking subtracts only when COOKED is
// tapped, so the shelf the app believes in drifts from the shelf in the
// kitchen by exactly the meals nobody tapped and the snacks nobody planned.
// The shelf check is the moment the two are reconciled, on purpose, before
// GENERATE reads the pantry: every counted row is shown with the amount the
// app believes, and the person says STILL HAVE, corrects the count, or says
// it is GONE. A correction downward and a GONE are write-offs (waste ledger,
// reason "shelf-check"), because food that left without a COOKED tap is
// either waste or an untapped meal, and either way the review must see it.
//
// "At the end of the week there are various miscellaneous things just lying
// around, the last of a bag of potatoes, a few things of chicken, some
// noodles. One of them really should just be what's left in the fridge, and
// I generate something from there." useWhatsLeft ranks the bank by how much
// of a dish the shelf already covers, expiring rows first, so the odds and
// ends become a planned meal instead of next week's write-off.

import { aisleOf, canonicalFood, normalizeQty } from "./ingredients.js";
import { isDatedItem, packPantry, pantryItems, perishableStatus, plentyKey } from "./shopping.js";
import { generatorEligible } from "./weekbuilder.js";

/** A confirmation older than this is stale again: a week is one shop cycle. */
export const SHELF_CHECK_DAYS = 7;

/** Coverage below this and a dish is not "what's left", it is a shopping trip. */
export const USE_WHATS_LEFT_MIN_COVERAGE = 0.6;

/**
 * @param {string} iso
 * @param {number} days
 * @returns {string}
 */
function shiftIso(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Every counted row with what the app believes about it, stale ones first.
 * @param {Record<string, any> | null | undefined} pantry
 * @param {string} todayIso
 * @returns {{
 *   rows: { id: string, food: string, qty: string, said: string | null, location: string, added: string | null, checkedAt: string | null, daysLeft: number | null, stale: boolean }[],
 *   stale: number,
 *   lastChecked: string | null
 * }}
 */
export function shelfCheckRows(pantry, todayIso) {
  const cutoff = shiftIso(todayIso, -SHELF_CHECK_DAYS);
  const rows = pantryItems(pantry)
    .filter(isDatedItem)
    .map((it) => {
      const checkedAt = typeof it.checkedAt === "string" ? it.checkedAt : null;
      return {
        id: String(it.id),
        food: String(it.food ?? ""),
        qty: typeof it.qty === "string" ? it.qty : "",
        said: typeof it.said === "string" && it.said ? it.said : null,
        location: typeof it.location === "string" ? it.location : "unsorted",
        added: typeof it.added === "string" ? it.added : null,
        checkedAt,
        daysLeft: perishableStatus(it, todayIso).daysLeft,
        stale: !checkedAt || checkedAt < cutoff,
      };
    })
    .sort((a, b) => {
      if (a.stale !== b.stale) return a.stale ? -1 : 1;
      const ac = a.checkedAt ?? "";
      const bc = b.checkedAt ?? "";
      if (ac !== bc) return ac < bc ? -1 : 1;
      return a.food.localeCompare(b.food);
    });
  const checked = rows.map((r) => r.checkedAt).filter((c) => c !== null);
  return {
    rows,
    stale: rows.filter((r) => r.stale).length,
    lastChecked: checked.length > 0 ? /** @type {string} */ (checked.sort().at(-1)) : null,
  };
}

/**
 * STILL HAVE: the row is right as the app believes it. Stamps checkedAt.
 * @param {Record<string, any>} pantry
 * @param {string} id
 * @param {string} todayIso
 * @returns {Record<string, any>}
 */
export function confirmShelfRow(pantry, id, todayIso) {
  const items = pantryItems(pantry).map((it) =>
    it.id === id && isDatedItem(it) ? { ...it, checkedAt: todayIso } : it,
  );
  return packPantry(items);
}

/**
 * @param {string} qty
 * @returns {{ n: number, unit: string } | null}
 */
function countable(qty) {
  const m = /^\s*(\d+(?:\.\d+)?)\s+(\S.*)$/.exec(qty);
  return m ? { n: Number(m[1]), unit: String(m[2]).trim() } : null;
}

/**
 * EDIT COUNT: the shelf holds `saidQty` of this row, in the person's words.
 * The words are normalized the same way a dictation is, and kept in `said`.
 * When the new count is below the old one in the same unit, the difference is
 * a write-off; above it is a note that something came in untracked (a meal
 * cooked from another pot, a buy nobody ticked); incomparable units say so.
 * @param {Record<string, any>} pantry
 * @param {string} id
 * @param {string} saidQty
 * @param {string} todayIso
 * @returns {{ pantry: Record<string, any>, waste: Record<string, any> | null, direction: "down" | "up" | "same" | "unknown" }}
 */
export function editShelfRow(pantry, id, saidQty, todayIso) {
  const said = String(saidQty ?? "").trim();
  const items = pantryItems(pantry);
  const at = items.findIndex((it) => it.id === id && isDatedItem(it));
  if (at < 0 || !said) return { pantry, waste: null, direction: "unknown" };
  const old = /** @type {Record<string, any>} */ (items[at]);
  const normalized = normalizeQty(String(old.food ?? ""), said);
  /** @type {Record<string, any>} */
  const next = {
    ...old,
    qty: normalized ?? said,
    said,
    checkedAt: todayIso,
  };
  if (!normalized) delete next.said;
  const before = countable(String(old.qty ?? ""));
  const after = countable(String(next.qty));
  /** @type {"down" | "up" | "same" | "unknown"} */
  let direction = "unknown";
  /** @type {Record<string, any> | null} */
  let waste = null;
  if (before && after && before.unit === after.unit) {
    if (after.n < before.n - 1e-9) {
      direction = "down";
      waste = {
        id: old.id,
        food: old.food,
        qty: `${Math.round((before.n - after.n) * 100) / 100} ${before.unit}`,
        added: old.added,
        location: old.location,
      };
    } else if (after.n > before.n + 1e-9) direction = "up";
    else direction = "same";
  }
  const out = items.slice();
  out[at] = next;
  return { pantry: packPantry(out), waste, direction };
}

/**
 * GONE: the row is not in the kitchen any more. Removed, and written off.
 * @param {Record<string, any>} pantry
 * @param {string} id
 * @returns {{ pantry: Record<string, any>, waste: Record<string, any> | null }}
 */
export function goneShelfRow(pantry, id) {
  const items = pantryItems(pantry);
  const gone = items.find((it) => it.id === id && isDatedItem(it));
  if (!gone) return { pantry, waste: null };
  return {
    pantry: packPantry(items.filter((it) => it !== gone)),
    waste: {
      id: gone.id,
      food: gone.food,
      qty: gone.qty,
      added: gone.added,
      location: gone.location,
    },
  };
}

/**
 * The dishes the shelf already mostly holds, for one slot, expiring food
 * first. A dish qualifies when at least USE_WHATS_LEFT_MIN_COVERAGE of its
 * non-staple ingredients are on the shelf (a counted row or a PLENTY
 * assertion); it ranks by that coverage, then by how many rows inside their
 * last three days it uses, then by how few things it still needs.
 * @param {Record<string, any>[]} recipes the person's screened pool
 * @param {Record<string, any> | null | undefined} pantry
 * @param {string} todayIso
 * @param {{ slot?: string, limit?: number }} [opts]
 * @returns {{ recipe: Record<string, any>, coverage: number, covered: string[], missing: string[], expiring: string[] }[]}
 */
export function useWhatsLeft(recipes, pantry, todayIso, opts = {}) {
  const limit = opts.limit ?? 5;
  const slot = opts.slot;
  /** @type {Set<string>} */
  const have = new Set();
  /** @type {Set<string>} */
  const soon = new Set();
  for (const it of pantryItems(pantry)) {
    const dated = isDatedItem(it);
    if (!(dated || it.state === "plenty")) continue;
    const keys = [canonicalFood(String(it.food)), plentyKey(String(it.food))];
    for (const k of keys) have.add(k);
    if (dated) {
      const { daysLeft } = perishableStatus(it, todayIso);
      if (daysLeft !== null && daysLeft <= 3) for (const k of keys) soon.add(k);
    }
  }
  const pool = generatorEligible(recipes).filter(
    (r) => !slot || r.mealType === slot || (slot === "lunch" && r.mealType === "dinner"),
  );
  const out = [];
  for (const r of pool) {
    // the background of every kitchen (spices, oils, vinegars, sauces) is
    // not "what's left": counting it made a dish 60% covered on cumin and
    // olive oil alone (live run, 2026-09-07). Coverage is about the food.
    const ings = (Array.isArray(r.ingredients) ? r.ingredients : []).filter(
      (/** @type {any} */ i) =>
        i && i.food && !i.staple && !["spices", "condiments"].includes(aisleOf(String(i.food))),
    );
    if (ings.length === 0) continue;
    /** @type {string[]} */
    const covered = [];
    /** @type {string[]} */
    const missing = [];
    /** @type {string[]} */
    const expiring = [];
    for (const i of ings) {
      const k1 = canonicalFood(String(i.food));
      const k2 = plentyKey(String(i.food));
      if (have.has(k1) || have.has(k2)) {
        covered.push(String(i.food));
        if (soon.has(k1) || soon.has(k2)) expiring.push(String(i.food));
      } else missing.push(String(i.food));
    }
    const coverage = covered.length / ings.length;
    if (coverage < USE_WHATS_LEFT_MIN_COVERAGE) continue;
    out.push({ recipe: r, coverage, covered, missing, expiring });
  }
  out.sort(
    (a, b) =>
      b.expiring.length - a.expiring.length ||
      b.coverage - a.coverage ||
      a.missing.length - b.missing.length ||
      String(a.recipe.name).localeCompare(String(b.recipe.name)),
  );
  return out.slice(0, limit);
}
