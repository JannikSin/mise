// Full-week generator (David's "one tap owns the whole week" flow):
// every unpinned entry is cleared and all 7 days x 5 slots are rebuilt from
// scratch around whatever the user pinned. Dinner is still the biggest
// ingredient-mass decision so it's chosen first as a "committee" that
// maximizes shared non-staple ingredients; lunch/breakfast/smoothie/snack
// follow, each rewarded for sharing food with the whole week's pool so far
// (not just its own meal type) and for closing Daily Dozen food-group gaps.
// Every day must clear the calorie and protein floor — a macro top-up stacks
// up to 2 extra items where the picks alone fall short. A final calorie
// CEILING trim then shaves servings back down (snack first, then dinner)
// wherever those floor/top-up passes overshot, without breaking any floor.
// Nothing is silently fudged: days/categories that still miss a target, or
// still sit over the ceiling, are reported plainly, and a pool that
// structurally cannot reach a target (no candidate contributes at all) is
// called out with a plain-English suggestion.

import {
  addEntry,
  dayTotals,
  datesOfWeek,
  entriesAt,
  recipesById,
  slotMacroEstimate,
  untrustedForAutoPlan,
} from "./plan.js";
import { slug, pantryItems, isDatedItem } from "./shopping.js";
import { enforcedCeilings, enforcedFloors } from "./targets.js";
import { seatServingsFor, slotShareFor } from "./tables.js";

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
 * How many of `needles` match the recipe's non-staple foods, by the same
 * bidirectional-substring rule useSoon uses ("mushroom" matches "cremini
 * mushroom" and vice-versa). Shared by the use-soon pantry bonus and the
 * survey-v2 dislike penalty.
 * @param {Record<string, any>} recipe
 * @param {string[]} needles
 */
function foodMatchCount(recipe, needles) {
  const foods = [...foodSlugsOf(recipe)];
  let n = 0;
  for (const needle of needles) {
    const s = slug(String(needle));
    if (s && foods.some((f) => s.includes(f) || f.includes(s))) n++;
  }
  return n;
}

/**
 * Whether a breakfast recipe matches a requested style (survey-v2 Q17). Uses
 * explicit sweet/savory/grab-and-go tags where present, falling back to a
 * foodGroups/effort heuristic for untagged legacy breakfasts.
 * @param {Record<string, any>} r
 * @param {string} style
 * @returns {boolean}
 */
function matchesBreakfastStyle(r, style) {
  const tags = r.tags ?? [];
  const fg = r.foodGroups ?? {};
  const fruit = (Number(fg.berries) || 0) + (Number(fg.otherFruit) || 0);
  if (style === "sweet") return tags.includes("sweet") || fruit > 0.5;
  if (style === "savory") {
    return (
      tags.includes("savory") ||
      ((Number(fg.beans) || 0) + (Number(fg.otherVeg) || 0) > 0.5 && fruit === 0)
    );
  }
  if (style === "grab-and-go") {
    return (
      tags.some((/** @type {string} */ t) =>
        ["grab-and-go", "make-ahead", "blend-and-go"].includes(t),
      ) || r.effort === "assembly"
    );
  }
  return false;
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
 * Survey-v2 taste WEIGHTS (never filters — a weight can't empty a pool):
 * disliked-ingredient recipes lose ties (`dislikeIngredients`), loved/avoided
 * cuisines nudge (`cuisinePrefs`), a tight `budget` rewards the "cheap" tag +
 * beans and doubles the ingredient-overlap dial so the week converges on
 * fewer distinct items, and `breakfastStyle` (breakfast committee only)
 * rewards a style match.
 * @param {Record<string, any>[]} candidates
 * @param {{
 *   size?: number,
 *   salt?: number,
 *   useSoonFoods?: string[],
 *   onHandFoods?: string[],
 *   avoidOverlapFoods?: string[],
 *   weekFoodPool?: Set<string>,
 *   coverageSoFar?: Record<string, number>,
 *   dailyDozenTargets?: Record<string, number>,
 *   dislikeIngredients?: string[],
 *   tiredOf?: string[],
 *   recentRecipeIds?: Set<string> | string[],
 *   cuisinePrefs?: { loved: string[], avoided: string[] },
 *   budget?: "tight" | "normal" | "loose",
 *   breakfastStyle?: string,
 *   proteinRatioNeeded?: number
 * }} [opts]
 * @returns {Record<string, any>[]}
 */
export function pickCommittee(candidates, opts = {}) {
  candidates = candidates.filter((c) => c.effort !== "project");
  const size = Math.min(opts.size ?? 4, candidates.length);
  const salt = opts.salt ?? 0;
  const useSoon = opts.useSoonFoods ?? [];
  // everything countable already in the kitchen (fridge-first shopping,
  // David 2026-08-01): a weaker pull than useSoon's expiry rescue, but every
  // recipe that cooks owned food is food not bought
  const onHand = opts.onHandFoods ?? [];
  // foods from OTHER cooks' family-dinner nights: a soft push-AWAY (never a
  // filter), so my own meals cluster around my own cook nights and the
  // family's week stays varied across cooks (David, 2026-08-01)
  const avoidOverlap = opts.avoidOverlapFoods ?? [];
  const weekFoodPool = opts.weekFoodPool ?? new Set();
  const coverageSoFar = opts.coverageSoFar ?? {};
  const dailyDozenTargets = opts.dailyDozenTargets ?? {};
  const dislikes = opts.dislikeIngredients ?? [];
  // What FRACTION of this profile's calories has to come from protein
  // (protein g x 4 / daily kcal). Absent = the old profile-blind gram count.
  //
  // This exists because a gram count is the wrong unit for a small profile
  // (David, 2026-08-10). A small loss profile can need 110 g inside 1550 kcal, 28% of
  // her calories from protein, while her breakfast and snack pools sit near
  // 20%. Picking on absolute grams handed her meals that could not reach her
  // protein without extra calories, so the top-up pass added them and her day
  // ran over its ceiling. Picking on DENSITY hands her the food that already
  // fits — her bank has plenty of it, up to 45%.
  const needRatio = Number(opts.proteinRatioNeeded) || 0;
  // "eaten too much of lately" (survey: break the year-long rut). Softer than
  // a dislike: a mild tie-loser so the week drifts toward variety without ever
  // banning the food outright.
  const tiredOf = opts.tiredOf ?? [];
  // recipes cooked in the last week or two: a real penalty so consecutive
  // weeks ROTATE (David is fine eating one dish all week, but wants next week
  // to look different). Strong enough to lose to any fresh option, soft enough
  // that a thin pool can still fall back to a repeat rather than fail.
  const recent =
    opts.recentRecipeIds instanceof Set
      ? opts.recentRecipeIds
      : new Set(opts.recentRecipeIds ?? []);
  const loved = new Set(opts.cuisinePrefs?.loved ?? []);
  const avoided = new Set(opts.cuisinePrefs?.avoided ?? []);
  const tight = opts.budget === "tight";
  const breakfastStyle = opts.breakfastStyle;
  // survey-v2 Q18: tight budget doubles the ingredient-overlap dial (the
  // existing core of committee scoring) so weeks converge on fewer shop items.
  const overlapWeight = tight ? 2 : 1;
  if (size === 0) return [];

  const jitter = (/** @type {Record<string, any>} */ r) => (hash(`${r.id}|${salt}`) % 997) / 9970;
  const tasteBonus = (/** @type {Record<string, any>} */ r) => {
    let b = 0;
    b += foodMatchCount(r, dislikes) * -2;
    b += foodMatchCount(r, tiredOf) * -1;
    if (loved.has(r.cuisine)) b += 1;
    if (avoided.has(r.cuisine)) b += -3;
    if (tight) {
      // survey-v2 Q18 budget WEIGHT. This is a real proxy, not invented
      // prices: the "cheap" tag is author-set and beans are the bank's
      // cheapest protein. ponytail: per-recipe price data (a future
      // receipt-scanning feature keyed by targets.stores) plugs in HERE —
      // replace the tag/beans proxy with an actual cost term once
      // recipe.priceEstimate (or a per-store price map) exists.
      if ((r.tags ?? []).includes("cheap")) b += 1;
      b += (Number(r.foodGroups?.beans) || 0) * 0.5;
    }
    if (breakfastStyle && matchesBreakfastStyle(r, breakfastStyle)) b += 1.5;
    return b;
  };
  /** Protein score: density against what the profile needs, or the old
   *  absolute gram nudge when no ratio was supplied. Bounded so it nudges
   *  the pick rather than overriding ingredient overlap outright. */
  const proteinTerm = (/** @type {Record<string, any>} */ r) => {
    const cal = r.nutrition?.calories ?? 0;
    const prot = r.nutrition?.protein ?? 0;
    if (!needRatio || cal <= 0) return prot / 200;
    const ratio = (prot * 4) / cal;
    return Math.max(-1.5, Math.min(1.5, ((ratio - needRatio) / needRatio) * 2));
  };
  const bonus = (/** @type {Record<string, any>} */ r) =>
    foodMatchCount(r, useSoon) * 3 +
    foodMatchCount(r, onHand) * 1 +
    foodMatchCount(r, avoidOverlap) * -0.75 +
    proteinTerm(r) +
    foodGroupGapBonus(r, coverageSoFar, dailyDozenTargets) * 2 +
    tasteBonus(r) +
    (recent.has(r.id) ? -2.5 : 0) +
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
    const score = overlapWith(c, seedTarget) * overlapWeight + bonus(c);
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
      const score = overlapWith(c, committeeFoods) * overlapWeight + bonus(c);
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
    // viewRecipeId: a family-dinner table entry really delivers its food
    // groups to my day — counting it in week coverage but not here made the
    // floor pass stack snacks for greens dinner already served (review #7)
    const rid = e.recipeId ?? /** @type {any} */ (e).viewRecipeId;
    if (e.date !== date || !rid) continue;
    // groupScale (per-person-plates spec §11.2): a SOLVED table plate can
    // carry less of a bucket than the recipe's per-serving figure — a loss
    // seat at beta 0.4 gets 40% of the flaxseed, and crediting the full
    // figure would silently overstate the Daily Dozen. Absent (every
    // uniform entry) = 1, today's arithmetic exactly.
    const scale = /** @type {any} */ (e).groupScale?.[group] ?? 1;
    total += (recipesById.get(rid)?.foodGroups?.[group] ?? 0) * e.servings * scale;
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
 * @param {{ calorieCeiling?: number }} [opts] when a ceiling is given, this
 *   pass stops trading calories for food groups at any price: a serving bump
 *   that would cross the ceiling is refused so the cheaper lever runs
 *   instead, and the added-recipe lever prefers the candidate that closes the
 *   gap for the fewest calories. Absent = the old unbounded behavior.
 * @returns {import("./plan.js").Plan}
 */
export function foodGroupFloorPass(plan, pool, recipesById, floors, opts = {}) {
  const candidates = pool.filter((r) => r.effort !== "project");
  const ceiling = Number(opts.calorieCeiling) || Infinity;
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
        const perServing =
          recipesById.get(/** @type {string} */ (entry.recipeId))?.nutrition?.calories ?? 0;
        while (
          servings + 0.5 <= MAX_ENTRY_SERVINGS &&
          dayGroupTotal(next.entries, recipesById, date, group) < floor
        ) {
          // a bump that would blow the day's calorie ceiling is refused, and
          // lever 2 below closes the gap with something cheap instead. This is
          // the difference between reaching 3 bean servings by growing a 540
          // kcal farro bowl to 1.75x and reaching it with a 95 kcal edamame
          // side — on a 1550 kcal loss profile the first one costs the day.
          if (dayTotals(next.entries, recipesById, date).calories + perServing * 0.5 > ceiling) {
            break;
          }
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
        // with a ceiling in play, what matters is calories per serving of the
        // group closed, not raw contribution: a cheap side that has to be
        // eaten twice still beats a dense bowl eaten once
        const kcalPerUnit = (c.nutrition?.calories ?? 0) / contribution;
        const costPenalty = Number.isFinite(ceiling) ? kcalPerUnit / 40 : 0;
        const score =
          overlapWith(c, weekFoodPool) * 10 +
          contribution -
          costPenalty +
          (hash(`${c.id}|${date}|${group}`) % 997) / 9970;
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
 * @param {number} [maxSnackStacks] survey-v2 Q11 snackAppetite cap: 3 for a
 *   grazer (default, today's behavior), 1 for a "three-squares" eater (the
 *   portion-bump lever, tried first, then does more of the work)
 * @param {{
 *   budget?: "tight" | "normal" | "loose",
 *   weekFoodPool?: Set<string>,
 *   report?: Record<string, any>,
 *   proteinTargetG?: number
 * }} [opts] fix list 2.4 (council 2026-08-18): macroTopUp takes the SAME
 *   budget parameter as pickCommittee. Without it the budget dial was a
 *   waste generator: tight pushed dinners to bean stews, opened a calorie
 *   hole, and this pass filled it from a pool sorted on protein alone,
 *   trading 10 fully-consumed protein SKUs for 16 perishable produce items.
 *   `report`, when passed, receives a `macroTopUp` entry for the manifest.
 *   `proteinTargetG` (7.11, P5): a day already at its protein TARGET stops
 *   getting protein-first fills — bumps and snacks buy calories lean instead.
 * @returns {import("./plan.js").Plan}
 */
export function macroTopUp(plan, snackPool, recipesById, floors, maxSnackStacks = 3, opts = {}) {
  let pool = snackPool.filter((r) => r.effort !== "project");
  const poolBefore = pool.length;
  // tight restricts the pool to snacks that share food with the week or
  // carry the author-set "cheap" tag. Honest-relax like the Q12 time cap: a
  // restriction leaving fewer than 2 candidates is ignored and reported,
  // never silently fudged.
  const tight = opts.budget === "tight";
  const weekFoods = opts.weekFoodPool ?? new Set();
  let restricted = false;
  let relaxed = false;
  if (tight) {
    const kept = pool.filter(
      (r) => (r.tags ?? []).includes("cheap") || overlapWith(r, weekFoods) > 0,
    );
    if (kept.length >= 2) {
      pool = kept;
      restricted = true;
    } else {
      relaxed = true;
    }
  }
  if (opts.report) {
    opts.report.macroTopUp = {
      budget: opts.budget ?? "normal",
      poolBefore,
      poolAfter: pool.length,
      restricted,
      relaxed,
    };
  }
  const dates = [...new Set(plan.entries.map((e) => e.date))].sort();
  if (dates.length === 0) return plan;

  const bestFor = (
    /** @type {boolean} */ needProtein,
    /** @type {boolean} */ leanCalories,
    /** @type {Set<string>} */ exclude,
  ) =>
    [...pool]
      .filter((r) => !exclude.has(r.id))
      .sort((a, b) => {
        const pa = a.nutrition?.protein ?? 0;
        const pb = b.nutrition?.protein ?? 0;
        const ca = a.nutrition?.calories ?? 0;
        const cb = b.nutrition?.calories ?? 0;
        if (needProtein) return pb - pa || cb - ca;
        // a day whose protein TARGET is already banked (an away/swipe credit,
        // 7.11) is buying calories here, not protein — rank by NON-protein
        // calories so a lean 540-kcal snack really beats a 570-kcal protein
        // plate. A mere same-calorie tiebreak never fires against the real
        // pool (23 distinct calorie values in 27 snacks; reviewer catch
        // 2026-08-19: that is the ships-dark failure mode by name).
        if (leanCalories) return cb - pb * 4 - (ca - pa * 4);
        return cb - ca || pb - pa;
      })[0];

  let next = plan;
  const shortOf = (/** @type {string} */ date) => {
    const totals = dayTotals(next.entries, recipesById, date);
    return {
      protein: totals.protein < floors.protein,
      any: totals.protein < floors.protein || totals.calories < floors.calories,
    };
  };
  // protein target met = stop optimizing for it (floor logic above is
  // untouched; this only stops ADDING protein past the goal, never trims)
  const proteinEnough = (/** @type {string} */ date) =>
    opts.proteinTargetG != null &&
    dayTotals(next.entries, recipesById, date).protein >= opts.proteinTargetG;

  for (const date of dates) {
    // lever 1: portion bumps on already-chosen meals, 0.5 steps at a time.
    // A day whose protein target is already banked (7.11 swipe credit) bumps
    // its LEANEST meal first — the bump is buying calories, not protein.
    const bumpCandidates = PORTION_BUMPS.map(({ slot, maxBump }) => ({
      maxBump,
      target: entriesAt(next.entries, date, slot).find(
        (e) => !e.pinned && e.recipeId && recipesById.has(e.recipeId),
      ),
    })).filter((c) => c.target);
    if (proteinEnough(date)) {
      const densityOf = (/** @type {import("./plan.js").PlanEntry | undefined} */ e) => {
        const n = e?.recipeId ? (recipesById.get(e.recipeId)?.nutrition ?? {}) : {};
        return (n.calories ?? 0) > 0 ? (n.protein ?? 0) / n.calories : 0;
      };
      bumpCandidates.sort((a, b) => densityOf(a.target) - densityOf(b.target));
    }
    for (const { target, maxBump } of bumpCandidates) {
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
    for (let stacked = 0; stacked < maxSnackStacks; stacked++) {
      const s = shortOf(date);
      if (!s.any) break;
      const pick = bestFor(s.protein, proteinEnough(date), maxedOut);
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
 * Whether trimming ENTRIES down for `date` to these servings would push the
 * day below any hard floor: calories, protein, or an enforced daily group.
 * @param {import("./plan.js").PlanEntry[]} entries
 * @param {Map<string, any>} recipesById
 * @param {string} date
 * @param {{ calorieFloor: number, proteinFloor: number, groupFloors: Record<string, number> }} bounds
 * @returns {boolean}
 */
function breaksFloor(entries, recipesById, date, bounds) {
  const totals = dayTotals(entries, recipesById, date);
  if (totals.calories < bounds.calorieFloor) return true;
  if (totals.protein < bounds.proteinFloor) return true;
  for (const [group, floor] of Object.entries(bounds.groupFloors ?? {})) {
    if (dayGroupTotal(entries, recipesById, date, group) < floor) return true;
  }
  return false;
}

/**
 * Per-day calorie CEILING trim: the mirror of foodGroupFloorPass and
 * macroTopUp above, which only ever ADD servings. Left unchecked, days
 * routinely overshoot the calorie target by 5-9%. Runs LAST, after those two
 * passes, and only ever REDUCES servings, in 0.5 steps, cheapest collateral
 * damage first: an unpinned snack entry, then the highest-calorie non-dinner
 * entry (breakfast/lunch/smoothie), then dinner. An entry never drops below
 * 0.5 servings and is never removed outright, that's what a re-roll is for.
 *
 * Every candidate step is re-checked against `bounds` before it's applied: a
 * step that would push the day below the calorie floor, the protein floor,
 * or any enforced daily group floor is rejected and the next candidate is
 * tried instead. If every candidate is rejected, the day is left over the
 * ceiling, honestly reported by the caller as `calorieOverDays`, never
 * fudged. Pinned entries are never touched. Pure and deterministic (salted
 * hash tiebreak only, no Math.random/Date.now).
 * @param {import("./plan.js").Plan} plan
 * @param {Map<string, any>} recipesById
 * @param {{
 *   calorieCeiling: number,
 *   calorieFloor: number,
 *   proteinFloor: number,
 *   groupFloors: Record<string, number>
 * }} bounds
 * @returns {import("./plan.js").Plan}
 */
export function calorieTrimPass(plan, recipesById, bounds) {
  const dates = [...new Set(plan.entries.map((e) => e.date))].sort();
  let next = plan;

  const tierOf = (/** @type {import("./plan.js").PlanEntry} */ e) => {
    if (e.slot === "snack") return 0;
    if (e.slot === "dinner") return 2;
    return 1;
  };

  for (const date of dates) {
    for (;;) {
      const totals = dayTotals(next.entries, recipesById, date);
      if (totals.calories <= bounds.calorieCeiling) break;

      const trimmable = next.entries
        .filter(
          (e) =>
            e.date === date &&
            !e.pinned &&
            e.recipeId &&
            recipesById.has(e.recipeId) &&
            e.servings > 0.5,
        )
        .sort((a, b) => {
          const ta = tierOf(a);
          const tb = tierOf(b);
          if (ta !== tb) return ta - tb;
          const ca = recipesById.get(/** @type {string} */ (a.recipeId))?.nutrition?.calories ?? 0;
          const cb = recipesById.get(/** @type {string} */ (b.recipeId))?.nutrition?.calories ?? 0;
          return cb - ca || hash(`${a.id}|trim`) - hash(`${b.id}|trim`);
        });

      let applied = false;
      for (const entry of trimmable) {
        const servings = Math.max(0.5, entry.servings - 0.5);
        const candidateEntries = next.entries.map((e) =>
          e.id === entry.id ? { ...e, servings } : e,
        );
        if (breaksFloor(candidateEntries, recipesById, date, bounds)) continue;
        next = { ...next, entries: candidateEntries };
        applied = true;
        break;
      }
      if (!applied) break; // every candidate would break a floor: leave the day over ceiling
    }
  }
  return next;
}

/**
 * Protein/calorie floor misses, per day, after the top-up has run. Days are
 * COMPARED against the profile's written floors, but the report carries the real goals
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
      .map((e) => ({ e, rid: e.recipeId ?? /** @type {any} */ (e).viewRecipeId }))
      .filter(({ e, rid }) => e.date === date && rid)
      .map(({ e, rid }) => ({
        recipe: recipesById.get(/** @type {string} */ (rid)),
        count: e.servings,
      }))
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
 * The generator's trust gate. Two classes never get auto-planned:
 *
 *  - `ai-special` / `hbp-annotated`: AI-written recipes (invented specials,
 *    HBP-annotated scans). They may be chosen deliberately as a table or from
 *    the cookbook, but never auto-planned into a deterministic week until a
 *    human or Greger audit sets `promoted: true` on the recipe file. The
 *    predicate is shared with brigadePool via plan.js.
 *  - `occasion-only`: food that exists to serve one dated situation — clear
 *    broth and lemon gelatin for a colonoscopy prep, white toast for a
 *    low-residue stretch. Nutritionally these are terrible normal meals and
 *    the generator must never reach for them. They are placed BY an occasion,
 *    never picked. Unlike ai-special there is no promotion escape: apple
 *    juice does not become a good Tuesday snack once somebody audits it.
 * @param {Record<string, any>[]} recipes
 * @returns {Record<string, any>[]}
 */
export function generatorEligible(recipes) {
  return recipes.filter((r) => {
    const tags = r.tags ?? [];
    if (tags.includes("occasion-only")) return false;
    return !untrustedForAutoPlan(r);
  });
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

// The calorie ceiling multiplier moved to targets.js on 2026-08-19 (session
// koenig), as `enforcedCeilings`, beside `enforcedFloors`. It was computed
// inline twice in this file and read by nothing that outlived a generate,
// which is how a live week sat over its ceiling with nothing saying so. The
// reasoning for the floor/ceiling asymmetry travelled with it.

const COMMITTEE_SIZES = { dinner: 4, lunch: 3, breakfast: 2, smoothie: 1 };
/**
 * Committee-build / proactive-fill priority (dinner = biggest ingredient
 * mass, decided first). Snack is never in this list — it's always the
 * reactive top-up pool (macroTopUp, foodGroupFloorPass), pulled from the
 * full snack pool regardless of targets.mealSlots.
 */
const MEAL_PRIORITY = /** @type {const} */ (["dinner", "lunch", "breakfast", "smoothie"]);
/** Proactively-filled slots when targets.mealSlots is absent — David's exact current behavior. */
const DEFAULT_MEAL_SLOTS = /** @type {const} */ (["breakfast", "lunch", "dinner", "smoothie"]);

/**
 * Whether a profile's (already merged/filtered) recipe pool can actually
 * feed its targets — the "new 4000 kcal track-season profile" problem: the
 * bank may simply lack enough recipes of the right type/size, and that
 * should be said OUT LOUD instead of discovered as a mystery of repeats
 * and snack-stacking. Checks two things per the generator's real rules:
 * committee depth per proactive slot (repeats explode below it) and an
 * optimistic best-case day (every slot's biggest recipe at the 2x serving
 * cap + 3 stacked snacks) against the calorie target.
 * @param {Record<string, any>[]} recipes the profile's merged pool
 * @param {Record<string, any> | null} targets
 * @returns {{ counts: Record<string, number>, warnings: string[] }}
 */
export function poolAdequacy(recipes, targets) {
  const usable = generatorEligible(recipes).filter((r) => r.effort !== "project");
  const mealSlots = /** @type {string[]} */ (targets?.mealSlots ?? [...DEFAULT_MEAL_SLOTS]);
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {string[]} */
  const warnings = [];
  const needs = /** @type {Record<string, number>} */ ({ ...COMMITTEE_SIZES, snack: 2 });
  for (const slot of [...mealSlots, "snack"]) {
    const pool = usable.filter((r) => r.mealType === slot);
    counts[slot] = pool.length;
    const need = needs[slot] ?? 1;
    if (pool.length < need) {
      warnings.push(
        `only ${pool.length} ${slot} recipe${pool.length === 1 ? "" : "s"} fit this profile (wants ${need}+) — expect repeats until more are added`,
      );
    }
  }
  const caloriesTarget = targets?.macros?.calories;
  if (caloriesTarget) {
    const maxCal = (/** @type {string} */ slot) =>
      Math.max(
        0,
        ...usable.filter((r) => r.mealType === slot).map((r) => r.nutrition?.calories ?? 0),
      );
    // optimistic ceiling: biggest recipe per proactive slot at the 2x
    // serving cap, plus macroTopUp's 3 snack stacks at 2x
    const bestDay =
      mealSlots.reduce((s, slot) => s + maxCal(slot) * 2, 0) + maxCal("snack") * 2 * 3;
    if (bestDay < caloriesTarget) {
      warnings.push(
        `even the biggest possible day (~${Math.round(bestDay)} kcal) can't reach the ${caloriesTarget} kcal target — the bank needs bigger or more recipes for this phase`,
      );
    } else if (bestDay < caloriesTarget * 1.2) {
      warnings.push(
        `the ${caloriesTarget} kcal target is reachable but tight (best case ~${Math.round(bestDay)}) — most days will lean on portion bumps and snack stacking`,
      );
    }
  }
  return { counts, warnings };
}

/**
 * @typedef {{
 *   shared: { food: string, count: number }[],
 *   distinctItems: number,
 *   proteinShortDays: { date: string, protein: number, target: number }[],
 *   calorieShortDays: { date: string, calories: number, target: number }[],
 *   foodGroupGaps: { date: string, group: string, have: number, target: number }[],
 *   foodGroupGapsWeekly: { group: string, have: number, target: number }[],
 *   poolInsufficient: { reason: string, suggestion: string }[],
 *   calorieOverDays: { date: string, calories: number, ceiling: number }[],
 *   timeBudgetRelaxed: string[],
 *   outDays: { date: string, slots: string[], estCalories: number, estProtein: number }[],
 *   occasionDays: { date: string, occasion: string, name: string }[],
 *   manifest: Record<string, any>
 * }} WeekReport
 */

/**
 * Full-week generation: clears every UNPINNED entry, rebuilds 7 days around
 * the proactively-filled meal slots. Which slots get proactively filled is
 * profile-driven: `targets.mealSlots` (ordered list) names them; absent
 * defaults to `["breakfast", "lunch", "dinner", "smoothie"]` (David's exact
 * current behavior). Snack is never in that list — it's always the reactive
 * top-up pool (macroTopUp, foodGroupFloorPass), never proactively committee-
 * picked. Pinned entries are never touched and seed the greedy scoring
 * (their foods/food-groups count toward "already in play"). Among the listed
 * slots, dinner is picked first (biggest ingredient mass), then lunch,
 * breakfast, smoothie — each committee sees the growing week-wide food pool
 * and coverage. Lunches cycle their committee like breakfasts do — no recipe
 * is ever hard-pinned by id (the office-lunch-box special case died 2026-08-01;
 * David: never again. A profile that wants it banned outright lists it in
 * targets.avoidRecipes).
 * Deterministic per (weekId, salt); RE-ROLL is salt+1 over the same pinned
 * base.
 * @param {{
 *   recipes: Record<string, any>[],
 *   targets: Record<string, any> | null,
 *   pantry: Record<string, any>,
 *   weekId: string,
 *   plan: import("./plan.js").Plan,
 *   salt?: number,
 *   recentRecipeIds?: string[],
 *   today?: string
 * }} args `today` (local YYYY-MM-DD) makes generation day-aware: dates
 *   strictly before it are PAST — their entries survive verbatim (pinned or
 *   not), nothing new is filled there, no pass resizes them, no report line
 *   mentions them, and weekly targets + buffer portions scale to the live
 *   days that remain. Absent = full 7-day behavior (future weeks, tests).
 * @returns {{ plan: import("./plan.js").Plan, report: WeekReport }}
 */
export function generateWeek({
  recipes,
  targets,
  pantry,
  weekId,
  plan,
  salt = 0,
  recentRecipeIds = [],
  today,
}) {
  // council 2026-07-23: an AI estimate may propose and display, but must
  // never silently enter the generator's trusted denominator. ai-special
  // recipes (dinner-discussion inventions, estimated macros) stay settable
  // as tables but are excluded from every committee until promoted.
  recipes = generatorEligible(recipes);
  const recentSet = new Set(recentRecipeIds);
  const dates = datesOfWeek(weekId);
  const isPast = (/** @type {string} */ d) => Boolean(today) && d < /** @type {string} */ (today);
  // OCCASION days are HELD (David, 2026-08-10). A dated override — a medical
  // prep, a holiday, a travel stretch — replaces those days with a fixed
  // script the person already accepted, and generation hands off completely:
  // same treatment as a day already eaten. Without this the macro top-up
  // would stack four snacks onto a clear-liquid colonoscopy-prep day trying
  // to reach a 1400 kcal floor, which is exactly the failure the occasion
  // exists to prevent. Held dates are read off the ENTRIES (`e.occasion`),
  // not passed in, so a device that syncs the plan gets the hold for free.
  const heldDates = new Set(
    plan.entries.filter((e) => e.occasion && !isPast(e.date)).map((e) => e.date),
  );
  const isHeld = (/** @type {string} */ d) => heldDates.has(d);
  const liveDates = dates.filter((d) => !isPast(d) && !isHeld(d));
  const byId = recipesById(recipes);
  const datedPantry = pantryItems(pantry).filter(isDatedItem);
  const useSoonFoods = datedPantry
    .filter((/** @type {any} */ p) => p.useSoon)
    .map((/** @type {any} */ p) => String(p.food));
  // every dated item on the shelves, expiring or not: committees lean toward
  // cooking what the house already owns, so the shopping list shrinks
  const onHandFoods = [...new Set(datedPantry.map((/** @type {any} */ p) => String(p.food)))];

  // survey-v2 FILTERS applied at pool level (Q12 time, Q15 skill, Q16 gear).
  // maxWeeknightMinutes caps only dinner/lunch (breakfast/smoothie/snack are
  // near-universally quick); maxDifficulty and equipment apply to every pool.
  const maxMinutes = targets?.maxWeeknightMinutes;
  const maxDifficulty = targets?.maxDifficulty;
  const haveEquipment = targets?.equipment; // what the profile HAS; absent = has everything
  const lacksGear = (/** @type {Record<string, any>} */ r) =>
    Array.isArray(haveEquipment) &&
    (r.equipment ?? []).some((/** @type {string} */ e) => !haveEquipment.includes(e));
  /** @type {string[]} slots where the time cap emptied the pool and was relaxed (Q12 honest-failure) */
  const timeBudgetRelaxed = [];
  const pool = (/** @type {string} */ meal) => {
    let list = recipes.filter((r) => r.mealType === meal);
    if (Array.isArray(haveEquipment)) list = list.filter((r) => !lacksGear(r));
    if (maxDifficulty != null) list = list.filter((r) => (r.difficulty ?? 1) <= maxDifficulty);
    if (maxMinutes != null && (meal === "dinner" || meal === "lunch")) {
      const capped = list.filter((r) => (r.totalTime ?? 0) <= maxMinutes);
      // honest-failure: a cap that leaves fewer than 2 candidates is ignored
      // for this slot and reported plainly, never silently fudged.
      if (capped.length >= 2) list = capped;
      else if (!timeBudgetRelaxed.includes(meal)) timeBudgetRelaxed.push(meal);
    }
    return list;
  };

  // Step 1: clear every unpinned entry; pinned entries are the only
  // pre-existing content the rest of generation builds around.
  // Eating-out placeholders (slot OUT toggle, always pinned so they survive
  // the clear) get their assumed macros backfilled from the live pool if
  // they arrived without one (pre-estimate data, hand edits): the credit is
  // what lets every floor/top-up/trim pass plan the REST of the day around
  // a realistic total instead of snack-stacking a fictional 900-kcal hole.
  // Past-day entries are set aside UNTOUCHED and merged back at the end:
  // the floor/top-up/trim passes derive their date lists from plan.entries,
  // so keeping past entries out of the working plan is what keeps every
  // pass (and the report) off days already eaten.
  // held (occasion) entries ride along with the past ones: set aside whole,
  // untouched by every pass, merged back at the end. A non-occasion entry
  // that happens to sit on a held day goes with them rather than being
  // cleared, so an occasion never silently deletes something hand-placed.
  const pastEntries = plan.entries.filter((e) => isPast(e.date) || isHeld(e.date));
  const pinnedEntries = plan.entries
    .filter((e) => e.pinned && !isPast(e.date) && !isHeld(e.date))
    .map((e) =>
      e.out && e.estCalories == null ? { ...e, ...slotMacroEstimate(recipes, e.slot) } : e,
    );
  let next = { ...plan, week: weekId, entries: pinnedEntries };

  const outDays = [...new Set(pinnedEntries.filter((e) => e.out).map((e) => e.date))]
    .sort()
    .map((date) => {
      const dayOuts = pinnedEntries.filter((e) => e.out && e.date === date);
      return {
        date,
        slots: dayOuts.map((e) => e.slot),
        estCalories: dayOuts.reduce((s, e) => s + (e.estCalories ?? 0), 0),
        estProtein: dayOuts.reduce((s, e) => s + (e.estProtein ?? 0), 0),
      };
    });

  // 7.11 (P5): away/swipe slots deliver their estimated macros for free, so
  // the COOKED week aims at what REMAINS. A buffet swipe is protein-loaded
  // (buffetMacroEstimate), which LOWERS the remaining protein density the
  // committees score against — that is the whole arbitrage: swipe days eat
  // the expensive macro where its marginal cost is zero, and the grocery
  // list buys less of it. With no away slots every number below reduces to
  // exactly the old week-constant behavior.
  const awayCredit = {
    calories: outDays.reduce((s, d) => s + d.estCalories, 0),
    protein: outDays.reduce((s, d) => s + d.estProtein, 0),
    slots: outDays.reduce((s, d) => s + d.slots.length, 0),
  };

  // P3, no invented person. These two lines read `?? 210` and `?? 3400`,
  // which are DAVID'S targets from an earlier phase. A profile whose targets
  // could not be read did not fail: it quietly generated a week aimed at him,
  // and every downstream floor, top-up and trim pass then enforced a stranger's
  // numbers on somebody else. The fallbacks were dormant on the one device
  // anybody tests on, which is precisely why they survived every audit.
  // Generation is an explicit, personalised, online act (P2), so refusing it
  // out loud is correct and silence is not.
  const proteinTarget = Number(targets?.macros?.protein);
  const caloriesTarget = Number(targets?.macros?.calories);
  if (!(proteinTarget > 0) || !(caloriesTarget > 0)) {
    throw new Error(
      "generateWeek: this profile has no calorie and protein target. Mise does not aim a week " +
        "at a person it cannot read (P3). Set macros.calories and macros.protein on the profile.",
    );
  }
  // the floors the profile actually WROTE, never a ratio of the target
  // (see enforcedFloors — this used to be caloriesTarget * 0.95)
  const floors = enforcedFloors({
    ...targets?.macros,
    calories: caloriesTarget,
    protein: proteinTarget,
  });
  // the ceilings, from the same one place the manifest reads them, so the
  // number the trim pass enforces and the number the report prints can never
  // drift apart (they did: the ceiling was inlined twice here and reported
  // nowhere that survived an edit)
  const ceilings = enforcedCeilings({ ...targets?.macros, calories: caloriesTarget });
  const dailyDozenPerDay = targets?.dailyDozen ?? {};
  // greedy committee scoring accumulates at week-level for efficiency (R1);
  // the REPORT is still computed per day from the actual generated plan
  const dailyDozenWeekly = Object.fromEntries(
    Object.entries(dailyDozenPerDay).map(([k, v]) => [k, Number(v) * liveDates.length]),
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
  // FAMILY DINNERS shape the week two ways (David, 2026-08-01: "my lunch
  // ingredients should overlap with what I cook for dinner, so when someone
  // else cooks it is different food"). Derived table entries carry
  // viewRecipeId (never recipeId — that would make every guest shop the
  // dish), so the old seeding above cannot see them. Nights I COOK
  // (cookTotal is a cook-device-only derived field) join the overlap pool:
  // my breakfasts and lunches converge on ingredients I am already buying
  // for the shared pot. OTHER cooks' dinner foods become a SOFT push-away,
  // so each member's own meals cluster around their own cook nights and the
  // household's week stays varied across cooks instead of everyone orbiting
  // Monday's dinner.
  // DEDUPED (review #6): foodMatchCount scores per needle, so a food pushed
  // once per dinner compounded -0.75 into a de-facto ban stronger than a
  // dislike. One distinct food = one soft push, per the comment's promise.
  const otherCookSet = new Set();
  for (const e of pinnedEntries) {
    const anyE = /** @type {any} */ (e);
    if (!anyE.table || !anyE.viewRecipeId) continue;
    const r = byId.get(anyE.viewRecipeId);
    if (!r) continue; // dinner outside my phase pool: no signal either way
    if (anyE.cookTotal != null) {
      for (const f of foodSlugsOf(r)) weekFoodPool.add(f);
    } else {
      for (const ing of r.ingredients ?? []) {
        if (!ing.staple && ing.food) otherCookSet.add(String(ing.food).toLowerCase());
      }
    }
  }
  const otherCookFoods = [...otherCookSet];
  /** @type {Record<string, number>} */
  const coverageSoFar = foodGroupCoverage(
    pinnedEntries
      // table entries count via viewRecipeId: the shared dinner really does
      // deliver its food groups to my day, and pretending otherwise made the
      // generator over-plan the categories dinner already covers
      .map((e) => ({ e, rid: e.recipeId ?? /** @type {any} */ (e).viewRecipeId }))
      .filter(({ rid }) => rid && byId.get(rid))
      .map(({ e, rid }) => ({
        recipe: byId.get(/** @type {string} */ (rid)),
        count: e.servings,
      })),
  );

  // the committees score protein density against the REMAINING need (see
  // awayCredit above): week protein minus away credit, over week calories
  // minus away credit. Identical to the old (proteinTarget*4)/caloriesTarget
  // when nothing is away. CLAMPED into [0.05, 1] (reviewer catches
  // 2026-08-19): a raw 0 would trip pickCommittee's !needRatio fallback and
  // flip the term to "maximize protein" on an all-swipe week — the exact
  // inverse of the intent — and credits that eat the calorie budget faster
  // than the protein budget can push the raw ratio into the thousands,
  // which clamps every recipe's term to a constant and silently switches
  // protein scoring off. 0.05 keeps "leaner wins" ordering; 1 is the
  // physical ceiling (all-protein calories).
  const weekProteinNeed = Math.max(0, proteinTarget * liveDates.length - awayCredit.protein);
  const weekCaloriesNeed = Math.max(1, caloriesTarget * liveDates.length - awayCredit.calories);
  const remainingNeedRatio =
    caloriesTarget > 0 && liveDates.length > 0
      ? Math.min(1, Math.max(0.05, (weekProteinNeed * 4) / weekCaloriesNeed))
      : 0;

  // which slots get proactively filled/committee-picked is profile-driven;
  // snack is never in this set, it's always the reactive top-up pool
  const mealSlots = targets?.mealSlots ?? DEFAULT_MEAL_SLOTS;
  const mealSlotSet = new Set(mealSlots);
  const mealOrder = MEAL_PRIORITY.filter((m) => mealSlotSet.has(m));

  /** @type {{ dinner: Record<string, any>[], lunch: Record<string, any>[], breakfast: Record<string, any>[], smoothie: Record<string, any>[] }} */
  const committees = { dinner: [], lunch: [], breakfast: [], smoothie: [] };
  for (const meal of mealOrder) {
    const committee = pickCommittee(
      pool(meal).filter((r) => !pinnedRecipeIds.has(r.id)),
      {
        size: COMMITTEE_SIZES[meal],
        salt,
        useSoonFoods,
        onHandFoods,
        avoidOverlapFoods: otherCookFoods,
        weekFoodPool,
        coverageSoFar,
        dailyDozenTargets: dailyDozenWeekly,
        dislikeIngredients: targets?.dislikeIngredients,
        proteinRatioNeeded: remainingNeedRatio,
        tiredOf: targets?.tiredOf,
        recentRecipeIds: recentSet,
        cuisinePrefs: targets?.cuisinePrefs,
        budget: targets?.budget,
        breakfastStyle: meal === "breakfast" ? targets?.breakfastStyle : undefined,
      },
    );
    committees[meal] = committee;
    // accrue coverage at each member's EXPECTED weekly appearances (dinner
    // repeats twice; cycled meals appear 7/committee-size times) — otherwise
    // a committee's ~1-serving accrual against 7x weekly targets makes the
    // gap bonus too weak to discriminate
    const expected = meal === "dinner" ? 2 : 7 / Math.max(1, committee.length);
    for (const r of committee) {
      for (const f of foodSlugsOf(r)) weekFoodPool.add(f);
      for (const [k, v] of Object.entries(foodGroupContribution(r, expected))) {
        coverageSoFar[k] = (coverageSoFar[k] ?? 0) + v;
      }
    }
  }

  // PORTIONS ARE SIZED TO THE PERSON, not hardcoded to one serving (David,
  // 2026-08-10: his mother's plan ran over her calorie ceiling all seven days
  // while she was trying to lose weight).
  //
  // The bank is shared, so its recipes are written at one size. A 540 kcal
  // farro bowl is a sensible lunch inside a 3700 kcal day and a third of a
  // 1550 kcal day. Filling every slot with exactly 1 serving therefore
  // over-fed the smallest profile before a single pass ran, and the reactive
  // passes then made it worse: the only lever they had was to bump a serving
  // 1 -> 2, which adds another 540 kcal to a day with 1550 in it. The ceiling
  // trim could not undo that without breaking the Daily Dozen floor the bump
  // had just satisfied, so the day simply stayed over.
  //
  // This is the same "one pot, different plates" rule a shared table already
  // uses, so it reuses that exact function rather than inventing a second
  // portion model that could disagree with it.
  //
  // Only PROACTIVE_SHARE of the day is spent here. The rest is deliberate
  // headroom for the reactive passes — the Daily Dozen floor pass and the
  // macro top-up both work by adding snacks, and a day already sized to 100%
  // has nowhere to put them.
  const PROACTIVE_SHARE = 0.85;
  const portionTargets = {
    ...targets,
    macros: { ...(targets?.macros ?? {}), calories: caloriesTarget * PROACTIVE_SHARE },
  };
  // SWIPE DAYS COOK LESS (7.11, David 2026-08-19: two swipe meals still read
  // 282 g protein because the cooked slots were sized for a FULL day and the
  // ceiling trim only pulls back to the ceiling). A day with away credits
  // sizes its remaining cooked slots against the calories that REMAIN,
  // renormalized over the remaining slots' weights — so the swipe day's
  // dinner is a normal dinner inside a smaller cooked day, not a full-day
  // dinner squeezed by the trim. Floors stay honest: dayTotals counts the
  // away estimates, so the calorie floor still tops up if the credits were
  // small. No away credits = portionTargets unchanged, exactly as before.
  const awayByDate = new Map(outDays.map((d) => [d.date, d]));
  const portionTargetsFor = (/** @type {string} */ date) => {
    const away = awayByDate.get(date);
    if (!away || !(away.estCalories > 0)) return portionTargets;
    const awayShare = away.slots.reduce((s, slot) => s + slotShareFor(targets ?? {}, slot), 0);
    const remainingShare = Math.max(0.25, 1 - awayShare);
    // UNCAPPED on purpose (reviewer catch 2026-08-19: a Math.min at
    // caloriesTarget made this a no-op for every realistic buffet estimate,
    // because the away slot's SHARE usually exceeds its credited calories).
    // By construction the remaining slots then total (target − credit) ×
    // PROACTIVE_SHARE: a light 505-kcal breakfast swipe sizes the rest of
    // the day slightly UP (the credit is smaller than the slot it frees),
    // a heavy two-buffet day sizes it well DOWN — both are the arithmetic
    // of cooking exactly what the credits leave uncovered.
    const remainingCalories = Math.max(0, caloriesTarget - away.estCalories) / remainingShare;
    return {
      ...targets,
      macros: {
        ...(targets?.macros ?? {}),
        calories: remainingCalories * PROACTIVE_SHARE,
      },
    };
  };
  const portionFor = (
    /** @type {string} */ date,
    /** @type {string} */ slot,
    /** @type {Record<string, any>} */ recipe,
  ) => seatServingsFor(portionTargetsFor(date), slot, recipe);

  const fill = (
    /** @type {string} */ date,
    /** @type {string} */ slot,
    /** @type {Record<string, any> | undefined} */ recipe,
  ) => {
    if (!recipe) return;
    if (entriesAt(next.entries, date, slot).length > 0) return; // never overwrite (pins included)
    next = addEntry(next, date, slot, {
      recipeId: recipe.id,
      servings: portionFor(date, slot, recipe),
    });
  };

  const dinnerRotation = hash(`${weekId}|${salt}|dinner`) % Math.max(1, committees.dinner.length);
  const dinnerSequence = twoPassSequence(committees.dinner, dinnerRotation);
  let dinnerCursor = 0;

  // Default rotation assignment first (exactly the old behavior), then a
  // PERMUTATION pass (7.11): a day banking away/swipe protein trades its
  // assigned recipe for the leanest one assigned to a normal day. Pairwise
  // swaps keep the multiset of picks identical — the ≤2-repeat promise and
  // the shopping list are untouched; only which DAY gets which member moves,
  // so the swipe day stops stacking protein it already has. No-op when no
  // away credits exist.
  const proteinDensityOf = (/** @type {Record<string, any> | undefined} */ r) => {
    const cal = r?.nutrition?.calories ?? 0;
    return cal > 0 ? ((r?.nutrition?.protein ?? 0) * 4) / cal : 0;
  };
  const awayProteinByDate = new Map(outDays.map((d) => [d.date, d.estProtein]));
  const fillDates = dates.filter((date) => !isPast(date) && !isHeld(date));
  /** @type {{ breakfast: Map<string, Record<string, any> | undefined>, lunch: Map<string, Record<string, any> | undefined>, dinner: Map<string, Record<string, any> | undefined> }} */
  const assigned = { breakfast: new Map(), lunch: new Map(), dinner: new Map() };
  fillDates.forEach((date) => {
    // WEEK-relative rotation index (dates, not fillDates): a mid-week
    // regenerate must hand the remaining days the same picks it did on
    // Monday, or the tail of the week reshuffles and the list churns
    // (reviewer catch 2026-08-19)
    const i = dates.indexOf(date);
    // only a FREE slot enters the assignment map. An occupied slot (the
    // swipe placeholder itself, a hand-pinned meal) would make its
    // assignment a discard — and the permutation below would then park the
    // lean pick on the discard and cook the dense one instead (reviewer
    // catch 2026-08-19: the swap must trade real slots only)
    if (
      mealSlotSet.has("breakfast") &&
      entriesAt(next.entries, date, "breakfast").length === 0
    ) {
      assigned.breakfast.set(
        date,
        committees.breakfast[i % Math.max(1, committees.breakfast.length)],
      );
    }
    if (mealSlotSet.has("lunch") && entriesAt(next.entries, date, "lunch").length === 0) {
      assigned.lunch.set(date, committees.lunch[i % Math.max(1, committees.lunch.length)]);
    }
    if (
      mealSlotSet.has("dinner") &&
      dinnerCursor < dinnerSequence.length &&
      entriesAt(next.entries, date, "dinner").length === 0
    ) {
      assigned.dinner.set(date, dinnerSequence[dinnerCursor]);
      dinnerCursor++;
    }
  });
  for (const meal of /** @type {("breakfast" | "lunch" | "dinner")[]} */ ([
    "breakfast",
    "lunch",
    "dinner",
  ])) {
    const m = assigned[meal];
    const awayDates = [...m.keys()]
      .filter((d) => (awayProteinByDate.get(d) ?? 0) > 0)
      // heaviest credit first gets the leanest available pick
      .sort((a, b) => (awayProteinByDate.get(b) ?? 0) - (awayProteinByDate.get(a) ?? 0));
    const normalDates = [...m.keys()].filter((d) => !((awayProteinByDate.get(d) ?? 0) > 0));
    for (const ad of awayDates) {
      let bestSwap = null;
      for (const nd of normalDates) {
        const lean = m.get(nd);
        if (!lean || proteinDensityOf(lean) >= proteinDensityOf(m.get(ad))) continue;
        if (!bestSwap || proteinDensityOf(lean) < proteinDensityOf(m.get(bestSwap))) bestSwap = nd;
      }
      if (bestSwap) {
        const was = m.get(ad);
        m.set(ad, m.get(bestSwap));
        m.set(bestSwap, was);
      }
    }
  }
  fillDates.forEach((date) => {
    if (mealSlotSet.has("breakfast")) fill(date, "breakfast", assigned.breakfast.get(date));
    if (mealSlotSet.has("smoothie")) fill(date, "smoothie", committees.smoothie[0]);
    if (mealSlotSet.has("lunch")) fill(date, "lunch", assigned.lunch.get(date));
    if (mealSlotSet.has("dinner")) fill(date, "dinner", assigned.dinner.get(date));
  });

  // Step 3.5: per-day food-group floor pass (greens/cruciferous, per the
  // 2026-07-10 Opus audit) — must run BEFORE macroTopUp so the calorie/
  // protein top-up sees each day's post-floor totals, not the other way
  // around.
  next = foodGroupFloorPass(next, pool("snack"), byId, dailyGroupFloors, {
    calorieCeiling: ceilings.calories,
  });

  // Step 4: macro top-up (calories + protein). Uses the FULL snack pool, not
  // just the ingredient-overlap committee: the committee optimizes for a
  // tight shopping list, but this is the safety net for hitting the floor,
  // so it needs every real snack candidate available (2026-07-10 gain-phase
  // bump: the higher 3700/3500 floor needs more headroom than a 2-recipe
  // committee reliably provides).
  // fix list 2.4: the top-up runs under the SAME budget parameter as the
  // committees, with its restriction reported to the manifest
  /** @type {Record<string, any>} */
  const topUpReport = {};
  const snackServingsBefore = next.entries
    .filter((e) => e.slot === "snack")
    .reduce((s, e) => s + (e.servings ?? 0), 0);
  next = macroTopUp(next, pool("snack"), byId, floors, targets?.snackAppetite === "meals" ? 1 : 3, {
    budget: targets?.budget,
    weekFoodPool,
    report: topUpReport,
    // 7.11: a day already at its protein target (usually a swipe day) gets
    // lean calorie fills instead of protein-first snacks
    proteinTargetG: proteinTarget,
  });
  if (topUpReport.macroTopUp) {
    topUpReport.macroTopUp.snackServingsAdded =
      next.entries.filter((e) => e.slot === "snack").reduce((s, e) => s + (e.servings ?? 0), 0) -
      snackServingsBefore;
  }

  // Step 4.5: calorie CEILING trim, run LAST. The two passes above only ever
  // ADD servings, so days routinely overshoot the target by 5-9%; this trims
  // back down without breaking any floor those passes just secured.
  next = calorieTrimPass(next, byId, {
    calorieCeiling: ceilings.calories,
    calorieFloor: floors.calories,
    proteinFloor: floors.protein,
    groupFloors: dailyGroupFloors,
  });

  // Step 4.7: weekly BUFFER snack (David, 2026-07-20) — ONE batch-prepped,
  // measured fridge stand-by for the whole week, the answer to "still hungry"
  // that isn't an unplanned raid. Criteria per the Greger consult
  // (2026-07-20): batchable is a PREREQUISITE, not a bonus (a snack with no
  // batch story can't sit in the fridge all week) — but an empty batchable
  // pool degrades honestly to the full snack pool rather than skipping the
  // buffer. Scoring: protein per portion AND per calorie (the buffer does
  // double duty toward the protein target), a phase-keyed calorie band
  // (gain wants ~250-400 kcal so the snack MOVES the day, not a 90-kcal
  // appetite-killer plate; other phases band lower), whole-plant Daily
  // Dozen mass (satiety with the fiber bundled in), zero-prep assembly
  // effort, ingredient overlap with the week (tight list), salted jitter
  // (RE-ROLL varies it). 7 portions: one per day available, eating fewer is
  // the point. Deterministic like everything else here.
  const BUFFER_PLANT_GROUPS = [
    "greens",
    "cruciferousVeg",
    "otherVeg",
    "beans",
    "nuts",
    "berries",
    "otherFruit",
  ];
  const BATCH_TAGS = ["make-ahead", "batch-friendly", "meal-prep"];
  const snackPool = pool("snack");
  const batchable = snackPool.filter(
    (r) =>
      (r.tags ?? []).some((/** @type {string} */ t) => BATCH_TAGS.includes(t)) ||
      r.batchPrep?.sundayComponent,
  );
  const bufferCandidates = batchable.length > 0 ? batchable : snackPool;
  const [bandLo, bandHi] = targets?.phase === "gain" ? [250, 400] : [120, 300];
  let bufferPick = null;
  let bufferScore = -Infinity;
  for (const r of bufferCandidates) {
    const n = r.nutrition ?? {};
    const cal = n.calories ?? 0;
    const plantMass = BUFFER_PLANT_GROUPS.reduce((s, g) => s + (Number(r.foodGroups?.[g]) || 0), 0);
    const bandMiss = cal < bandLo ? (bandLo - cal) / 100 : cal > bandHi ? (cal - bandHi) / 100 : 0;
    const score =
      (n.protein ?? 0) / 10 +
      ((n.protein ?? 0) / Math.max(1, cal)) * 100 * 0.4 +
      plantMass * 1.5 +
      (r.effort === "assembly" ? 1 : 0) -
      bandMiss * 1.5 +
      overlapWith(r, weekFoodPool) * 0.5 +
      (hash(`${r.id}|${salt}|buffer`) % 997) / 9970;
    if (score > bufferScore) {
      bufferScore = score;
      bufferPick = r;
    }
  }
  // portions = one per LIVE day (7 on a fresh week); a mid-week re-roll
  // rescales the batch to the days that remain. A fully-past week keeps its
  // existing buffer untouched.
  if (bufferPick && liveDates.length > 0) {
    next = { ...next, buffer: { recipeId: bufferPick.id, portions: liveDates.length } };
  }

  // Step 5: report, never fudge — short days are judged against the floors
  // but reported against the real goals. Eating-out days participate like
  // any other day: their assumed credit is in dayTotals, so a shortfall or
  // overage line about one is real, not an artifact of a 0-calorie slot.
  const { proteinShortDays, calorieShortDays } = macroShortfalls(next, byId, liveDates, floors, {
    protein: proteinTarget,
    calories: caloriesTarget,
  });
  const gaps = foodGroupGapsReport(next.entries, byId, liveDates, dailyDozenPerDay);
  const poolInsufficient = poolInsufficiency(recipes, dailyDozenPerDay);
  const calorieOverDays = liveDates
    .map((date) => ({ date, calories: dayTotals(next.entries, byId, date).calories }))
    .filter((d) => d.calories > ceilings.calories)
    .map((d) => ({ ...d, ceiling: ceilings.calories }));

  // "what this week shares" reflects what actually landed in the plan
  // (pinned + generated), not just the committees before the top-up
  /** @type {Map<string, any>} */
  const usedRecipes = new Map();
  for (const e of next.entries) {
    const r = e.recipeId ? byId.get(e.recipeId) : null;
    if (r) usedRecipes.set(r.id, r);
  }
  const overlap = overlapReport([...usedRecipes.values()]);

  // merge the untouched past days back in — after the report, so every
  // report line (shared, shortfalls, gaps) speaks only about live days
  if (pastEntries.length > 0) next = { ...next, entries: [...pastEntries, ...next.entries] };

  // ENGINE half of the generation manifest (fix list 2.5, council
  // 2026-08-18): what each subsystem inside this function actually did, with
  // its inputs. The composed full manifest (lib/manifest.js) adds the
  // out-of-engine lines (weight trend, adherence, floor dates, plating).
  // A subsystem that reports nothing here fails the manifest registry test:
  // that is the countermeasure to the fifth dark engine.
  const engineManifest = {
    budget: {
      mode: targets?.budget ?? "normal",
      cheapTagged: recipes.filter((r) => (r.tags ?? []).includes("cheap")).length,
      eligibleRecipes: recipes.length,
    },
    useSoon: {
      matchedFoods: useSoonFoods.length,
      datedPantryRows: datedPantry.length,
      onHandFoods: onHandFoods.length,
    },
    philosophy: {
      groupsTargeted: Object.keys(dailyDozenPerDay ?? {}).length,
      vector: dailyDozenPerDay ?? {},
      weeklyGapsOpen: gaps.weekly.length,
    },
    macroTopUp: topUpReport.macroTopUp ?? { budget: "unknown", ranButDidNotReport: true },
    // 7.11 (P5): the away/swipe credit and the remaining-need density the
    // committees actually aimed at — the arbitrage can never go dark again
    away: {
      slots: awayCredit.slots,
      swipeSlots: pinnedEntries.filter((e) => e.out && /** @type {any} */ (e).currency).length,
      creditCalories: awayCredit.calories,
      creditProtein: awayCredit.protein,
      cookedNeedRatio: Math.round(remainingNeedRatio * 1000) / 1000,
      fullNeedRatio:
        caloriesTarget > 0 ? Math.round(((proteinTarget * 4) / caloriesTarget) * 1000) / 1000 : 0,
    },
    floors: (() => {
      // DELIVERED averages, not just shortfalls: over-delivery reads as
      // success on every other screen (the 232-252 g finding, council
      // 2026-08-18) and this is where it gets said out loud
      let cal = 0;
      let prot = 0;
      for (const d of liveDates) {
        const t = dayTotals(next.entries, byId, d);
        cal += t.calories;
        prot += t.protein;
      }
      const days = Math.max(1, liveDates.length);
      return {
        calories: floors.calories,
        protein: floors.protein,
        proteinShortDays: proteinShortDays.length,
        calorieShortDays: calorieShortDays.length,
        liveDays: liveDates.length,
        avgCalories: Math.round(cal / days),
        avgProteinG: Math.round(prot / days),
        proteinTargetG: proteinTarget,
      };
    })(),
  };

  return {
    plan: next,
    report: {
      manifest: engineManifest,
      shared: overlap.shared,
      distinctItems: overlap.distinctItems,
      proteinShortDays,
      calorieShortDays,
      foodGroupGaps: gaps.perDay,
      foodGroupGapsWeekly: gaps.weekly,
      poolInsufficient,
      calorieOverDays,
      timeBudgetRelaxed,
      outDays,
      // said out loud, never silent: these days were not planned, an
      // occasion owns them and generation deliberately did not touch them
      occasionDays: [...heldDates].sort().map((date) => ({
        date,
        occasion: plan.entries.find((e) => e.date === date && e.occasion)?.occasion ?? "",
        name: plan.entries.find((e) => e.date === date && e.occasionName)?.occasionName ?? "",
      })),
    },
  };
}
