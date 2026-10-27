// HOUSE RECIPES IN THE POOL (Mise 2.0, plan section 5, ENG 3 and ENG L2-4,
// item E2; serves P2 decided and P12 bank).
//
// On Supabase an AI dinner special is its house's
// (`households/<house>/recipes/house-<12 hex>.json`, house-special.js). So the
// recipe pool is the shared bank plus every house of mine. A plan entry or a
// table can still carry a `house-` id this phone cannot resolve: a dish from a
// house I am not in (a guest's plan, a shared table), or a row that never came
// down whole. That dish stays OUT of every pool, so the existing "missing
// recipe" paths run unchanged: it carries no macros (dayTotals skips it), it
// is never auto-planned, and every allergy screen refuses it with "the dish
// could not be found" (tables.js seatScreen). Only its label changes: it shows
// as "a house dish", never as its opaque id.

import { isHouseRecipeId } from "./house-special.js";

const HOUSE_SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;

/** What an unresolvable house dish is called on screen. */
export const HOUSE_DISH = "a house dish";

/**
 * The houses whose recipes this person's pool reads, from the roster as
 * `roster()` serves it on Supabase: the home house (`household`), plus the
 * family house (`family`), which roster() shows a member only when they
 * belong to the house that value names (plan 4.2, RT N2). A value that is not
 * a plain slug reads nothing.
 * @param {Record<string, any>[] | undefined} profiles
 * @param {string} me
 * @returns {string[]}
 */
export function myHouses(profiles, me) {
  const mine = (profiles ?? []).find((p) => p?.id === me);
  if (!mine) return [];
  /** @type {string[]} */
  const out = [];
  for (const h of [mine.household, mine.family]) {
    if (typeof h === "string" && HOUSE_SLUG.test(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

/**
 * The recipe directories the pool reads beyond the bank. None on GitHub: in
 * 1.95 a special is a bank recipe, so there is nothing else to list.
 * @param {"github" | "supabase"} backendName
 * @param {Record<string, any>[] | undefined} profiles
 * @param {string} me
 * @returns {string[]}
 */
export function houseRecipeDirs(backendName, profiles, me) {
  if (backendName !== "supabase") return [];
  return myHouses(profiles, me).map((h) => `households/${h}/recipes`);
}

/**
 * A house recipe this phone holds whole: something to cook from (ingredients)
 * and its macros. FAIL CLOSED: anything less resolves as missing, because a
 * row with no ingredients passes every allergen screen and a row with no
 * nutrition would be planned as free food.
 * @param {Record<string, any> | null | undefined} r
 * @returns {boolean}
 */
export function wholeHouseRecipe(r) {
  if (!r || !isHouseRecipeId(String(r.id ?? ""))) return false;
  if (!Array.isArray(r.ingredients) || r.ingredients.length === 0) return false;
  return Boolean(r.nutrition && typeof r.nutrition === "object");
}

/**
 * The bank plus my houses' recipes. A bank row wins over a house row with the
 * same id (a promoted special is the admin's bank copy). House rows are kept
 * only when they carry an opaque id and are whole.
 * @param {Record<string, any>[]} bank
 * @param {Record<string, any>[][]} houseLists one list per house directory
 * @returns {Record<string, any>[]}
 */
export function withHouseRecipes(bank, houseLists) {
  const seen = new Set(bank.map((r) => r.id));
  const out = [...bank];
  for (const list of houseLists) {
    for (const r of list) {
      if (!wholeHouseRecipe(r)) continue;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out.length === bank.length ? bank : out;
}

/**
 * The label for a dish id that resolved in no pool: "a house dish" for an
 * opaque house id, otherwise null (the caller's 1.95 fallback stands).
 * @param {string | null | undefined} id
 * @returns {string | null}
 */
export function houseDishName(id) {
  return isHouseRecipeId(String(id ?? "")) ? HOUSE_DISH : null;
}

/**
 * PROMOTE is the admin's (plan section 5). It writes the bank path, so on
 * Supabase it goes through write_doc's admin check and the bank name guard
 * like any bank write. On GitHub (no session) it is 1.95, unchanged.
 * @param {{ name: string, session(): { admin: boolean } | null }} b
 * @returns {boolean}
 */
export function mayPromote(b) {
  return b.name !== "supabase" || b.session()?.admin === true;
}
