// WHO'S EATING (P3, P8; David, 2026-11-24: "adding a person adds a
// generalized serving... but in reality... type name and it takes the
// persons profile and adds more in conjunnction with that").
//
// The recipe page's COOK FOR, by people instead of a bare number. A profile
// counts its REAL portion of this dish at this meal (seatServingsFor: their
// own day's calories, this meal's share of it, over the dish's calories per
// portion), the same rule tables and the brigade already plate by. A typed
// name with no profile counts one portion. Anyone the allergy and diet
// screen refuses, or whose profile cannot be read, is named and NOT counted
// (fail closed, as seatScreen does everywhere else). Nothing is written.
import { seatScreen, seatServingsFor } from "./tables.js";

/**
 * @typedef {{ id: string, name: string, guest?: boolean, targets?: Record<string, any> | null }} Eater
 * @typedef {{ id: string, name: string, portions: number, kcal: number | null, protein: number | null, blocked: string[] }} EaterRow
 */

/**
 * @param {Record<string, any>} recipe
 * @param {Eater[]} eaters
 * @returns {{ rows: EaterRow[], total: number, cookPortions: number }}
 */
export function whoIsEating(recipe, eaters) {
  const slot = typeof recipe?.mealType === "string" ? recipe.mealType : "dinner";
  const kcal = Number(recipe?.nutrition?.calories) || 0;
  const protein = Number(recipe?.nutrition?.protein) || 0;
  const rows = eaters.map((e) => {
    const blocked = e.guest ? [] : seatScreen(recipe, e.targets ?? null);
    const portions =
      blocked.length > 0 ? 0 : e.guest ? 1 : seatServingsFor(e.targets ?? undefined, slot, recipe);
    return {
      id: e.id,
      name: e.name,
      portions,
      kcal: kcal > 0 && portions > 0 ? Math.round(kcal * portions) : null,
      protein: protein > 0 && portions > 0 ? Math.round(protein * portions) : null,
      blocked,
    };
  });
  const total = rows.reduce((s, r) => s + r.portions, 0);
  // the pot is cooked in whole portions of the recipe; round UP so nobody's
  // plate is the one that comes up short
  return { rows, total, cookPortions: total > 0 ? Math.ceil(total - 1e-9) : 0 };
}

/** "1.75 portions" / "1 portion" */
export function portionsLabel(/** @type {number} */ n) {
  return `${n} portion${n === 1 ? "" : "s"}`;
}
