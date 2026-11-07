// BUY FOR THE MONTH (P5, P6; David, 2026-11-07: "if there are certain foods
// that for example keep for a month it is ok to then buy in bulk for better
// price at start of month and then pay less later when that is less cost
// sort of thing. you know so can buy 20 onions cause they dont go bad quick
// and then eat them throughout week").
//
// What was actually wrong: a 3 lb bag of onions bought for 2 onions went on
// the pantry as "2 each". The other six were invisible, so next week's List
// bought another bag, and the week after, another. At one store with one
// pack size, buying ahead only saves money if the kitchen REMEMBERS the rest
// of the package. So:
//
//   1. boughtQty: for a food that keeps a month or more where it is stored
//      (onions and garlic in the cupboard, rice and cans in the pantry, frozen
//      food in the freezer), ADD TO PANTRY and the receipt record the whole
//      package bought, not just this week's need. Later weeks' Lists take it
//      off (subtractPantryFromTrip), which is the "pay less later".
//   2. monthCover: the List says which rows cover more than this week, for
//      how many weeks (never past the food's shelf life or the month), and
//      what the later weeks no longer buy.
//   3. bulkPrepaid: the budget is AMORTIZED. The later weeks' share of those
//      packages is not this trip's food; the List judges the trip without it,
//      the spend row's cap is raised by it, and each later week carries its
//      share (plan.bulk, budget.js weekBudget), so the month never spends more
//      than its weeks' budgets and week one is not punished for buying ahead.
// Nothing that would spoil before it is eaten counts: under 28 days of shelf
// life where it is stored, a row is this week's food, as before. Pure.

import { itemCost, parsePackSize } from "./prices.js";
import { locationForBuy, sectionOf, shelfLifeDays } from "./shopping.js";
import { canonicalFood, toGrams } from "./ingredients.js";
import { parseLocalIso } from "./dates.js";

/** "Keeps for a month": the shortest shelf life a month buy may have. */
export const MONTH_DAYS = 28;

/**
 * Weeks from the trip date to the end of its month, this week included.
 * @param {string} tripIso YYYY-MM-DD
 * @returns {number}
 */
export function weeksLeftInMonth(tripIso) {
  const d = parseLocalIso(tripIso);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const days = Math.round((last.getTime() - d.getTime()) / 86400000) + 1;
  return Math.max(1, Math.ceil(days / 7));
}

/**
 * How long a List row's food keeps where it will be put away.
 * @param {{ food: string, section?: string }} row
 */
export function keepsDays(row) {
  return shelfLifeDays(row.food, locationForBuy(row.section ?? sectionOf(row.food), row.food));
}

/**
 * What a bought row puts on the shelf: the whole package for a food that
 * keeps a month, else null (the row's own need, as before).
 * @param {{ food: string, qty: number, unit: string, section?: string }} row
 * @param {any} catalogue
 * @param {string} store
 * @returns {string | null} e.g. "3 lb"
 */
export function boughtQty(row, catalogue, store) {
  if (!catalogue || !store || keepsDays(row) < MONTH_DAYS) return null;
  const c = itemCost({ food: row.food, qty: Number(row.qty), unit: row.unit }, catalogue, store);
  if (!c || c.estimate || !c.packs || !c.size) return null;
  const pack = parsePackSize(c.size);
  if (!pack || !(pack.qty > 0)) return null;
  const total = Math.round(c.packs * pack.qty * 100) / 100;
  return `${total} ${pack.unit}`;
}

/**
 * @typedef {{ id: string, food: string, weeks: number, cost: number, thisWeek: number, later: number, size: string }} MonthCover
 *   `weeks` this package covers at this week's need; `thisWeek` the eaten
 *   share; `later` the value of the later weeks' food in it (not stock past
 *   the month)
 */

/**
 * The List rows whose package covers more than this week.
 * @param {{ id: string, food: string, qty: number, unit: string, section?: string, manual?: boolean }[]} items
 * @param {any} catalogue
 * @param {string} store
 * @param {string} tripIso
 * @returns {{ covers: MonthCover[], later: number, perWeek: number, weeks: number, avoided: number }}
 *   `avoided`: what the later weeks would have spent buying these packages
 *   again had the rest of each package gone unrecorded (the old behavior),
 *   if those weeks need them too
 */
export function monthCover(items, catalogue, store, tripIso) {
  const left = weeksLeftInMonth(tripIso);
  /** @type {MonthCover[]} */
  const covers = [];
  if (left < 2 || !catalogue || !store) {
    return { covers, later: 0, perWeek: 0, weeks: left, avoided: 0 };
  }
  for (const it of items ?? []) {
    const qty = Number(it?.qty);
    if (!it || !(qty > 0) || !it.unit || it.unit === "x") continue;
    const keeps = keepsDays(it);
    if (keeps < MONTH_DAYS) continue;
    const c = itemCost({ food: it.food, qty, unit: it.unit }, catalogue, store);
    if (!c || c.estimate || !c.packs || !c.size) continue;
    const pack = parsePackSize(c.size);
    if (!pack) continue;
    const key = canonicalFood(it.food);
    const needG = toGrams(qty, it.unit, key);
    const packG = toGrams(c.packs * pack.qty, pack.unit, key);
    if (needG == null || packG == null || !(needG > 0)) continue;
    const weeks = Math.min(left, Math.floor(keeps / 7), Math.floor(packG / needG));
    if (weeks < 2) continue;
    const thisWeek = Math.min(c.cost, c.eaten);
    const later = Math.min(c.cost - thisWeek, thisWeek * (weeks - 1));
    if (!(later > 0.01)) continue;
    covers.push({
      id: it.id,
      food: it.food,
      weeks,
      cost: c.cost,
      thisWeek: Math.round(thisWeek * 100) / 100,
      later: Math.round(later * 100) / 100,
      size: `${c.packs} × ${c.size}`,
    });
  }
  covers.sort((a, b) => b.later - a.later);
  const later = Math.round(covers.reduce((a, c) => a + c.later, 0) * 100) / 100;
  // each later week's share: what the covers hold for one more week
  const perWeek = Math.round(covers.reduce((a, c) => a + c.later / (c.weeks - 1), 0) * 100) / 100;
  const weeks = covers.reduce((a, c) => Math.max(a, c.weeks), 0);
  const avoided = Math.round(covers.reduce((a, c) => a + c.cost * (c.weeks - 1), 0) * 100) / 100;
  return { covers, later, perWeek, weeks, avoided };
}

/**
 * The budget's view of a month buy: what of this trip is later weeks' food,
 * what each of those weeks carries, and for how many.
 * @param {ReturnType<typeof monthCover>} cover
 * @returns {{ prepaid: number, perWeek: number, weeks: number }}
 */
export function bulkPrepaid(cover) {
  return { prepaid: cover.later, perWeek: cover.perWeek, weeks: cover.weeks };
}
