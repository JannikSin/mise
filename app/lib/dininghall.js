// THE DINING-HALL TRAY COMPOSER (P10).
//
// Canon: "a dining-hall meal can be composed to a stated calorie and protein
// quota from live menu data." Nothing in the app referenced Purdue dining at
// all, so this half of P10 had no code behind it: an away meal could be
// declared and the day rebalanced around a flat estimate, but the meal itself
// could not be BUILT.
//
// The composer is pure and the network lives at the caller. That split matters
// here more than usual: the day endpoint carries no nutrition, so composing a
// real tray means fetching each candidate item, and a pure composer is the only
// way to test the promise without a live dining hall.
//
// TWO RULES CARRIED IN FROM ELSEWHERE.
//
//   1. P3's obligation, recorded on this promise when the menu screen shipped:
//      the moment a composed tray can enter the plan, it must be screened
//      against declared allergens. Purdue publishes a per-item allergen table,
//      which is better data than a photographed menu gives, and it is used
//      here as a hard screen rather than a note.
//   2. The court-serving caveat, loud. A dining court portion is whatever the
//      server puts on the plate. Every number this returns is an estimate of
//      an estimate, and the composer says so rather than quoting a tray to the
//      calorie and letting the Plan tab imply precision it does not have.

/** Purdue's allergen labels, mapped to the preset ids in targets.js. */
const ALLERGEN_ALIASES = /** @type {Record<string, string>} */ ({
  eggs: "eggs",
  fish: "fish",
  gluten: "gluten",
  milk: "dairy",
  peanuts: "peanuts",
  sesame: "sesame",
  shellfish: "shellfish",
  soy: "soy",
  "tree nuts": "nuts",
  coconut: "nuts",
  wheat: "gluten",
});

/** The live day-menu endpoint for one dining court. */
export const menuUrlFor = (/** @type {string} */ location, /** @type {string} */ dateIso) => {
  const [y, m, d] = String(dateIso).split("-");
  return `https://api.hfs.purdue.edu/menus/v2/locations/${encodeURIComponent(location)}/${m}-${d}-${y}`;
};

/** The per-item endpoint, which is the only place nutrition lives. */
export const itemUrlFor = (/** @type {string} */ id) =>
  `https://api.hfs.purdue.edu/menus/v2/items/${encodeURIComponent(id)}`;

/**
 * Flatten a day's menu into the items on offer at one meal.
 * @param {Record<string, any> | null} day the /locations/<court>/<date> payload
 * @param {string} mealType "Breakfast" | "Lunch" | "Dinner" | "Late Lunch"
 * @returns {{ id: string, name: string, station: string, vegetarian: boolean,
 *   allergens: string[], nutritionReady: boolean }[]}
 */
export function itemsForMeal(day, mealType) {
  const meal = (day?.Meals ?? []).find(
    (/** @type {any} */ m) => String(m?.Type ?? m?.Name ?? "").toLowerCase() === String(mealType).toLowerCase(),
  );
  if (!meal) return [];
  const out = [];
  for (const st of meal.Stations ?? []) {
    for (const it of st.Items ?? []) {
      out.push({
        id: String(it.ID ?? ""),
        name: String(it.Name ?? ""),
        station: String(st.Name ?? ""),
        vegetarian: it.IsVegetarian === true,
        allergens: (it.Allergens ?? [])
          .filter((/** @type {any} */ a) => a?.Value === true)
          .map((/** @type {any} */ a) => String(a.Name ?? "").toLowerCase()),
        nutritionReady: it.NutritionReady === true,
      });
    }
  }
  return out;
}

/**
 * Pull calories and protein off an item payload.
 *
 * Returns null when the hall has not published numbers, and a null must never
 * be treated as a zero: an item with no nutrition is an item this composer
 * cannot reason about, not a free one.
 * @param {Record<string, any> | null} item the /items/<id> payload
 * @returns {{ id: string, name: string, calories: number, protein: number,
 *   servingSize: string, allergens: string[] } | null}
 */
export function parseItem(item) {
  const rows = item?.Nutrition ?? [];
  const find = (/** @type {string} */ name) =>
    rows.find((/** @type {any} */ r) => String(r?.Name ?? "").toLowerCase() === name);
  const cal = find("calories");
  const pro = find("protein");
  const calories = Number(cal?.Value ?? NaN);
  const protein = Number(pro?.Value ?? NaN);
  if (!Number.isFinite(calories) || !Number.isFinite(protein)) return null;
  return {
    id: String(item?.ID ?? ""),
    name: String(item?.Name ?? ""),
    calories,
    protein,
    servingSize: String(find("serving size")?.LabelValue ?? ""),
    allergens: (item?.Allergens ?? [])
      .filter((/** @type {any} */ a) => a?.Value === true)
      .map((/** @type {any} */ a) => String(a.Name ?? "").toLowerCase()),
  };
}

/** Does this hall item carry anything the person avoids? */
function unsafeFor(
  /** @type {{ allergens: string[] }} */ item,
  /** @type {Set<string>} */ avoidIds,
) {
  if (avoidIds.size === 0) return [];
  // deduped: Purdue lists "gluten" and "wheat" separately and both map to the
  // same preset, so a bun would otherwise be refused twice for one reason
  return [
    ...new Set(
      item.allergens
        .map((/** @type {string} */ a) => ALLERGEN_ALIASES[a] ?? a)
        .filter((/** @type {string} */ a) => avoidIds.has(a)),
    ),
  ];
}

/**
 * Build a tray that meets a calorie and protein quota from what the hall is
 * actually serving.
 *
 * Greedy on protein density first, because protein is the binding macro and
 * the expensive one everywhere else in this app; then calories are topped up
 * from whatever is left. Servings are whole, because you cannot ask for 1.3
 * scoops of anything.
 *
 * OVERSHOOTING PROTEIN HERE IS DELIBERATE, and it is the one place in Mise
 * where that is true. P5 calls protein above target a budget leak because
 * every gram is bought; at a dining court the meal is already paid for, so the
 * marginal cost of another scoop of chicken is zero and the arbitrage runs the
 * other way: eat the expensive macro where it is free and let the grocery list
 * buy less of it. Whole servings mean the tray lands above the quota, never
 * below, and that is the correct direction here.
 *
 * @param {{ id: string, name: string, calories: number, protein: number,
 *   servingSize?: string, allergens?: string[] }[]} items priced menu items
 * @param {{ calories: number, protein: number }} quota what this SLOT owes
 * @param {{ avoidAllergens?: string[], maxServingsPerItem?: number, calorieCeiling?: number }} [opts]
 * @returns {{
 *   picks: { name: string, servings: number, calories: number, protein: number }[],
 *   calories: number, protein: number,
 *   meets: { calories: boolean, protein: boolean },
 *   excluded: { name: string, because: string[] }[],
 *   caution: string
 * }}
 */
export function composeTray(items, quota, opts = {}) {
  const avoid = new Set((opts.avoidAllergens ?? []).map((a) => String(a).toLowerCase()));
  const maxEach = Math.max(1, opts.maxServingsPerItem ?? 3);
  const ceiling = Number(opts.calorieCeiling) > 0 ? Number(opts.calorieCeiling) : quota.calories * 1.15;

  /** @type {{ name: string, because: string[] }[]} */
  const excluded = [];
  const safe = [];
  for (const it of items ?? []) {
    if (!Number.isFinite(it.calories) || !Number.isFinite(it.protein)) {
      excluded.push({ name: it.name, because: ["the hall published no numbers for it"] });
      continue;
    }
    const hits = unsafeFor({ ...it, allergens: it.allergens ?? [] }, avoid);
    if (hits.length > 0) {
      excluded.push({ name: it.name, because: hits });
      continue;
    }
    safe.push(it);
  }

  /** @type {Map<string, { item: any, servings: number }>} */
  const chosen = new Map();
  let calories = 0;
  let protein = 0;
  const take = (/** @type {any} */ it) => {
    const row = chosen.get(it.id) ?? { item: it, servings: 0 };
    row.servings += 1;
    chosen.set(it.id, row);
    calories += it.calories;
    protein += it.protein;
  };

  // 1. protein first, densest per calorie, so the tray does not spend its
  //    calorie room on food that does not move the binding number
  const byDensity = [...safe].sort(
    (a, b) => b.protein / Math.max(1, b.calories) - a.protein / Math.max(1, a.calories),
  );
  let guard = 0;
  while (protein < quota.protein && guard++ < 200) {
    const next = byDensity.find(
      (it) =>
        (chosen.get(it.id)?.servings ?? 0) < maxEach &&
        it.protein > 0 &&
        calories + it.calories <= ceiling,
    );
    if (!next) break;
    take(next);
  }

  // 2. then calories, densest first, without undoing step 1
  const byCalories = [...safe].sort((a, b) => b.calories - a.calories);
  guard = 0;
  while (calories < quota.calories && guard++ < 200) {
    const next = byCalories.find(
      (it) => (chosen.get(it.id)?.servings ?? 0) < maxEach && calories + it.calories <= ceiling,
    );
    if (!next) break;
    take(next);
  }

  const picks = [...chosen.values()].map((r) => ({
    name: r.item.name,
    servings: r.servings,
    calories: Math.round(r.item.calories * r.servings),
    protein: Math.round(r.item.protein * r.servings),
  }));
  return {
    picks,
    calories: Math.round(calories),
    protein: Math.round(protein),
    meets: { calories: calories >= quota.calories, protein: protein >= quota.protein },
    excluded,
    caution:
      "A dining court serving is whatever the server puts on the plate, so every number here is an " +
      "estimate of an estimate. Treat the tray as a shape, not a measurement.",
  };
}
