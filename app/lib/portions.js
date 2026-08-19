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
  const countable = [
    "egg",
    "eggs",
    "clove",
    "cloves",
    "can",
    "cans",
    "pita",
    "pitas",
    "slice",
    "slices",
    // whole discrete items: 2.88 broccoli crowns is not a thing a cook does
    "each",
    "x",
  ];
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
 *   mode: "full" | "batch" | "single" | "scaled",
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

  // cooking MORE than the recipe makes (a family-dinner batch: 5.75 servings
  // of a 2-serving recipe): scale every ingredient UP so the cook reads real
  // amounts, never "the recipe ×2.9 in your head" (David, 2026-08-03)
  if (eat > makes) {
    const ratio = eat / makes;
    return {
      mode: "scaled",
      cookServings: eat,
      eatServings: eat,
      extraServings: 0,
      ingredients: ingredients.map((/** @type {Record<string, any>} */ i) => ({
        ...i,
        qty: scaleQty(Number(i.qty) || 0, i.unit, ratio),
      })),
      note: `Amounts below are the WHOLE POT for everyone eating. Cook this much; each person's own plate comes off it.`,
    };
  }

  // cooking exactly the whole thing: no scaling, no leftover math
  if (eat === makes) {
    return {
      mode: "full",
      cookServings: makes,
      eatServings: eat,
      extraServings: 0,
      ingredients,
      note: "",
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
        `Cook the whole batch. Eat your plate now and put the rest in the fridge — ` +
        `the plan has already scheduled it as leftovers, so don't eat the extra tonight.`,
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
    note: "Amounts below are YOUR plate. Cook only this much, so there is nothing extra to overeat.",
  };
}

/**
 * THE LEFTOVER LEDGER (P7).
 *
 * The batch note above says "the plan has already scheduled it as leftovers,"
 * and until 2026-08-19 that sentence was not true of anything: the plan repeats
 * a recipe across days and NOTHING anywhere linked Monday's four-serving pot to
 * the Wednesday slot that eats from it. So P7's done test ("the plan states
 * which meals make extra, how many servings, and which later slot eats them,
 * with no orphan containers") had nothing to answer to, and the safe-window
 * clause added the same day had nothing to check, because there was no such
 * thing as a leftover slot to check.
 *
 * This derives that link rather than storing it, which is deliberate: a stored
 * link is a second copy of the plan that can disagree with the plan. Walking
 * the week in date order:
 *
 *   - the first slot on a batch recipe COOKS it, producing whole batches
 *   - each later slot within the dish's `safeDays` eats from what remains
 *   - a slot beyond that window, or one the pot cannot cover, starts a NEW cook
 *     and is reported as such, because the alternative is serving food past its
 *     window and calling it thrift
 *   - servings a cook makes that no later slot claims are ORPHANS, which is the
 *     waste P7 names and the failure the promise is actually about
 *
 * `safeDays` comes off the recipe. Its basis is USDA FSIS guidance for cooked
 * leftovers, 3 to 4 days refrigerated, the same figure the List view prints.
 * A recipe with no `safeDays` falls back to the conservative end rather than to
 * forever: an unknown window is a short window, never an unlimited one.
 * @param {{ entries?: Record<string, any>[] }} plan
 * @param {Map<string, any>} recipesById
 * @returns {{
 *   cooks: { recipeId: string, name: string, date: string, slot: string,
 *            makes: number, batches: number, eats: { date: string, slot: string, servings: number }[],
 *            orphanServings: number, safeDays: number }[],
 *   orphans: { recipeId: string, name: string, date: string, servings: number }[],
 *   reCooked: { recipeId: string, name: string, date: string, sinceCook: number, safeDays: number }[]
 * }}
 */
export function leftoverLedger(plan, recipesById) {
  const FALLBACK_SAFE_DAYS = 3;
  const dayOf = (/** @type {string} */ iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;

  /** @type {Record<string, Record<string, any>[]>} */
  const byRecipe = {};
  for (const e of plan?.entries ?? []) {
    if (!e.recipeId || e.out || e.table) continue;
    const r = recipesById.get(e.recipeId);
    if (!r || !isBatchRecipe(r)) continue; // only a batch dish leaves leftovers
    (byRecipe[e.recipeId] ??= []).push(e);
  }

  const cooks = [];
  const reCooked = [];
  for (const [recipeId, list] of Object.entries(byRecipe)) {
    const r = recipesById.get(recipeId);
    const makes = Math.max(1, Number(r.servings) || 1);
    const safeDays = Number(r.safeDays) > 0 ? Number(r.safeDays) : FALLBACK_SAFE_DAYS;
    const sorted = [...list].sort((a, b) =>
      a.date === b.date ? String(a.slot).localeCompare(String(b.slot)) : a.date < b.date ? -1 : 1,
    );
    /** @type {any} */
    let current = null;
    for (const e of sorted) {
      const want = Number(e.servings) || 1;
      const sinceCook = current ? dayOf(e.date) - dayOf(current.date) : Infinity;
      const inWindow = current && sinceCook <= safeDays;
      const covered = current && current.remaining >= want;
      if (inWindow && covered) {
        current.eats.push({ date: e.date, slot: e.slot, servings: want });
        current.remaining -= want;
        continue;
      }
      if (current && covered && !inWindow) {
        // the pot could have fed this slot; the calendar says it must not.
        reCooked.push({ recipeId, name: r.name ?? recipeId, date: e.date, sinceCook, safeDays });
      }
      const batches = Math.max(1, Math.ceil(want / makes));
      current = {
        recipeId,
        name: r.name ?? recipeId,
        date: e.date,
        slot: e.slot,
        makes: batches * makes,
        batches,
        remaining: batches * makes - want,
        eats: [{ date: e.date, slot: e.slot, servings: want }],
        safeDays,
      };
      cooks.push(current);
    }
  }

  cooks.sort((a, b) => (a.date === b.date ? a.recipeId.localeCompare(b.recipeId) : a.date < b.date ? -1 : 1));
  const orphans = [];
  for (const c of cooks) {
    c.orphanServings = Math.round(c.remaining * 100) / 100;
    delete c.remaining;
    if (c.orphanServings > 0) {
      orphans.push({ recipeId: c.recipeId, name: c.name, date: c.date, servings: c.orphanServings });
    }
  }
  return { cooks, orphans, reCooked };
}
