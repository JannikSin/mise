// Shopping list derivation (blueprint §5.4): aggregate the week's plan
// ingredients (scaled to planned servings), merge duplicates, drop staples,
// add running-low pantry staples, group by store section. Regeneration
// preserves check-state and manual items.

/**
 * @typedef {{ id: string, food: string, qty: number, unit: string, section: string, checked: boolean, manual: boolean, fromRecipes?: string[] }} ShoppingItem
 * @typedef {{ generatedFrom?: string, items: ShoppingItem[] }} ShoppingList
 */

/** Keyword → store section. First match wins; extend as real foods appear. */
const SECTIONS = [
  ["frozen", /\bfrozen\b/], // before produce: "frozen mixed vegetables" is a frozen-aisle item
  ["meat", /\b(beef|chicken|pork|lamb|turkey|thigh|breast|steak|mince)\b/],
  ["dairy", /\b(milk|kefir|yogurt|cheese|butter|cream|cottage|parmesan|brie|egg|eggs)\b/],
  [
    "produce",
    /\b(onion|garlic|tomato|cucumber|cabbage|spinach|broccoli|mushroom|lemon|lime|ginger|avocado|[a-z]*berr(y|ies)|potato|beans|shallot|herb|parsley|cilantro|scallion|lettuce|carrot|celery|bell pepper|apple|banana|fruit|greens|vegetables?)\b/,
  ],
  ["spices", /\b(cayenne|paprika|salt|peppercorn|cumin|coriander|spice|saffron|oregano|thyme)\b/],
  [
    "dry-goods",
    /\b(rice|oats|pasta|noodle|flour|sugar|oil|vinegar|soy|sauce|broth|stock|tuna|can|lentil|bread|sourdough|honey|peanut butter|whey)\b/,
  ],
];

/**
 * @param {string} food
 * @returns {string}
 */
export function sectionOf(food) {
  const f = food.toLowerCase();
  for (const [section, re] of SECTIONS) {
    if (/** @type {RegExp} */ (re).test(f)) return /** @type {string} */ (section);
  }
  return "other";
}

/** @param {string} food */
export function slug(food) {
  return food
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * @param {import("./plan.js").Plan} plan
 * @param {Map<string, any>} recipesById
 * @param {Record<string, any>} pantry
 * @param {ShoppingList | null} [previous]
 * @returns {ShoppingList}
 */
export function deriveShoppingList(plan, recipesById, pantry, previous) {
  /** @type {Map<string, ShoppingItem>} */
  const merged = new Map();

  /** food slugs the plan already shops, any unit (suppresses running-low dupes) */
  const shoppedFoods = new Set();
  // the documented contract (docs/SCHEMAS.md): subtract pantry onHand staples
  // by name — this is what makes P+ ("I already own this") stick across builds.
  // A running-low staple is NOT subtracted: it needs buying.
  const onHandSlugs = new Set(
    (pantry.staples ?? [])
      .filter((/** @type {any} */ s) => s.onHand && !s.runningLow)
      .flatMap((/** @type {any} */ s) => [s.id, slug(s.name)]),
  );

  for (const entry of plan.entries) {
    if (!entry.recipeId) continue;
    const recipe = recipesById.get(entry.recipeId);
    if (!recipe) continue;
    const perServing = entry.servings / (recipe.servings || 1);
    for (const ing of recipe.ingredients ?? []) {
      if (ing.staple || onHandSlugs.has(slug(ing.food))) continue;
      // id is unit-aware: the same food in two units must be two distinct
      // items, or toggles and 409 merges (id-keyed) collapse them
      const id = `${slug(ing.food)}-${slug(ing.unit)}`;
      const existing = merged.get(id);
      const qty = ing.qty * perServing;
      shoppedFoods.add(slug(ing.food));
      if (existing) {
        existing.qty += qty;
        if (!existing.fromRecipes?.includes(recipe.id)) existing.fromRecipes?.push(recipe.id);
      } else {
        merged.set(id, {
          id,
          food: ing.food,
          qty,
          unit: ing.unit,
          section: sectionOf(ing.food),
          checked: false,
          manual: false,
          fromRecipes: [recipe.id],
        });
      }
    }
  }

  // pantry staples flagged running-low re-enter the list — unless the week's
  // recipes already put that food on it
  for (const s of pantry.staples ?? []) {
    if (!s.runningLow || shoppedFoods.has(slug(s.name))) continue;
    const id = `${slug(s.name)}-x`;
    if (!merged.has(id)) {
      merged.set(id, {
        id,
        food: s.name,
        qty: 1,
        unit: "x",
        section: s.section ?? sectionOf(s.name),
        checked: false,
        manual: false,
      });
    }
  }

  // regeneration keeps check-state and manual items
  for (const prev of previous?.items ?? []) {
    if (prev.manual) {
      if (!merged.has(prev.id)) merged.set(prev.id, prev);
    } else if (prev.checked) {
      const item = merged.get(prev.id) ?? [...merged.values()].find((i) => i.id === prev.id);
      if (item) item.checked = true;
    }
  }

  // rounding happens here, AFTER all merging/summing above — round-then-sum
  // would inflate totals (two 0.3-each requirements would ceil to 1+1=2
  // instead of the correct sum-then-ceil(0.6)=1)
  const items = [...merged.values()].map((i) => {
    const { qty, unit } = roundForPurchase(i.qty, i.unit);
    return { ...i, qty, unit };
  });
  items.sort((a, b) => a.section.localeCompare(b.section) || a.food.localeCompare(b.food));
  return { generatedFrom: plan.week, items };
}

/** Units bought as whole discrete items — never a fraction of one. */
const COUNTABLE_UNITS = new Set([
  "each",
  "clove",
  "cloves",
  "can",
  "cans",
  "slice",
  "slices",
  "pita",
  "pitas",
  "egg",
  "eggs",
]);

/**
 * Round a summed quantity up to an amount you can actually buy in a store.
 * Always rounds UP (better a little extra than short mid-recipe) and never
 * rounds a nonzero quantity down to zero. Unit is preserved as-is except for
 * the g→kg and ml→L promotions at the 1000 threshold.
 * @param {number} qty
 * @param {string} unit
 * @returns {{ qty: number, unit: string }}
 */
export function roundForPurchase(qty, unit) {
  const u = unit.toLowerCase().trim();
  if (COUNTABLE_UNITS.has(u)) return { qty: Math.ceil(qty), unit };
  if (u === "g") {
    if (qty < 100) return { qty: ceilStep(qty, 10), unit };
    if (qty < 1000) return { qty: ceilStep(qty, 25), unit };
    return { qty: ceilStep(qty / 1000, 0.1), unit: "kg" };
  }
  if (u === "ml") {
    if (qty < 100) return { qty: ceilStep(qty, 10), unit };
    if (qty < 1000) return { qty: ceilStep(qty, 50), unit };
    return { qty: ceilStep(qty / 1000, 0.1), unit: "l" };
  }
  if (u === "cup" || u === "cups" || u === "tbsp" || u === "tsp") {
    return { qty: ceilStep(qty, 0.25), unit };
  }
  if (u === "lb" || u === "lbs") return { qty: ceilStep(qty, 0.25), unit };
  if (u === "oz") return { qty: ceilStep(qty, 1), unit };
  return { qty: ceilStep(qty, 0.1), unit };
}

/**
 * Ceil qty to the nearest multiple of step, guarding against float dust.
 * @param {number} qty
 * @param {number} step
 * @returns {number}
 */
function ceilStep(qty, step) {
  return Math.round(Math.ceil((qty - 1e-9) / step) * step * 1e6) / 1e6;
}

/**
 * "I already have this — permanently": a list item becomes (or refreshes) a
 * pantry staple with onHand true and leaves the list. For the found-it-in-
 * the-cupboard case; plain ticking covers "have enough for this week".
 * @param {ShoppingList} shopping
 * @param {Record<string, any>} pantry
 * @param {string} itemId
 * @returns {{ shopping: ShoppingList, pantry: Record<string, any> }}
 */
export function ownItemToPantry(shopping, pantry, itemId) {
  const item = shopping.items.find((i) => i.id === itemId);
  if (!item) return { shopping, pantry };
  const foodSlug = slug(item.food);
  const staples = [...(pantry.staples ?? [])];
  const existing = staples.findIndex((s) => s.id === foodSlug || slug(s.name) === foodSlug);
  if (existing >= 0) {
    staples[existing] = { ...staples[existing], onHand: true, runningLow: false };
  } else {
    staples.push({
      id: foodSlug,
      name: item.food,
      section: item.section,
      onHand: true,
      runningLow: false,
    });
  }
  return {
    // owning a food clears EVERY row of it, whatever the unit
    shopping: { ...shopping, items: shopping.items.filter((i) => slug(i.food) !== foodSlug) },
    pantry: { ...pantry, staples },
  };
}

/**
 * "Just bought": checked items leave the list; staples flip onHand, anything
 * else lands in pantry perishables with today's date.
 * @param {ShoppingList} shopping
 * @param {Record<string, any>} pantry
 * @param {string} today ISO date
 * @returns {{ shopping: ShoppingList, pantry: Record<string, any> }}
 */
export function applyJustBought(shopping, pantry, today) {
  const bought = shopping.items.filter((i) => i.checked);
  const staples = (pantry.staples ?? []).map((/** @type {any} */ s) => {
    const hit = bought.find((b) => b.id === s.id || slug(b.food) === slug(s.name));
    return hit ? { ...s, onHand: true, runningLow: false } : s;
  });
  const stapleIds = new Set(staples.map((/** @type {any} */ s) => s.id));
  const stapleSlugs = new Set(staples.map((/** @type {any} */ s) => slug(s.name)));
  const newPerishables = bought
    .filter((b) => !stapleIds.has(b.id) && !stapleSlugs.has(slug(b.food)))
    .map((b) => ({ food: b.food, qty: `${b.qty} ${b.unit}`, added: today }));
  return {
    shopping: { ...shopping, items: shopping.items.filter((i) => !i.checked) },
    pantry: {
      ...pantry,
      staples,
      perishables: [...(pantry.perishables ?? []), ...newPerishables],
    },
  };
}
