// Portion-aware cooking: the fix for "the recipe served 2, I ate both and
// overate." A recipe's `servings` is how many portions the full recipe makes;
// a plan entry's `servings` is how many the person actually eats at that slot.
// When those differ, either scale the cook down to the meal (everyday recipes)
// or cook the batch and bank the rest (soups/chili that are meant to repeat).

/** Tags (or effort) that mark a recipe as a deliberate make-ahead batch. */
const BATCH_TAGS = new Set(["batch-friendly", "freezes-well", "meal-prep", "leftover-remix"]);

/**
 * Is this recipe MEANT to make several meals at once (cook full, eat over
 * days) rather than be cooked fresh per meal?
 * @param {Record<string, any>} recipe
 * @returns {boolean}
 */
export function isBatchRecipe(recipe) {
  if (recipe?.effort === "project") return true;
  return (recipe?.tags ?? []).some((/** @type {string} */ t) => BATCH_TAGS.has(t));
}

/**
 * Scale one ingredient quantity to a serving ratio, rounded for a cook (not a
 * shopping list): 2 decimals, and countable whole-item units (egg, clove,
 * can, pita, slice) never go below a sensible half.
 * @param {number} qty
 * @param {string} unit
 * @param {number} ratio
 * @returns {number}
 */
export function scaleQty(qty, unit, ratio) {
  const scaled = qty * ratio;
  const u = (unit ?? "").toLowerCase().trim();
  const countable = ["egg", "eggs", "clove", "cloves", "can", "cans", "pita", "pitas", "slice", "slices"];
  if (countable.includes(u)) {
    // round to the nearest 0.5, but never vanish a real ingredient to 0
    const r = Math.round(scaled * 2) / 2;
    return r === 0 && qty > 0 ? 0.5 : r;
  }
  return Math.round(scaled * 100) / 100;
}

/**
 * What to actually cook for a planned portion count. Three modes:
 *  - "full": planned >= what the recipe makes (or cookbook browsing with no
 *    plan) → cook the recipe as written.
 *  - "batch": a make-ahead recipe eaten one portion now → cook the FULL batch,
 *    eat `planned`, save the rest (the plan schedules the leftover days).
 *  - "single": an everyday recipe eaten below its yield → scale the
 *    ingredients DOWN to exactly the meal, so there is nothing extra to overeat.
 * @param {Record<string, any>} recipe
 * @param {number} [plannedServings] portions eaten at this slot; omit = cook full
 * @returns {{
 *   mode: "full" | "batch" | "single",
 *   cookServings: number,
 *   eatServings: number,
 *   extraServings: number,
 *   ingredients: Record<string, any>[],
 *   note: string
 * }}
 */
export function cookPlan(recipe, plannedServings) {
  const makes = Math.max(1, Number(recipe?.servings) || 1);
  const eat = plannedServings && plannedServings > 0 ? plannedServings : makes;
  const ingredients = recipe?.ingredients ?? [];

  // cooking the whole thing (or more): no scaling, no leftover math
  if (eat >= makes) {
    return {
      mode: "full",
      cookServings: makes,
      eatServings: eat,
      extraServings: 0,
      ingredients,
      note: makes > 1 ? `Makes ${makes} servings — you're eating all of it.` : "",
    };
  }

  const extra = Math.round((makes - eat) * 100) / 100;

  if (isBatchRecipe(recipe)) {
    return {
      mode: "batch",
      cookServings: makes,
      eatServings: eat,
      extraServings: extra,
      ingredients, // cook the full batch on purpose
      note:
        `Batch: makes ${makes}. Eat ${eat} now, save the other ${extra} for later days. ` +
        `Don't eat the extra tonight — the plan schedules it as leftovers.`,
    };
  }

  // everyday recipe: shrink it to exactly the meal
  const ratio = eat / makes;
  return {
    mode: "single",
    cookServings: eat,
    eatServings: eat,
    extraServings: 0,
    ingredients: ingredients.map((/** @type {Record<string, any>} */ i) => ({
      ...i,
      qty: scaleQty(Number(i.qty) || 0, i.unit, ratio),
    })),
    note: `Scaled to your meal (${eat} serving${eat === 1 ? "" : "s"}). Cook only this much, nothing extra to overeat.`,
  };
}
