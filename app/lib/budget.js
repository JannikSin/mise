// SWAP TO FIT (P5). The budget is a CONSTRAINT on generation, never a readout.
//
// Canon: "Generate the week, price every row, and if the total is over the
// number, Mise changes the week: swap a protein, resize a cut, pick a cheaper
// recipe that keeps the overlap, and re-price, until it fits or the app says
// plainly that it cannot and by how much. You review a week that already meets
// the number."
//
// Until 2026-08-19 `grep swapToFit` returned nothing in this repo. The app
// priced the week accurately and truthfully and then showed you the number,
// which is a readout wearing a constraint's name.
//
// Two rules shape the implementation:
//
//   1. A swap may never buy the budget with a broken promise. Every candidate
//      is re-checked against the day's calorie and protein floors and its
//      calorie ceiling before it is kept, so P5 can never quietly cost P1.
//   2. Failure is REPORTED, never hidden. If the week cannot reach the number,
//      the result says so and by how much, because a budget that silently
//      gives up is the readout again with extra steps.

import { deriveShoppingList } from "./shopping.js";
import { recipeServingCost } from "./money.js";
import { tripTotal } from "./prices.js";
import { dayTotals, dayBought } from "./plan.js";
import { enforcedCeilings, enforcedFloors } from "./targets.js";

/**
 * What a plan actually costs to eat this week, at one store.
 * `eaten` is the figure the budget judges: a non-perishable bought in excess
 * is stock, not spend (canon P5's stocking-week rule).
 * @param {Record<string, any>} plan
 * @param {Map<string, any>} recipesById
 * @param {Record<string, any>} pantry
 * @param {Record<string, any> | null} catalogue
 * @param {string} store
 * @param {{ country?: string, state?: string } | undefined} region a targets.region block
 * @param {string} [fromDate]
 * @param {Map<string, any>} [bankById]
 */
export function priceWeek(plan, recipesById, pantry, catalogue, store, region, fromDate, bankById) {
  const list = deriveShoppingList(
    /** @type {any} */ (plan),
    recipesById,
    pantry,
    null,
    fromDate,
    undefined,
    bankById,
  );
  const t = tripTotal(list.items, /** @type {any} */ (catalogue), store, region);
  return { ...t, items: list.items.length };
}

/**
 * Can this entry be swapped at all? Pinned, past, away, table and FIXED
 * entries are somebody's decision or somebody else's meal, and the budget
 * does not get to overrule any of them. `fixed` is a profile's declared
 * "this recipe, every day" slot (targets.fixedSlots, spec 2026-08-25) — a
 * cheaper breakfast is exactly the swap the declaration forbids.
 */
function swappable(/** @type {any} */ e, /** @type {string|undefined} */ today) {
  return (
    Boolean(e.recipeId) && !e.pinned && !e.out && !e.table && !e.fixed && !(today && e.date < today)
  );
}

/**
 * Would putting `recipeId` in this entry break what the person agreed to?
 * Floors and the ceiling, on that day only, against the plan as it stands.
 */
function breaksDay(
  /** @type {any[]} */ entries,
  /** @type {Map<string, any>} */ recipesById,
  /** @type {string} */ date,
  /** @type {{ calories: number, protein: number }} */ floors,
  /** @type {number} */ ceiling,
) {
  const t = dayTotals(/** @type {any} */ (entries), recipesById, date);
  if (t.calories < floors.calories) return true;
  if (t.protein < floors.protein) return true;
  if (ceiling > 0 && t.calories > ceiling) return true;
  return false;
}

/**
 * Change the week until it fits the weekly dollar number, or say by how much
 * it cannot.
 *
 * @param {{
 *   plan: Record<string, any>,
 *   recipes: Record<string, any>[],
 *   recipesById: Map<string, any>,
 *   pantry: Record<string, any>,
 *   catalogue: Record<string, any> | null,
 *   store: string,
 *   region: { country?: string, state?: string } | undefined,
 *   budgetUsd: number,
 *   targets: Record<string, any> | null,
 *   fromDate?: string,
 *   today?: string,
 *   bankById?: Map<string, any>,
 *   maxSwaps?: number
 * }} args
 * @returns {{
 *   plan: Record<string, any>,
 *   fits: boolean,
 *   ran: boolean,
 *   eaten: number,
 *   startedAt: number,
 *   budget: number,
 *   over: number,
 *   swaps: { date: string, slot: string, from: string, to: string, saved: number }[],
 *   reason: string
 * }}
 */
export function swapToFit(args) {
  const {
    recipes,
    recipesById,
    pantry,
    catalogue,
    store,
    region,
    budgetUsd,
    targets,
    fromDate,
    today,
    bankById,
    // measured on the live bank: the search runs out of legal moves at 20 to
    // 23 swaps, so a cap of 30 is a runaway guard rather than a real limit
    maxSwaps = 30,
  } = args;
  let plan = args.plan;

  const price = (/** @type {Record<string, any>} */ p) =>
    priceWeek(p, recipesById, pantry, catalogue, store, region, fromDate, bankById);

  const budget = Number(budgetUsd);
  const first = price(plan);
  const startedAt = first.eaten;
  /** @type {{ date: string, slot: string, from: string, to: string, saved: number }[]} */
  const swaps = [];

  // A profile with no budget is not over budget. Silence is correct here: the
  // number is optional and inventing one would be the invented-person bug in
  // another costume.
  if (!(budget > 0)) {
    return {
      plan,
      fits: true,
      ran: false,
      eaten: startedAt,
      startedAt,
      budget: 0,
      over: 0,
      swaps,
      reason: "no weekly budget set on this profile, so nothing to fit",
    };
  }

  const floors = enforcedFloors(targets?.macros);
  const ceiling = enforcedCeilings(targets?.macros).calories;

  // Per-serving cost of every recipe in the pool, computed once. This is the
  // ranking signal; the real shopping list is what decides, because pack sizes
  // and pantry overlap mean a cheaper recipe can still cost more to buy for.
  /** @type {Map<string, number>} */
  const perServing = new Map();
  const costOf = (/** @type {string} */ id) => {
    if (perServing.has(id)) return /** @type {number} */ (perServing.get(id));
    const r = recipesById.get(id);
    const c = r ? recipeServingCost(r, /** @type {any} */ (catalogue), store).perServing : 0;
    perServing.set(id, c);
    return c;
  };

  let eaten = startedAt;
  let exhausted = false;
  while (eaten > budget && swaps.length < maxSwaps) {
    /** @type {{ entry: any, to: string, est: number }[]} */
    const candidates = [];
    for (const e of plan.entries ?? []) {
      if (!swappable(e, today)) continue;
      const from = recipesById.get(e.recipeId);
      if (!from) continue;
      const current = costOf(e.recipeId);
      for (const r of recipes) {
        if (r.id === e.recipeId) continue;
        if (r.mealType !== from.mealType) continue;
        // CHEAPER IS NOT ENOUGH, and this is the whole difficulty of the
        // promise. The cheapest recipes in any bank are the smallest ones, so
        // ranking on price alone fills the candidate list with meals that
        // shrink the day under its own floor and get rejected one by one,
        // burning the search on swaps that could never have been kept. Only
        // consider a candidate that carries roughly the same food: the saving
        // has to come from cheaper INGREDIENTS, not from less dinner.
        // The band is two-sided as of 2026-08-23. It used to have a floor
        // only, so "keeps roughly the same food" permitted UNBOUNDED protein
        // increases, and since cheap-per-calorie food in this bank is
        // disproportionately protein-dense (beans, eggs, yogurt, edamame)
        // optimising for price walked straight toward protein: measured
        // 1,661 g to 1,701 g across 20 swaps. The budget pass and the protein
        // ceiling were fighting and neither knew the other existed.
        const keeps =
          (r.nutrition?.calories ?? 0) >= (from.nutrition?.calories ?? 0) * 0.9 &&
          (r.nutrition?.protein ?? 0) >= (from.nutrition?.protein ?? 0) * 0.9 &&
          (r.nutrition?.protein ?? 0) <= (from.nutrition?.protein ?? 0) * 1.1;
        if (!keeps) continue;
        const est = (current - costOf(r.id)) * (Number(e.servings) || 1);
        if (est > 0.01) candidates.push({ entry: e, to: r.id, est });
      }
    }
    candidates.sort((a, b) => b.est - a.est);

    let applied = false;
    for (const c of candidates.slice(0, 40)) {
      const next = {
        ...plan,
        entries: plan.entries.map((/** @type {any} */ e) =>
          e.id === c.entry.id ? { ...e, recipeId: c.to } : e,
        ),
      };
      // never buy the budget with a broken promise
      if (breaksDay(next.entries, recipesById, c.entry.date, floors, ceiling)) continue;
      // and never buy it with MORE protein than it started with. The ceiling
      // is a money number (P5) and protein is the most expensive macro, so a
      // "saving" that raises the protein bill is a saving in one column and a
      // cost in another. Bought protein only, since a swipe's grams are free
      // and were never on this bill.
      if (
        dayBought(next.entries, recipesById, c.entry.date) >
        dayBought(plan.entries, recipesById, c.entry.date) + 0.01
      ) {
        continue;
      }
      const after = price(next);
      // the ranking is an estimate; the shopping list is the truth. A swap
      // that does not actually reduce the bill is not a saving, it is churn.
      if (after.eaten >= eaten - 0.01) continue;
      swaps.push({
        date: c.entry.date,
        slot: c.entry.slot,
        from: recipesById.get(c.entry.recipeId)?.name ?? c.entry.recipeId,
        to: recipesById.get(c.to)?.name ?? c.to,
        saved: Math.round((eaten - after.eaten) * 100) / 100,
      });
      plan = next;
      eaten = after.eaten;
      applied = true;
      break;
    }
    if (!applied) {
      exhausted = true;
      break;
    }
  }

  const fits = eaten <= budget;
  const over = Math.round(Math.max(0, eaten - budget) * 100) / 100;
  return {
    plan,
    fits,
    ran: true,
    eaten: Math.round(eaten * 100) / 100,
    startedAt: Math.round(startedAt * 100) / 100,
    budget,
    over,
    swaps,
    reason: fits
      ? swaps.length === 0
        ? "the week was already inside the budget"
        : `${swaps.length} swap${swaps.length === 1 ? "" : "s"} brought the week inside the budget`
      : exhausted
        ? `no further swap fits without breaking a floor or a ceiling: still $${over.toFixed(2)} over`
        : `stopped after ${maxSwaps} swaps: still $${over.toFixed(2)} over`,
  };
}
