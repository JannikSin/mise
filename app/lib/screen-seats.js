// SEAT AND OCCASION SCREENS, fail closed on a missing dish (P8, terrigen
// 2026-10-27). Both main.js handlers used to return "no reasons" for a recipe
// they could not find, so an unresolved dish (a house dish this phone cannot
// read, a deleted bank recipe) screened as safe for every diner. seatScreen
// already refuses a missing dish; these loops now let it.

import { seatScreen } from "./tables.js";

/**
 * Per-profile reasons not to seat each person on one dish.
 * @param {Record<string, any> | null | undefined} recipe
 * @param {Record<string, any>[]} profiles each with a string `id`
 * @param {(id: string) => Promise<any>} readTargets resolves null on a failed read
 * @returns {Promise<Record<string, string[]>>}
 */
export async function screenSeats(recipe, profiles, readTargets) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const p of profiles) out[p.id] = seatScreen(recipe, await readTargets(p.id));
  return out;
}

/**
 * recipeId -> reasons for one person's occasion candidates; clean ids are
 * omitted, a missing dish is never clean.
 * @param {string[]} recipeIds
 * @param {Map<string, Record<string, any>>} byId
 * @param {any} targets null when the person's targets could not be read
 * @returns {Record<string, string[]>}
 */
export function screenOccasion(recipeIds, byId, targets) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const id of new Set(recipeIds)) {
    const reasons = seatScreen(byId.get(id), targets);
    if (reasons.length > 0) out[id] = reasons;
  }
  return out;
}
