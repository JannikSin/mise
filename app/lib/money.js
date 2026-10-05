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
//
// ONLY CONFIRMED MONEY MOVES THE BALANCE (David, 2026-10-05, zermatt: "it
// should only add money there when it is confirmed who paid and how much,
// cause totals differ based on what is available"). Shelf-price estimates
// are wrong in both amount and direction: Elliot buys, David Zelles him
// after, but a meal record bills the COOK. So meal records (no `kind`) are
// WHO-ATE-WHAT only: they weight a trip's split and never become a debt.
// The balance is built from two confirmed kinds, both typed by a person:
//   kind "purchase": someone paid a real receipt total; each housemate owes
//     their eaten share of the shared meals that trip was for.
//   kind "payment": someone paid someone back (a Zelle); it offsets.
import { canonicalFood } from "./ingredients.js";
import { itemCost } from "./prices.js";
import { parsePot } from "./synth.js";

/**
 * @typedef {{ id: string, date: string, payerId: string, total: number, estimate: boolean, shares: Record<string, number>, settled?: boolean, basis?: "eaten", kind?: "purchase" | "payment", toId?: string, split?: "eaten" | "even", note?: string }} LedgerEntry
 *   id = the table's id (idempotency + id-keyed merge). `basis: "eaten"` =
 *   billed at the eaten share of each ingredient; absent = the old
 *   whole-package billing, which recordEntries re-costs while unsettled
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
 * What one cooked serving of a recipe costs to EAT at a store — the
 * ingredients' consumed fractions (`itemCost().eaten`), never whole packs.
 * This is the composer's cost signal (David's yes, 2026-08-30: "let the
 * composer see cost"): recipeServingCost below charges whole packages, so a
 * pinch from an $8 spice jar reads as +$8 per pot and the ranking would
 * flee every seasoned dish; the eaten figure is the marginal cost of
 * cooking the dish one more time, which is the thing a menu choice changes.
 * `priced` counts ingredients the catalogue could price at all — a recipe
 * with priced === 0 has NO signal and the caller must substitute something
 * neutral (the bank median), never zero (free) or Infinity (banned).
 * @param {Record<string, any>} recipe
 * @param {import("./prices.js").PriceCatalogue | null} catalogue
 * @param {string} store
 * @returns {{ perServing: number, priced: number, of: number, estimate: boolean }}
 */
export function recipeEatenCost(recipe, catalogue, store) {
  let anyEstimate = false;
  let eaten = 0;
  let priced = 0;
  let of = 0;
  for (const ing of recipe.ingredients ?? []) {
    of += 1;
    const c = itemCost(
      { food: String(ing.food), qty: Number(ing.qty) || 1, unit: String(ing.unit ?? "x") },
      catalogue,
      store,
    );
    if (!c) continue;
    priced += 1;
    eaten += c.eaten;
    if (c.estimate) anyEstimate = true;
  }
  const servings = Number(recipe.servings) || 1;
  return {
    perServing: Math.round((eaten / servings) * 100) / 100,
    priced,
    of,
    estimate: anyEstimate || priced < of,
  };
}

/**
 * The packages a recipe puts on THIS trip, one row per food the kitchen does
 * not already hold, keyed by canonical food so two recipes needing the same
 * thing share one package (David, 2026-09-24: "the planner NEEDS to have
 * pantry, ingredient overlap and budget"). The composer sums these over the
 * week's picks: a food already bought for another meal costs nothing more.
 * @param {Record<string, any>} recipe
 * @param {any} catalogue
 * @param {string} store
 * @param {(food: string) => boolean} has what the kitchen already holds
 * @returns {{ key: string, cost: number, need: { food: string, qty: number, unit: string }[] }[]}
 */
export function recipeTripItems(recipe, catalogue, store, has) {
  /** @type {Map<string, { cost: number, need: { food: string, qty: number, unit: string }[] }>} */
  const byKey = new Map();
  for (const ing of recipe.ingredients ?? []) {
    if (!ing?.food || ing.staple || has(String(ing.food))) continue;
    const need = {
      food: String(ing.food),
      qty: Number(ing.qty) || 1,
      unit: String(ing.unit ?? "x"),
    };
    const c = itemCost(need, catalogue, store);
    if (!c) continue;
    const key = canonicalFood(String(ing.food));
    const cur = byKey.get(key);
    byKey.set(key, {
      cost: Math.max(cur?.cost ?? 0, c.cost),
      need: [...(cur?.need ?? []), need],
    });
  }
  // `need` is the written recipe's own amounts: the composer scales them to
  // the pot and prices the week's sum once (priceNeed, 2026-09-25)
  return [...byKey].map(([key, v]) => ({ key, cost: v.cost, need: v.need }));
}

/**
 * What a recipe costs THIS TRIP, per serving (David, 2026-09-24: "how can 3
 * days of food be $121"). recipeEatenCost prices the fraction eaten, so a
 * $12 bottle bought for two tablespoons scored $0.98 and the planner picked
 * it happily. Here every ingredient the kitchen does not already hold costs
 * its WHOLE package, and one it holds costs nothing, so the planner prefers
 * food that uses what is on the shelf and avoids a jar for a pinch.
 * Unpriced ingredients count 0 (neither free nor banned is knowable).
 * @param {Record<string, any>} recipe
 * @param {any} catalogue
 * @param {string} store
 * @param {(food: string) => boolean} has what the kitchen already holds
 * @returns {{ perServing: number, priced: number, of: number }}
 */
export function recipeTripCost(recipe, catalogue, store, has) {
  let trip = 0;
  let priced = 0;
  let of = 0;
  for (const ing of recipe.ingredients ?? []) {
    if (!ing?.food || ing.staple) continue;
    of += 1;
    if (has(String(ing.food))) {
      priced += 1;
      continue;
    }
    const c = itemCost(
      { food: String(ing.food), qty: Number(ing.qty) || 1, unit: String(ing.unit ?? "x") },
      catalogue,
      store,
    );
    if (!c) continue;
    priced += 1;
    trip += c.cost;
  }
  const servings = Number(recipe.servings) || 1;
  return { perServing: Math.round((trip / servings) * 100) / 100, priced, of };
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
        const share = (rowCost.eaten * Number(q)) / rowQty;
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
      return {
        id: t.id,
        date: t.date,
        payerId: cookId,
        total,
        estimate: est,
        shares,
        settled: false,
        basis: "eaten",
      };
    }
  }

  const { perServing, estimate } = recipeEatenCost(recipe, catalogue, store);
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
    basis: "eaten",
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
  // THE WHOLE-PACK HEAL (pierogi, 2026-10-04): entries recorded before the
  // eaten basis billed every ingredient's whole package to every meal (one
  // shared yogurt bowl at $107.32; "Elliot owes ~$1,772"). An UNSETTLED
  // entry without a basis is replaced by its re-costed candidate; settled
  // ones are history and stay exactly as they were paid.
  const byId = new Map(candidates.map((e) => [e.id, e]));
  let healed = 0;
  const entries = ledger.entries.map((e) => {
    const c = byId.get(e.id);
    if (!c || e.settled || e.basis === "eaten") return e;
    healed += 1;
    return c;
  });
  const have = new Set(ledger.entries.map((e) => e.id));
  const fresh = candidates.filter((e) => !have.has(e.id));
  const added = fresh.length + healed;
  return added === 0
    ? { ledger, added: 0 }
    : { ledger: { ...ledger, entries: [...entries, ...fresh] }, added };
}

/**
 * Net unsettled balances from MY point of view: positive = they owe me.
 * A payer's own share is their own food, not a debt. Only CONFIRMED money
 * counts (purchases and paybacks); meal records are weights, never debts.
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
    if (e.settled || !isConfirmedMoney(e)) continue;
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
 * SETTLED between me and one other person: records the payback that zeroes
 * the PAIR's net, never flips whole entries (a three-way trip would erase
 * the third person's debt with it). Pure; `id` and `date` from the caller.
 * @param {Ledger} ledger
 * @param {string} me
 * @param {string} other
 * @param {{ id: string, date: string }} [at]
 * @returns {Ledger}
 */
export function settleBetween(ledger, me, other, at = { id: `settle-${me}-${other}`, date: "" }) {
  const net = balancesFor(ledger, me).find((b) => b.profileId === other)?.net ?? 0;
  if (Math.abs(net) < 0.01) return ledger;
  const pay =
    net > 0
      ? paymentEntry({ id: at.id, date: at.date, fromId: other, toId: me, total: net })
      : paymentEntry({ id: at.id, date: at.date, fromId: me, toId: other, total: -net });
  return pay ? { ...ledger, entries: [...ledger.entries, pay] } : ledger;
}

/**
 * A confirmed money entry: a real receipt total or a real payback. Meal
 * records (no kind) are who-ate-what and never count as money.
 * @param {LedgerEntry} e
 */
export function isConfirmedMoney(e) {
  return e.kind === "purchase" || e.kind === "payment";
}

/**
 * Each person's eaten weight across a set of meal records: the sum of their
 * eaten-cost shares. Used only as PROPORTIONS for a confirmed trip.
 * @param {LedgerEntry[]} meals
 * @returns {Record<string, number>}
 */
export function eatenWeights(meals) {
  /** @type {Record<string, number>} */
  const w = {};
  for (const m of meals) {
    if (isConfirmedMoney(m)) continue;
    for (const [id, v] of Object.entries(m.shares ?? {})) {
      const n = Number(v);
      if (n > 0) w[id] = (w[id] ?? 0) + n;
    }
  }
  return w;
}

/**
 * WE BOUGHT GROCERIES: a confirmed receipt total split by what each person
 * eats (David's rule: pay for what you eat, never an automatic even split),
 * or evenly when the person entering it says so. Rounding lands on the payer
 * so the shares always add to the receipt to the cent. Null when the input
 * cannot make an honest entry (no amount, nobody to split with).
 * @param {{ id: string, date: string, payerId: string, total: number, split: "eaten" | "even", weights: Record<string, number>, members: string[], note?: string }} a
 * @returns {LedgerEntry | null}
 */
export function purchaseEntry(a) {
  const total = Math.round(Number(a.total) * 100) / 100;
  if (!(total > 0) || !a.payerId) return null;
  const ids =
    a.split === "even"
      ? [...new Set([a.payerId, ...a.members])]
      : Object.keys(a.weights).filter((id) => (a.weights[id] ?? 0) > 0);
  if (ids.length < 2) return null;
  const sum = ids.reduce((s, id) => s + (a.split === "even" ? 1 : (a.weights[id] ?? 0)), 0);
  /** @type {Record<string, number>} */
  const shares = {};
  let given = 0;
  for (const id of ids) {
    if (id === a.payerId) continue;
    const part = a.split === "even" ? 1 : (a.weights[id] ?? 0);
    const v = Math.round(((total * part) / sum) * 100) / 100;
    shares[id] = v;
    given += v;
  }
  shares[a.payerId] = Math.round((total - given) * 100) / 100;
  return {
    id: a.id,
    date: a.date,
    kind: "purchase",
    payerId: a.payerId,
    total,
    estimate: false,
    shares,
    settled: false,
    split: a.split,
    ...(a.note ? { note: a.note } : {}),
  };
}

/**
 * I PAID SOMEONE BACK: a real transfer (Zelle, cash). The sender is the
 * payer and the receiver's share is the whole amount, so it nets against
 * what the sender owed them.
 * @param {{ id: string, date: string, fromId: string, toId: string, total: number }} a
 * @returns {LedgerEntry | null}
 */
export function paymentEntry(a) {
  const total = Math.round(Number(a.total) * 100) / 100;
  if (!(total > 0) || !a.fromId || !a.toId || a.fromId === a.toId) return null;
  return {
    id: a.id,
    date: a.date,
    kind: "payment",
    payerId: a.fromId,
    toId: a.toId,
    total,
    estimate: false,
    shares: { [a.toId]: total },
    settled: false,
  };
}

/**
 * Remove one confirmed entry (a mistyped amount). Meal records are never
 * removed this way.
 * @param {Ledger} ledger
 * @param {string} id
 * @returns {Ledger}
 */
export function removeMoneyEntry(ledger, id) {
  return {
    ...ledger,
    entries: ledger.entries.filter((e) => !(e.id === id && isConfirmedMoney(e))),
  };
}
