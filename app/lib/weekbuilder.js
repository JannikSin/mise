// Full-week generator (David's "one tap owns the whole week" flow):
// every unpinned entry is cleared and all 7 days x 5 slots are rebuilt from
// scratch around whatever the user pinned. Dinner is still the biggest
// ingredient-mass decision so it's chosen first as a "committee" that
// maximizes shared non-staple ingredients; lunch/breakfast/smoothie/snack
// follow, each rewarded for sharing food with the whole week's pool so far
// (not just its own meal type) and for closing Daily Dozen food-group gaps.
// Every day must clear the calorie and protein floor — a macro top-up stacks
// up to 2 extra items where the picks alone fall short. Nothing is silently
// fudged: days/categories that still miss a target are reported plainly, and
// a pool that structurally cannot reach a target (no candidate contributes
// at all) is called out with a plain-English suggestion.

import { addEntry, dayTotals, datesOfWeek, entriesAt, recipesById } from "./plan.js";
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
 * A recipe's Daily Dozen servings, scaled by planned servings. The `method`
 * key is descriptive metadata, not a food group, so it's excluded.
 * @param {Record<string, any>} recipe
 * @param {number} servings
 * @returns {Record<string, number>}
 */
export function foodGroupContribution(recipe, servings) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(recipe.foodGroups ?? {})) {
    if (k === "method") continue;
    out[k] = (Number(v) || 0) * servings;
  }
  return out;
}

/**
 * Total Daily Dozen coverage across a set of chosen recipes x their planned
 * count.
 * @param {{ recipe: Record<string, any>, count: number }[]} chosen
 * @returns {Record<string, number>}
 */
export function foodGroupCoverage(chosen) {
  /** @type {Record<string, number>} */
  const totals = {};
  for (const { recipe, count } of chosen) {
    for (const [k, v] of Object.entries(foodGroupContribution(recipe, count))) {
      totals[k] = (totals[k] ?? 0) + v;
    }
  }
  return totals;
}

/**
 * Marginal bonus for a candidate recipe given what's still under target — the
 * core of "meet the nutrients": the gap shrinks in proportion to how far
 * under target each category still is, so the greedy pick self-corrects
 * toward balance instead of overloading one strong category.
 * @param {Record<string, any>} recipe
 * @param {Record<string, number>} coverageSoFar
 * @param {Record<string, number>} targets
 * @returns {number}
 */
export function foodGroupGapBonus(recipe, coverageSoFar, targets) {
  let bonus = 0;
  for (const [group, target] of Object.entries(targets)) {
    const have = coverageSoFar[group] ?? 0;
    const gap = Math.max(0, target - have);
    if (gap <= 0) continue;
    bonus += (recipe.foodGroups?.[group] ?? 0) * Math.min(1, gap / target);
  }
  return bonus;
}

/**
 * Greedy committee for one meal type: seed with the recipe most connected to
 * foods already in play this week (falling back to within-candidate
 * recurrence when the week pool is still empty — i.e. for the first meal
 * type picked), then grow by marginal overlap against the whole week's food
 * pool so far, not just this meal type. Scored on: ingredient overlap,
 * foodGroupGapBonus against the running Daily Dozen coverage, protein
 * density, use-soon pantry bonus, and salted jitter for RE-ROLL variety.
 * Effort:"project" recipes (weekend-only) are never eligible.
 * @param {Record<string, any>[]} candidates
 * @param {{
 *   size?: number,
 *   salt?: number,
 *   useSoonFoods?: string[],
 *   weekFoodPool?: Set<string>,
 *   coverageSoFar?: Record<string, number>,
 *   dailyDozenTargets?: Record<string, number>
 * }} [opts]
 * @returns {Record<string, any>[]}
 */
export function pickCommittee(candidates, opts = {}) {
  candidates = candidates.filter((c) => c.effort !== "project");
  const size = Math.min(opts.size ?? 4, candidates.length);
  const salt = opts.salt ?? 0;
  const useSoon = opts.useSoonFoods ?? [];
  const weekFoodPool = opts.weekFoodPool ?? new Set();
  const coverageSoFar = opts.coverageSoFar ?? {};
  const dailyDozenTargets = opts.dailyDozenTargets ?? {};
  if (size === 0) return [];

  const jitter = (/** @type {Record<string, any>} */ r) => (hash(`${r.id}|${salt}`) % 997) / 9970;
  const bonus = (/** @type {Record<string, any>} */ r) =>
    useSoonHits(r, useSoon) * 3 +
    (r.nutrition?.protein ?? 0) / 200 +
    foodGroupGapBonus(r, coverageSoFar, dailyDozenTargets) * 2 +
    jitter(r);

  // seed: most "connected" candidate to the week pool so far; if nothing has
  // been chosen yet, fall back to whichever candidate recurs most among its
  // own peers (today's dinner-only seeding heuristic)
  const allFoodCounts = overlapReport(candidates);
  const sharedSet = new Set(allFoodCounts.shared.map((s) => slug(s.food)));
  const seedTarget = weekFoodPool.size > 0 ? weekFoodPool : sharedSet;
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const score = overlapWith(c, seedTarget) + bonus(c);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (!best) return [];
  const committee = [best];
  const committeeFoods = new Set([...foodSlugsOf(best), ...weekFoodPool]);

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

/**
 * 2-pass rotated sequence over a committee: each member appears at most
 * twice, in rotation order. Fewer than 7 slots means the tail days stay
 * empty — an honest gap to drag into beats a third repeat.
 * @param {Record<string, any>[]} committee
 * @param {number} rotation
 * @returns {Record<string, any>[]}
 */
function twoPassSequence(committee, rotation) {
  /** @type {Record<string, any>[]} */
  const seq = [];
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < committee.length; k++) {
      const pick = committee[(k + rotation) % committee.length];
      if (pick) seq.push(pick);
    }
  }
  return seq;
}

/** portion lever per slot on a short day: dinner +1.0 max, lunch +0.5 max */
const PORTION_BUMPS = /** @type {const} */ ([
  { slot: "dinner", maxBump: 1.0 },
  { slot: "lunch", maxBump: 0.5 },
]);
/** a single person-day entry never exceeds 2x the recipe's base serving */
const MAX_ENTRY_SERVINGS = 2;

/**
 * Food-group keys the per-day floor pass insists on, sourced from
 * targets.dailyDozen but enforced only for these two — one obvious edit away
 * from growing the set. Per the 2026-07-10 Opus nutrition audit: coverage
 * clusters (cruciferous 2-4 on a broccoli-dinner day, 0 on a pasta day;
 * greens 2 on smoothie days, near 0 on rice-bowl days) unless every day is
 * forced to clear its own floor.
 */
export const ENFORCED_DAILY_GROUPS = ["greens", "cruciferousVeg"];

/**
 * Total of one Daily Dozen food group across a single day's entries.
 * @param {import("./plan.js").PlanEntry[]} entries
 * @param {Map<string, any>} recipesById
 * @param {string} date
 * @param {string} group
 * @returns {number}
 */
function dayGroupTotal(entries, recipesById, date, group) {
  let total = 0;
  for (const e of entries) {
    if (e.date !== date || !e.recipeId) continue;
    total += (recipesById.get(e.recipeId)?.foodGroups?.[group] ?? 0) * e.servings;
  }
  return total;
}

/**
 * Per-day food-group FLOOR pass: forces each date to clear `floors` for the
 * groups they name (see ENFORCED_DAILY_GROUPS), instead of leaving coverage
 * to whatever the committee's greedy gap bonus happened to cluster. Runs
 * AFTER the meal slots are filled and BEFORE macroTopUp, so the calorie/
 * protein top-up sees each day's post-floor totals.
 *
 * For each date short of a floor: first try raising servings on an existing
 * unpinned entry that already contributes that group (0.5 steps, biggest
 * per-serving contributor first, capped at MAX_ENTRY_SERVINGS) — bigger
 * portions beat new items, same philosophy as macroTopUp's portion lever.
 * Only when every contributing entry is maxed out and the day is still
 * short does it add ONE recipe from `pool` that contributes the missing
 * group, preferring candidates whose ingredients already overlap the week's
 * food pool (tightest shopping list). Never removes or replaces an entry,
 * never resizes a pinned one. If `pool` has nothing that contributes the
 * group, the day is left alone — foodGroupGaps reports the shortfall
 * honestly rather than fudging it. Pure and deterministic (salted hash
 * tiebreak only, no Math.random/Date.now).
 * @param {import("./plan.js").Plan} plan
 * @param {Record<string, any>[]} pool
 * @param {Map<string, any>} recipesById
 * @param {Record<string, number>} floors
 * @returns {import("./plan.js").Plan}
 */
export function foodGroupFloorPass(plan, pool, recipesById, floors) {
  const candidates = pool.filter((r) => r.effort !== "project");
  const dates = [...new Set(plan.entries.map((e) => e.date))].sort();
  let next = plan;

  for (const date of dates) {
    for (const [group, floor] of Object.entries(floors)) {
      if (!floor) continue;
      if (dayGroupTotal(next.entries, recipesById, date, group) >= floor) continue;

      // lever 1: raise servings on already-contributing unpinned entries,
      // biggest per-serving contributor first (closes the gap in fewest
      // steps), deterministic hash tiebreak
      const contributors = next.entries
        .filter(
          (e) =>
            e.date === date &&
            !e.pinned &&
            e.recipeId &&
            (recipesById.get(e.recipeId)?.foodGroups?.[group] ?? 0) > 0,
        )
        .sort((a, b) => {
          const pa = recipesById.get(/** @type {string} */ (a.recipeId))?.foodGroups?.[group] ?? 0;
          const pb = recipesById.get(/** @type {string} */ (b.recipeId))?.foodGroups?.[group] ?? 0;
          return pb - pa || hash(`${a.id}|${group}`) - hash(`${b.id}|${group}`);
        });

      for (const entry of contributors) {
        if (dayGroupTotal(next.entries, recipesById, date, group) >= floor) break;
        let servings = entry.servings;
        while (
          servings + 0.5 <= MAX_ENTRY_SERVINGS &&
          dayGroupTotal(next.entries, recipesById, date, group) < floor
        ) {
          servings += 0.5;
          next = {
            ...next,
            entries: next.entries.map((e) => (e.id === entry.id ? { ...e, servings } : e)),
          };
        }
      }
      if (dayGroupTotal(next.entries, recipesById, date, group) >= floor) continue;

      // lever 2: portions alone couldn't close it — add ONE recipe that
      // contributes the group, preferring overlap with the week's food pool
      // so the shopping list stays tight (matches pickCommittee's seeding)
      const weekFoodPool = new Set(
        next.entries.flatMap((e) => {
          const r = e.recipeId ? recipesById.get(e.recipeId) : null;
          return r ? [...foodSlugsOf(r)] : [];
        }),
      );
      let best = null;
      let bestScore = -Infinity;
      for (const c of candidates) {
        const contribution = c.foodGroups?.[group] ?? 0;
        if (contribution <= 0) continue;
        const score =
          overlapWith(c, weekFoodPool) * 10 + contribution + (hash(`${c.id}|${date}|${group}`) % 997) / 9970;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (best) {
        next = addEntry(next, date, "snack", { recipeId: best.id, servings: 1 });
      }
      // else: no candidate in the pool contributes this group — leave the
      // day alone, foodGroupGaps reports it honestly
    }
  }
  return next;
}

/**
 * Top up any day short of calories or protein, cheapest lever first:
 * 1. raise that day's dinner servings in 0.5 steps (max +1.0), then lunch
 *    (max +0.5), recomputing day totals each step — portion bumps of
 *    already-chosen meals keep the week boring and the shopping list
 *    unchanged in ITEMS, only quantities grow;
 * 2. only then stack best-fit snack items, at most 3 per day.
 * Pinned entries are never resized, servings never exceed 2x the recipe's
 * base serving, and nothing is invented — only real recipes at realistic
 * portions. Pure and deterministic.
 * @param {import("./plan.js").Plan} plan
 * @param {Record<string, any>[]} snackPool
 * @param {Map<string, any>} recipesById
 * @param {{ calories: number, protein: number }} floors
 * @returns {import("./plan.js").Plan}
 */
export function macroTopUp(plan, snackPool, recipesById, floors) {
  const pool = snackPool.filter((r) => r.effort !== "project");
  const dates = [...new Set(plan.entries.map((e) => e.date))].sort();
  if (dates.length === 0) return plan;

  const bestFor = (/** @type {boolean} */ needProtein, /** @type {Set<string>} */ exclude) =>
    [...pool]
      .filter((r) => !exclude.has(r.id))
      .sort((a, b) => {
        const pa = a.nutrition?.protein ?? 0;
        const pb = b.nutrition?.protein ?? 0;
        const ca = a.nutrition?.calories ?? 0;
        const cb = b.nutrition?.calories ?? 0;
        return needProtein ? pb - pa || cb - ca : cb - ca || pb - pa;
      })[0];

  let next = plan;
  const shortOf = (/** @type {string} */ date) => {
    const totals = dayTotals(next.entries, recipesById, date);
    return {
      protein: totals.protein < floors.protein,
      any: totals.protein < floors.protein || totals.calories < floors.calories,
    };
  };

  for (const date of dates) {
    // lever 1: portion bumps on already-chosen meals, 0.5 steps at a time
    for (const { slot, maxBump } of PORTION_BUMPS) {
      const target = entriesAt(next.entries, date, slot).find(
        (e) => !e.pinned && e.recipeId && recipesById.has(e.recipeId),
      );
      if (!target) continue;
      const cap = Math.min(target.servings + maxBump, MAX_ENTRY_SERVINGS);
      let servings = target.servings;
      while (servings + 0.5 <= cap && shortOf(date).any) {
        servings += 0.5;
        next = {
          ...next,
          entries: next.entries.map((e) => (e.id === target.id ? { ...e, servings } : e)),
        };
      }
    }
    // lever 2: stack snacks, at most 3 servings-worth per day (raised from 2
    // for the 2026-07-10 gain-phase calorie bump: the 3700/3500 floor needs
    // more top-up headroom than the old 3400/3200). A repeat of the same
    // snack bumps the existing entry's servings, never a duplicate row, and
    // never past the 2x per-entry cap; once the best pick is maxed the next
    // stack tries the next-best DISTINCT snack instead of stalling out.
    const maxedOut = new Set();
    for (let stacked = 0; stacked < 3; stacked++) {
      const s = shortOf(date);
      if (!s.any) break;
      const pick = bestFor(s.protein, maxedOut);
      if (!pick) break;
      const existing = entriesAt(next.entries, date, "snack").find(
        (e) => !e.pinned && e.recipeId === pick.id,
      );
      if (existing && existing.servings >= MAX_ENTRY_SERVINGS) {
        maxedOut.add(pick.id);
        stacked--; // this attempt didn't spend a stack, retry with the next-best pick
        continue;
      }
      next = existing
        ? {
            ...next,
            entries: next.entries.map((e) =>
              e.id === existing.id ? { ...e, servings: e.servings + 1 } : e,
            ),
          }
        : addEntry(next, date, "snack", { recipeId: pick.id, servings: 1 });
    }
  }
  return next;
}

/**
 * Protein/calorie floor misses, per day, after the top-up has run. Days are
 * COMPARED against the 0.95 floors, but the report carries the real goals
 * (`targets`) so the planner never displays a silently-discounted number.
 * @param {import("./plan.js").Plan} plan
 * @param {Map<string, any>} recipesById
 * @param {string[]} dates
 * @param {{ calories: number, protein: number }} floors
 * @param {{ calories: number, protein: number }} targets
 * @returns {{
 *   proteinShortDays: { date: string, protein: number, target: number }[],
 *   calorieShortDays: { date: string, calories: number, target: number }[]
 * }}
 */
function macroShortfalls(plan, recipesById, dates, floors, targets) {
  /** @type {{ date: string, protein: number, target: number }[]} */
  const proteinShortDays = [];
  /** @type {{ date: string, calories: number, target: number }[]} */
  const calorieShortDays = [];
  for (const date of dates) {
    const totals = dayTotals(plan.entries, recipesById, date);
    if (totals.protein < floors.protein) {
      proteinShortDays.push({ date, protein: totals.protein, target: targets.protein });
    }
    if (totals.calories < floors.calories) {
      calorieShortDays.push({ date, calories: totals.calories, target: targets.calories });
    }
  }
  return { proteinShortDays, calorieShortDays };
}

/**
 * Per-day Daily Dozen gaps against the actually-generated plan, plus a
 * weekly rollup. Per addendum R1, coverage is judged on a PER-DAY basis
 * (Greger's Daily Dozen is a daily checklist) — only categories that fell
 * under target are reported, same "say so, never fudge" spirit as the macro
 * shortfall report.
 * @param {import("./plan.js").PlanEntry[]} entries
 * @param {Map<string, any>} recipesById
 * @param {string[]} dates
 * @param {Record<string, number>} dailyDozenPerDay
 * @returns {{
 *   perDay: { date: string, group: string, have: number, target: number }[],
 *   weekly: { group: string, have: number, target: number }[]
 * }}
 */
function foodGroupGapsReport(entries, recipesById, dates, dailyDozenPerDay) {
  /** @type {{ date: string, group: string, have: number, target: number }[]} */
  const perDay = [];
  /** @type {Record<string, number>} */
  const weeklyHave = {};
  for (const date of dates) {
    const chosen = entries
      .filter((e) => e.date === date && e.recipeId)
      .map((e) => ({ recipe: recipesById.get(/** @type {string} */ (e.recipeId)), count: e.servings }))
      .filter((c) => c.recipe);
    const coverage = foodGroupCoverage(chosen);
    for (const [group, target] of Object.entries(dailyDozenPerDay)) {
      const have = Math.round((coverage[group] ?? 0) * 100) / 100;
      weeklyHave[group] = (weeklyHave[group] ?? 0) + have;
      if (have < target) perDay.push({ date, group, have, target });
    }
  }
  const weekly = Object.entries(dailyDozenPerDay)
    .map(([group, dailyTarget]) => ({
      group,
      have: Math.round((weeklyHave[group] ?? 0) * 100) / 100,
      target: Number(dailyTarget) * dates.length,
    }))
    .filter((g) => g.have < g.target);
  return { perDay, weekly };
}

/**
 * Structural pool gaps: a category no candidate in the WHOLE pool
 * contributes to at all. Distinct from "this week's choice happened to fall
 * short" (that's `foodGroupGaps`) — this fires only when no achievable
 * committee, however assembled, could ever reach the target, because zero
 * recipes carry that food group. The report says so in plain English, never
 * a silently-relaxed target.
 * @param {Record<string, any>[]} recipes
 * @param {Record<string, number>} dailyDozenTargets
 * @returns {{ reason: string, suggestion: string }[]}
 */
export function poolInsufficiency(recipes, dailyDozenTargets) {
  /** @type {{ reason: string, suggestion: string }[]} */
  const out = [];
  for (const group of Object.keys(dailyDozenTargets)) {
    const contributes = recipes.some((r) => (r.foodGroups?.[group] ?? 0) > 0);
    if (!contributes) {
      out.push({
        reason: `no recipe in the pool contributes ${group}`,
        suggestion: `add 1-2 recipes tagged with ${group} servings`,
      });
    }
  }
  return out;
}

const FLOOR_RATIO = 0.95;
const COMMITTEE_SIZES = { dinner: 4, lunch: 3, breakfast: 2, smoothie: 1, snack: 2 };
const MEAL_ORDER = /** @type {const} */ (["dinner", "lunch", "breakfast", "smoothie", "snack"]);

/**
 * @typedef {{
 *   shared: { food: string, count: number }[],
 *   distinctItems: number,
 *   proteinShortDays: { date: string, protein: number, target: number }[],
 *   calorieShortDays: { date: string, calories: number, target: number }[],
 *   foodGroupGaps: { date: string, group: string, have: number, target: number }[],
 *   foodGroupGapsWeekly: { group: string, have: number, target: number }[],
 *   poolInsufficient: { reason: string, suggestion: string }[]
 * }} WeekReport
 */

/**
 * Full-week generation: clears every UNPINNED entry, rebuilds all 7 days x 5
 * slots from scratch. Pinned entries are never touched and seed the greedy
 * scoring (their foods/food-groups count toward "already in play"). Dinner
 * is picked first (biggest ingredient mass), then lunch, breakfast, smoothie,
 * snack — each committee sees the growing week-wide food pool and coverage.
 * The office-lunch-box recipe (if present) hard-pins Tue/Wed/Thu, matching
 * the Sunday-batch routine. Deterministic per (weekId, salt); RE-ROLL is
 * salt+1 over the same pinned base.
 * @param {{
 *   recipes: Record<string, any>[],
 *   targets: Record<string, any> | null,
 *   pantry: Record<string, any>,
 *   weekId: string,
 *   plan: import("./plan.js").Plan,
 *   salt?: number
 * }} args
 * @returns {{ plan: import("./plan.js").Plan, report: WeekReport }}
 */
export function generateWeek({ recipes, targets, pantry, weekId, plan, salt = 0 }) {
  const dates = datesOfWeek(weekId);
  const byId = recipesById(recipes);
  const useSoonFoods = (pantry.perishables ?? [])
    .filter((/** @type {any} */ p) => p.useSoon)
    .map((/** @type {any} */ p) => String(p.food));
  const pool = (/** @type {string} */ meal) => recipes.filter((r) => r.mealType === meal);

  // Step 1: clear every unpinned entry; pinned entries are the only
  // pre-existing content the rest of generation builds around
  const pinnedEntries = plan.entries.filter((e) => e.pinned);
  let next = { ...plan, week: weekId, entries: pinnedEntries };

  const proteinTarget = targets?.macros?.protein ?? 210;
  const caloriesTarget = targets?.macros?.calories ?? 3400;
  const floors = { protein: proteinTarget * FLOOR_RATIO, calories: caloriesTarget * FLOOR_RATIO };
  const dailyDozenPerDay = targets?.dailyDozen ?? {};
  // greedy committee scoring accumulates at week-level for efficiency (R1);
  // the REPORT is still computed per day from the actual generated plan
  const dailyDozenWeekly = Object.fromEntries(
    Object.entries(dailyDozenPerDay).map(([k, v]) => [k, Number(v) * 7]),
  );
  // only the ENFORCED_DAILY_GROUPS get a per-day floor pass; groups absent
  // from targets.dailyDozen are silently skipped, never invented
  const dailyGroupFloors = Object.fromEntries(
    ENFORCED_DAILY_GROUPS.filter((g) => dailyDozenPerDay[g] != null).map((g) => [
      g,
      Number(dailyDozenPerDay[g]),
    ]),
  );

  // seed the week-wide pool/coverage from whatever's already pinned; pinned
  // recipes are also EXCLUDED from committee candidacy — their foods seeding
  // the overlap score would otherwise make the same recipe self-select and
  // blow past the ≤2-repeat promise (1 pin + 2 generated = 3x)
  const pinnedRecipeIds = new Set(pinnedEntries.map((e) => e.recipeId).filter(Boolean));
  const weekFoodPool = new Set(
    pinnedEntries.flatMap((e) => {
      const r = e.recipeId ? byId.get(e.recipeId) : null;
      return r ? [...foodSlugsOf(r)] : [];
    }),
  );
  /** @type {Record<string, number>} */
  let coverageSoFar = foodGroupCoverage(
    pinnedEntries
      .filter((e) => e.recipeId && byId.get(e.recipeId))
      .map((e) => ({ recipe: byId.get(/** @type {string} */ (e.recipeId)), count: e.servings })),
  );

  /** @type {{ dinner: Record<string, any>[], lunch: Record<string, any>[], breakfast: Record<string, any>[], smoothie: Record<string, any>[], snack: Record<string, any>[] }} */
  const committees = { dinner: [], lunch: [], breakfast: [], smoothie: [], snack: [] };
  for (const meal of MEAL_ORDER) {
    const committee = pickCommittee(
      pool(meal).filter((r) => !pinnedRecipeIds.has(r.id)),
      {
        size: COMMITTEE_SIZES[meal],
        salt,
        useSoonFoods,
        weekFoodPool,
        coverageSoFar,
        dailyDozenTargets: dailyDozenWeekly,
      },
    );
    committees[meal] = committee;
    // accrue coverage at each member's EXPECTED weekly appearances (dinner
    // repeats twice; cycled meals appear 7/committee-size times; snacks are
    // top-up only, count once) — otherwise a committee's ~1-serving accrual
    // against 7x weekly targets makes the gap bonus too weak to discriminate
    const expected =
      meal === "dinner" ? 2 : meal === "snack" ? 1 : 7 / Math.max(1, committee.length);
    for (const r of committee) {
      for (const f of foodSlugsOf(r)) weekFoodPool.add(f);
      for (const [k, v] of Object.entries(foodGroupContribution(r, expected))) {
        coverageSoFar[k] = (coverageSoFar[k] ?? 0) + v;
      }
    }
  }

  const fill = (
    /** @type {string} */ date,
    /** @type {string} */ slot,
    /** @type {Record<string, any> | undefined} */ recipe,
  ) => {
    if (!recipe) return;
    if (entriesAt(next.entries, date, slot).length > 0) return; // never overwrite (pins included)
    next = addEntry(next, date, slot, { recipeId: recipe.id, servings: 1 });
  };

  // office-lunch-box hard-pins Tue/Wed/Thu when it exists in the pool
  // (Sunday-batch routine), searched across the full lunch pool — not just
  // whichever 3 recipes made the committee
  const officeLunch = pool("lunch").find((r) => r.id === "office-lunch-box");
  const otherLunches = committees.lunch.filter((r) => r.id !== "office-lunch-box");

  const dinnerRotation = hash(`${weekId}|${salt}|dinner`) % Math.max(1, committees.dinner.length);
  const dinnerSequence = twoPassSequence(committees.dinner, dinnerRotation);
  let dinnerCursor = 0;

  dates.forEach((date, i) => {
    fill(date, "breakfast", committees.breakfast[i % Math.max(1, committees.breakfast.length)]);
    fill(date, "smoothie", committees.smoothie[0]);
    const isOfficeDay = i >= 1 && i <= 3; // Tue/Wed/Thu
    fill(
      date,
      "lunch",
      isOfficeDay && officeLunch
        ? officeLunch
        : (otherLunches[i % Math.max(1, otherLunches.length)] ?? officeLunch ?? committees.lunch[0]),
    );
    if (dinnerCursor < dinnerSequence.length && entriesAt(next.entries, date, "dinner").length === 0) {
      fill(date, "dinner", dinnerSequence[dinnerCursor]);
      dinnerCursor++;
    }
  });

  // Step 3.5: per-day food-group floor pass (greens/cruciferous, per the
  // 2026-07-10 Opus audit) — must run BEFORE macroTopUp so the calorie/
  // protein top-up sees each day's post-floor totals, not the other way
  // around.
  next = foodGroupFloorPass(next, pool("snack"), byId, dailyGroupFloors);

  // Step 4: macro top-up (calories + protein). Uses the FULL snack pool, not
  // just the ingredient-overlap committee: the committee optimizes for a
  // tight shopping list, but this is the safety net for hitting the floor,
  // so it needs every real snack candidate available (2026-07-10 gain-phase
  // bump: the higher 3700/3500 floor needs more headroom than a 2-recipe
  // committee reliably provides).
  next = macroTopUp(next, pool("snack"), byId, floors);

  // Step 5: report, never fudge — short days are judged against the floors
  // but reported against the real goals
  const { proteinShortDays, calorieShortDays } = macroShortfalls(next, byId, dates, floors, {
    protein: proteinTarget,
    calories: caloriesTarget,
  });
  const gaps = foodGroupGapsReport(next.entries, byId, dates, dailyDozenPerDay);
  const poolInsufficient = poolInsufficiency(recipes, dailyDozenPerDay);

  // "what this week shares" reflects what actually landed in the plan
  // (pinned + generated), not just the committees before the top-up
  /** @type {Map<string, any>} */
  const usedRecipes = new Map();
  for (const e of next.entries) {
    const r = e.recipeId ? byId.get(e.recipeId) : null;
    if (r) usedRecipes.set(r.id, r);
  }
  const overlap = overlapReport([...usedRecipes.values()]);

  return {
    plan: next,
    report: {
      shared: overlap.shared,
      distinctItems: overlap.distinctItems,
      proteinShortDays,
      calorieShortDays,
      foodGroupGaps: gaps.perDay,
      foodGroupGapsWeekly: gaps.weekly,
      poolInsufficient,
    },
  };
}
