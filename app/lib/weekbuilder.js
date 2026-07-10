// Ingredient-overlap week builder (David's plan-at-week-start flow):
// dinners are the decision surface — a small "committee" of dinner recipes
// is chosen to MAXIMIZE shared non-staple ingredients (bulk buying: one big
// chicken pack instead of four proteins) and spread over the week with no
// recipe appearing more than twice. Backbone slots (breakfast / smoothie /
// office lunch) fill from the best-overlapping candidates, short days get a
// protein snack, existing entries are never touched, and the report says
// exactly what the week shares so the shopping win is visible.

import { addEntry, datesOfWeek, dayTotals, entriesAt, recipesById } from "./plan.js";
import { slug } from "./shopping.js";

/** deterministic 32-bit FNV-1a — the builder's only randomness source */
function hash(/** @type {string} */ s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Non-staple ingredient slugs — the foods a recipe puts on the shopping list.
 * @param {Record<string, any>} recipe
 * @returns {Set<string>}
 */
export function foodSlugsOf(recipe) {
  const out = new Set();
  for (const ing of recipe.ingredients ?? []) {
    if (!ing.staple) out.add(slug(String(ing.food)));
  }
  return out;
}

/**
 * What a set of recipes shares, and how many distinct items they'd shop.
 * @param {Record<string, any>[]} recipes
 * @returns {{ shared: { food: string, count: number }[], distinctItems: number }}
 */
export function overlapReport(recipes) {
  /** @type {Map<string, { food: string, count: number }>} */
  const freq = new Map();
  for (const r of recipes) {
    for (const ing of r.ingredients ?? []) {
      if (ing.staple) continue;
      const key = slug(String(ing.food));
      const cur = freq.get(key);
      if (cur) cur.count++;
      else freq.set(key, { food: String(ing.food), count: 1 });
    }
  }
  const shared = [...freq.values()].filter((f) => f.count >= 2).sort((a, b) => b.count - a.count);
  return { shared, distinctItems: freq.size };
}

/**
 * @param {Record<string, any>} recipe
 * @param {Set<string>} foods
 */
function overlapWith(recipe, foods) {
  let n = 0;
  for (const f of foodSlugsOf(recipe)) if (foods.has(f)) n++;
  return n;
}

/**
 * @param {Record<string, any>} recipe
 * @param {string[]} useSoonFoods
 */
function useSoonHits(recipe, useSoonFoods) {
  const foods = [...foodSlugsOf(recipe)];
  let n = 0;
  for (const soon of useSoonFoods) {
    const s = slug(String(soon));
    if (foods.some((f) => s.includes(f) || f.includes(s))) n++;
  }
  return n;
}

/**
 * Greedy committee: seed with the recipe whose ingredients recur most across
 * all candidates, then grow by marginal overlap. Use-soon pantry items are
 * worth extra; salt jitters ties so RE-ROLL gives a different (still good)
 * week.
 * @param {Record<string, any>[]} candidates
 * @param {{ size?: number, salt?: number, useSoonFoods?: string[] }} [opts]
 * @returns {Record<string, any>[]}
 */
export function pickDinnerCommittee(candidates, opts = {}) {
  // weekend projects (3-hour braises) never auto-fill weeknights — they
  // stay in the tray for deliberate drags
  candidates = candidates.filter((c) => c.effort !== "project");
  const size = Math.min(opts.size ?? 4, candidates.length);
  const salt = opts.salt ?? 0;
  const useSoon = opts.useSoonFoods ?? [];
  if (size === 0) return [];

  const jitter = (/** @type {Record<string, any>} */ r) => (hash(`${r.id}|${salt}`) % 997) / 9970;
  const bonus = (/** @type {Record<string, any>} */ r) =>
    useSoonHits(r, useSoon) * 3 + (r.nutrition?.protein ?? 0) / 200 + jitter(r);

  // seed: most "connected" candidate
  const allFoodCounts = overlapReport(candidates);
  const sharedSet = new Set(allFoodCounts.shared.map((s) => slug(s.food)));
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const score = overlapWith(c, sharedSet) + bonus(c);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  const committee = [/** @type {Record<string, any>} */ (best)];
  const committeeFoods = new Set(foodSlugsOf(/** @type {any} */ (best)));

  while (committee.length < size) {
    let next = null;
    let nextScore = -Infinity;
    for (const c of candidates) {
      if (committee.includes(c)) continue;
      const score = overlapWith(c, committeeFoods) + bonus(c);
      if (score > nextScore) {
        nextScore = score;
        next = c;
      }
    }
    if (!next) break;
    committee.push(next);
    for (const f of foodSlugsOf(next)) committeeFoods.add(f);
  }
  return committee;
}

const PROTEIN_FLOOR_RATIO = 0.95;

/**
 * Fill every EMPTY slot of the week; never touch existing entries.
 * @param {{
 *   recipes: Record<string, any>[],
 *   targets: Record<string, any> | null,
 *   pantry: Record<string, any>,
 *   weekId: string,
 *   plan: import("./plan.js").Plan,
 *   salt?: number
 * }} args
 * @returns {{ plan: import("./plan.js").Plan, report: { shared: { food: string, count: number }[], distinctItems: number, proteinShortDays: { date: string, protein: number, target: number }[] } }}
 */
export function buildWeek({ recipes, targets, pantry, weekId, plan, salt = 0 }) {
  const dates = datesOfWeek(weekId);
  const byId = recipesById(recipes);
  const useSoonFoods = (pantry.perishables ?? [])
    .filter((/** @type {any} */ p) => p.useSoon)
    .map((/** @type {any} */ p) => String(p.food));
  const pool = (/** @type {string} */ meal) => recipes.filter((r) => r.mealType === meal);

  const committee = pickDinnerCommittee(pool("dinner"), { size: 4, salt, useSoonFoods });
  const committeeFoods = new Set(committee.flatMap((c) => [...foodSlugsOf(c)]));

  const byOverlap = (/** @type {Record<string, any>[]} */ rs) =>
    [...rs].sort(
      (a, b) =>
        overlapWith(b, committeeFoods) - overlapWith(a, committeeFoods) ||
        (b.nutrition?.protein ?? 0) - (a.nutrition?.protein ?? 0) ||
        String(a.id).localeCompare(String(b.id)),
    );

  const breakfasts = byOverlap(pool("breakfast")).slice(0, 2);
  const smoothie = byOverlap(pool("smoothie"))[0];
  const lunchPool = byOverlap(pool("lunch"));
  const officeLunch = lunchPool.find((r) => r.id === "office-lunch-box");
  const otherLunches = lunchPool.filter((r) => r !== officeLunch).slice(0, 2);
  const snack = byOverlap(pool("snack")).sort(
    (a, b) => (b.nutrition?.protein ?? 0) - (a.nutrition?.protein ?? 0),
  )[0];

  let next = plan;
  const rotation = hash(`${weekId}|${salt}`) % Math.max(1, committee.length);
  // dinner sequence honoring the ≤2-per-recipe promise: the rotated committee
  // laid out twice; with a small committee the tail days stay EMPTY — an
  // honest gap to drag into beats a third repeat of the same dinner
  /** @type {Record<string, any>[]} */
  const dinnerSequence = [];
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < committee.length; k++) {
      const pick = committee[(k + rotation) % committee.length];
      if (pick) dinnerSequence.push(pick);
    }
  }

  let dinnerCursor = 0;
  const fill = (
    /** @type {string} */ date,
    /** @type {string} */ slot,
    /** @type {Record<string, any> | undefined} */ recipe,
  ) => {
    if (!recipe) return;
    if (entriesAt(next.entries, date, slot).length > 0) return; // never overwrite
    next = addEntry(next, date, slot, { recipeId: recipe.id, servings: 1 });
  };

  dates.forEach((date, i) => {
    fill(date, "breakfast", breakfasts[i % Math.max(1, breakfasts.length)]);
    fill(date, "smoothie", smoothie);
    const isOfficeDay = i >= 1 && i <= 3; // Tue/Wed/Thu
    fill(
      date,
      "lunch",
      isOfficeDay && officeLunch
        ? officeLunch
        : (otherLunches[i % Math.max(1, otherLunches.length)] ?? officeLunch ?? lunchPool[0]),
    );
    if (
      dinnerCursor < dinnerSequence.length &&
      entriesAt(next.entries, date, "dinner").length === 0
    ) {
      fill(date, "dinner", dinnerSequence[dinnerCursor]);
      dinnerCursor++;
    }
  });

  // top up short days with the protein snack
  const proteinTarget = targets?.macros?.protein ?? 180;
  if (snack) {
    for (const date of dates) {
      if (entriesAt(next.entries, date, "snack").length > 0) continue;
      const totals = dayTotals(next.entries, byId, date);
      if (totals.protein < proteinTarget * PROTEIN_FLOOR_RATIO) {
        next = addEntry(next, date, "snack", { recipeId: snack.id, servings: 1 });
      }
    }
  }

  // protein is the non-negotiable — red-flag any day still under the floor
  // after the snack top-up so David sees it before the week starts
  const proteinShortDays = [];
  for (const date of dates) {
    const totals = dayTotals(next.entries, byId, date);
    if (totals.protein < proteinTarget * PROTEIN_FLOOR_RATIO) {
      proteinShortDays.push({ date, protein: totals.protein, target: proteinTarget });
    }
  }

  // the report covers what the GENERATED week actually shares: the committee
  // plus the backbone picks
  const chosen = [
    ...committee,
    ...breakfasts,
    ...(smoothie ? [smoothie] : []),
    ...(officeLunch ? [officeLunch] : []),
    ...otherLunches,
  ];
  return { plan: next, report: { ...overlapReport(chosen), proteinShortDays } };
}
