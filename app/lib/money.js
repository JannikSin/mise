// Receipt cost-split for Tables (roadmap M1-money; vault
// Life/Mise-Social-Architecture.md). The cook pays for the batch; every
// seat owes their SERVINGS SHARE of what it cost. A per-house ledger
// (households/<h>/ledger.json) accumulates entries as table dates pass and
// nets out who-owes-who until someone taps settled. Mise never moves money:
// it computes the number, settling happens in the real world.
//
// Costing honesty mirrors the shopping list: ingredient prices come from
// prices.json (receipt-refreshed when the scanner runs); rows the catalogue
// cannot price make the total a FLOOR and mark the entry `estimate`.
import { itemCost } from "./prices.js";
import { parsePot } from "./synth.js";

/**
 * @typedef {{ id: string, date: string, payerId: string, total: number, estimate: boolean, shares: Record<string, number>, settled?: boolean }} LedgerEntry
 *   id = the table's id (idempotency + id-keyed merge)
 * @typedef {{ entries: LedgerEntry[] }} Ledger
 */

export const ledgerPathFor = (/** @type {string} */ house) => `households/${house}/ledger.json`;

/**
 * @param {Record<string, any> | null} raw
 * @returns {Ledger}
 */
export function normalizeLedger(raw) {
  return { entries: Array.isArray(raw?.entries) ? raw.entries : [] };
}

/**
 * What one cooked serving of a recipe costs at a store, floor-priced like
 * the shopping list (unpriceable ingredients count 0 and flag the result).
 * @param {Record<string, any>} recipe
 * @param {import("./prices.js").PriceCatalogue | null} catalogue
 * @param {string} store
 * @returns {{ perServing: number, estimate: boolean }}
 */
export function recipeServingCost(recipe, catalogue, store) {
  let total = 0;
  let anyEstimate = false;
  let anyUnpriced = false;
  for (const ing of recipe.ingredients ?? []) {
    const c = itemCost(
      { food: String(ing.food), qty: Number(ing.qty) || 1, unit: String(ing.unit ?? "x") },
      catalogue,
      store,
    );
    if (!c) {
      anyUnpriced = true;
      continue;
    }
    total += c.cost;
    if (c.estimate) anyEstimate = true;
  }
  const servings = Number(recipe.servings) || 1;
  return {
    perServing: Math.round((total / servings) * 100) / 100,
    estimate: anyEstimate || anyUnpriced,
  };
}

/**
 * The ledger entry a finished table produces: total = per-serving cost x
 * every KNOWN non-skipped seat's servings; each seat's share is
 * proportional to what their diet said they'd eat (2 servings owes twice
 * what 1 does — David's rule). The payer is the cook.
 * @param {import("./tables.js").TableEvent} t
 * @param {string} cookId
 * @param {Record<string, any>} recipe
 * @param {import("./prices.js").PriceCatalogue | null} catalogue
 * @param {string} store
 * @param {Map<string, any>} profilesById
 * @returns {LedgerEntry | null} null when nothing owes anything
 */
export function ledgerEntryFor(t, cookId, recipe, catalogue, store, profilesById) {
  const seats = (t.seats ?? []).filter((s) => s.status !== "skipped" && profilesById.has(s.id));
  if (seats.length === 0) return null;

  // PAY FOR WHAT YOU EAT, exactly (David, 2026-08-10 + per-person-plates
  // spec §11.1): a SOLVED table's frozen pot carries each seat's share of
  // each row, so shares are costed per row per seat through itemCost —
  // David eating 2.5x the chicken and 0.7x the rice is not a
  // servings-proportional split, and chicken is the expensive row. A seat
  // whose food was SET ASIDE still appears in perSeat and still pays: the
  // food is theirs, it went in the fridge for them. Falls back to the
  // servings-proportional rule below whenever no valid frozen pot exists
  // (every uniform table, i.e. all of them until the drip).
  const pot = parsePot(/** @type {any} */ (t).pot, recipe);
  if (pot && pot.rows.some((r) => r.perSeat)) {
    // billable = people AT THIS TABLE (any status: a post-buy skip's food
    // was bought for them and they still pay). Household membership alone
    // is NOT enough — a hand-edited perSeat naming an absent housemate
    // must never move the bill onto someone who was not at dinner.
    const atTable = new Set((t.seats ?? []).map((s) => s.id).filter((id) => profilesById.has(id)));
    /** @type {Record<string, number>} */
    const shares = {};
    let anyPriced = false;
    // rung-3 top-ups are excluded from BILLING on purpose: the catalogue
    // prices gram rows at the whole package (25 g of peanut butter would
    // bill a jar), so their cost floors at 0 and flags the entry estimate.
    // They still reach the BUY through the shopping list's potRows.
    let est = (pot.topUps ?? []).length > 0;
    for (const row of pot.rows) {
      if (!row.perSeat) {
        est = true; // a sanitized-away map is an unpriced row: floor + flag
        continue;
      }
      const rowCost = itemCost({ food: row.food, qty: row.qty, unit: row.unit }, catalogue, store);
      if (!rowCost || !(rowCost.cost > 0)) {
        est = true; // an unpriceable row floors at 0, flagged, same as today
        continue;
      }
      anyPriced = true;
      if (rowCost.estimate) est = true;
      const rowQty = Number(row.qty) || 0;
      if (rowQty <= 0) continue;
      for (const [seatId, q] of Object.entries(row.perSeat ?? {})) {
        if (!atTable.has(seatId)) {
          est = true; // a departed seat's share is dropped, and the total says so
          continue;
        }
        const share = (rowCost.cost * Number(q)) / rowQty;
        shares[seatId] = (shares[seatId] ?? 0) + share;
      }
    }
    if (anyPriced && Object.keys(shares).length > 0) {
      let total2 = 0;
      for (const id of Object.keys(shares)) {
        shares[id] = Math.round((shares[id] ?? 0) * 100) / 100;
        total2 += shares[id] ?? 0;
      }
      const total = Math.round(total2 * 100) / 100;
      return { id: t.id, date: t.date, payerId: cookId, total, estimate: est, shares, settled: false };
    }
  }

  const { perServing, estimate } = recipeServingCost(recipe, catalogue, store);
  if (perServing <= 0) return null; // nothing priceable: no honest debt to record
  // a PLATED table that reaches recording without a valid pot (merge race,
  // never claimed, corrupt string) bills by this path WITH the estimate
  // flag (spec §11.1): the bill must never look authoritative when the
  // exact contract was lost
  const lostPot = recipe.assembly === "plated" && !(/** @type {any} */ (t).sameForEveryone);
  /** @type {Record<string, number>} */
  const shares = {};
  let total = 0;
  for (const s of seats) {
    const servings = Number(s.servings) || 1;
    const share = Math.round(perServing * servings * 100) / 100;
    shares[s.id] = share;
    total += share;
  }
  return {
    id: t.id,
    date: t.date,
    payerId: cookId,
    total: Math.round(total * 100) / 100,
    estimate: estimate || lostPot,
    shares,
    settled: false,
  };
}

/**
 * Append entries for finished tables not yet in the ledger. Idempotent by
 * table id — two devices recording the same table merge to one entry.
 * @param {Ledger} ledger
 * @param {LedgerEntry[]} candidates
 * @returns {{ ledger: Ledger, added: number }}
 */
export function recordEntries(ledger, candidates) {
  const have = new Set(ledger.entries.map((e) => e.id));
  const fresh = candidates.filter((e) => !have.has(e.id));
  return fresh.length === 0
    ? { ledger, added: 0 }
    : { ledger: { ...ledger, entries: [...ledger.entries, ...fresh] }, added: fresh.length };
}

/**
 * Net unsettled balances from MY point of view: positive = they owe me.
 * A payer's own share of their own table is their own dinner, not a debt.
 * @param {Ledger} ledger
 * @param {string} me
 * @returns {{ profileId: string, net: number, entries: number, estimate: boolean }[]} sorted by |net| desc
 */
export function balancesFor(ledger, me) {
  /** @type {Map<string, { net: number, entries: number, estimate: boolean }>} */
  const by = new Map();
  const bump = (
    /** @type {string} */ who,
    /** @type {number} */ amount,
    /** @type {boolean} */ est,
  ) => {
    const cur = by.get(who) ?? { net: 0, entries: 0, estimate: false };
    cur.net = Math.round((cur.net + amount) * 100) / 100;
    cur.entries++;
    cur.estimate = cur.estimate || est;
    by.set(who, cur);
  };
  for (const e of ledger.entries) {
    if (e.settled) continue;
    if (e.payerId === me) {
      for (const [pid, share] of Object.entries(e.shares)) {
        if (pid !== me) bump(pid, share, e.estimate);
      }
    } else if (e.shares[me] != null) {
      bump(e.payerId, -e.shares[me], e.estimate);
    }
  }
  return [...by.entries()]
    .map(([profileId, v]) => ({ profileId, ...v }))
    .filter((b) => Math.abs(b.net) >= 0.01)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}

/**
 * Settle every unsettled entry between me and one other person (both
 * directions). Field-wise merge keeps concurrent settles safe. Pure.
 * @param {Ledger} ledger
 * @param {string} me
 * @param {string} other
 * @returns {Ledger}
 */
export function settleBetween(ledger, me, other) {
  return {
    ...ledger,
    entries: ledger.entries.map((e) => {
      const involves =
        (e.payerId === me && e.shares[other] != null) ||
        (e.payerId === other && e.shares[me] != null);
      return involves && !e.settled ? { ...e, settled: true } : e;
    }),
  };
}
