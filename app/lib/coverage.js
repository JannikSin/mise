// The fluid week's one governing rule (canon P4, fix list 7.2): shopping
// locks the INGREDIENTS, never the plan — the plan may be reshaped freely so
// long as every bought perishable still has a home before it dies. This
// module is that check: pure, derived at render time on every plan edit,
// never stored.

import { pantryItems, isDatedItem, perishableStatus } from "./shopping.js";
import { canonicalFood } from "./ingredients.js";

/** @typedef {{ id: string, food: string, goodUntil: string, daysLeft: number }} CoverageGap */

/**
 * Dated pantry perishables with no home in the CURRENT plan: nothing
 * scheduled to cook them (by canonical food key) between today and the day
 * they expire. Freezer rows are exempt — frozen food's window is months and
 * a freezer full of backup protein is stock, not a countdown.
 *
 * A perishable "has a home" when some not-yet-cooked, not-out entry dated
 * inside its window uses it as an ingredient. Already-expired rows are the
 * waste ledger's business (expirePerishables), not a gap this check can
 * still save.
 * @param {import("./plan.js").Plan} plan the plan AS IT STANDS
 * @param {Record<string, any>[]} recipes resolved pool (bank + own)
 * @param {Record<string, any>} pantry
 * @param {string} todayIso
 * @returns {{ gaps: CoverageGap[], checked: number }}
 */
export function perishableCoverage(plan, recipes, pantry, todayIso) {
  /** @type {Map<string, Record<string, any>>} */
  const byId = new Map();
  for (const r of recipes ?? []) if (r?.id) byId.set(r.id, r);
  /** @type {{ key: string, date: string }[]} */
  const uses = [];
  for (const e of plan?.entries ?? []) {
    if (e.cookedAt || e.out || !e.recipeId || !e.date) continue;
    if (e.date < todayIso) continue;
    const r = byId.get(e.recipeId);
    if (!r) continue;
    for (const ing of r.ingredients ?? []) {
      uses.push({ key: canonicalFood(String(ing.food ?? "")), date: e.date });
    }
  }
  /** @type {CoverageGap[]} */
  const gaps = [];
  let checked = 0;
  for (const it of pantryItems(pantry)) {
    if (!isDatedItem(it)) continue;
    if (it.location === "freezer") continue;
    const { goodUntil, daysLeft } = perishableStatus(it, todayIso);
    if (goodUntil == null || daysLeft == null || daysLeft < 0) continue;
    checked += 1;
    const key = canonicalFood(String(it.food ?? ""));
    if (!uses.some((u) => u.key === key && u.date <= goodUntil)) {
      gaps.push({ id: it.id, food: it.food, goodUntil, daysLeft });
    }
  }
  gaps.sort((a, b) => a.daysLeft - b.daysLeft);
  return { gaps, checked };
}
