// Weekly plan operations (plans/<week>.json). Entries are keyed by
// date+slot — the same key mergeFieldWise uses, so two devices editing
// different slots merge cleanly.
import { isoWeekId } from "./dates.js";

/**
 * @typedef {{ date: string, slot: string, recipeId?: string, freeText?: string, servings: number }} PlanEntry
 * @typedef {{ week: string, entries: PlanEntry[] }} Plan
 */

/**
 * Monday..Sunday ISO dates of an ISO week id like "2026-W28".
 * @param {string} weekId
 * @returns {string[]}
 */
export function datesOfWeek(weekId) {
  const m = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return [];
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  // ISO 8601: week 1 contains Jan 4; weeks start Monday
  const jan4 = new Date(isoYear, 0, 4);
  const week1Monday = new Date(isoYear, 0, 4 - ((jan4.getDay() + 6) % 7));
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(week1Monday);
    d.setDate(week1Monday.getDate() + (week - 1) * 7 + i);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    out.push(`${d.getFullYear()}-${mm}-${dd}`);
  }
  return out;
}

/**
 * ISO week id shifted by n weeks — derived from datesOfWeek/isoWeekId so the
 * week-1 math lives in exactly one place.
 * @param {string} weekId
 * @param {number} delta
 * @returns {string}
 */
export function shiftWeek(weekId, delta) {
  const monday = datesOfWeek(weekId)[0];
  const d = new Date(`${monday}T12:00:00`);
  d.setDate(d.getDate() + delta * 7);
  return isoWeekId(d);
}

/**
 * Set what's planned for one date+slot (replacing anything already there).
 * Pure — returns a new plan.
 * @param {Plan} plan
 * @param {string} date
 * @param {string} slot
 * @param {{ recipeId?: string, freeText?: string, servings: number }} entry
 * @returns {Plan}
 */
export function setEntry(plan, date, slot, entry) {
  return {
    ...plan,
    entries: [
      ...plan.entries.filter((e) => !(e.date === date && e.slot === slot)),
      { date, slot, ...entry },
    ],
  };
}

/**
 * @param {Plan} plan
 * @param {string} date
 * @param {string} slot
 * @returns {Plan}
 */
export function removeEntry(plan, date, slot) {
  return {
    ...plan,
    entries: plan.entries.filter((e) => !(e.date === date && e.slot === slot)),
  };
}

/**
 * Planned calories/protein for one day. freeText and unknown recipes count 0.
 * @param {PlanEntry[]} entries
 * @param {Map<string, any>} recipesById
 * @param {string} date
 * @returns {{ calories: number, protein: number }}
 */
export function dayTotals(entries, recipesById, date) {
  let calories = 0;
  let protein = 0;
  for (const e of entries) {
    if (e.date !== date || !e.recipeId) continue;
    const n = recipesById.get(e.recipeId)?.nutrition;
    if (!n) continue;
    calories += (n.calories ?? 0) * e.servings;
    protein += (n.protein ?? 0) * e.servings;
  }
  return { calories, protein };
}
