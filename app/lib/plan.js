// Weekly plan operations (plans/<week>.json). Entries carry a unique id —
// the key mergeFieldWise prefers — so multiple entries may STACK in the same
// date+slot and two devices editing the same week merge cleanly.
import { isoWeekId, localIsoDate, parseLocalIso } from "./dates.js";

/**
 * @typedef {{ id: string, date: string, slot: string, recipeId?: string, freeText?: string, servings: number, pinned?: boolean }} PlanEntry
 * @typedef {{ week: string, entries: PlanEntry[], locked?: boolean }} Plan
 */
// pinned is optional; absent = unpinned (today's default, unchanged). true =
// GENERATE WEEK must never clear or overwrite this entry (app/lib/weekbuilder.js).
// locked is optional; absent = unlocked (today's default, unchanged). true =
// you've already shopped for this week — GENERATE WEEK/RE-ROLL WEEK refuse to
// run and individual edits (add/remove/move) ask for confirmation first.

/** The valid slot keys, in display order (docs/SCHEMAS.md plan section). */
export const SLOT_KEYS = ["breakfast", "lunch", "dinner", "smoothie", "snack"];

/** Console display names per slot — single source for every view.
 * @type {Record<string, { label: string, full: string }>} */
export const SLOT_META = {
  breakfast: { label: "BRK", full: "Breakfast" },
  lunch: { label: "LUN", full: "Lunch" },
  dinner: { label: "DIN", full: "Dinner" },
  smoothie: { label: "SMO", full: "Smoothie" },
  snack: { label: "SNK", full: "Snack" },
};

/**
 * Recipes keyed by id — the lookup shape dayTotals and the views consume.
 * @param {Record<string, any>[]} recipes
 * @returns {Map<string, any>}
 */
export function recipesById(recipes) {
  return new Map(recipes.map((r) => [r.id, r]));
}

/**
 * Keyword classes over NON-optional ingredient food names, used by `dietOf`
 * to classify an untagged legacy recipe's dietary pattern (survey-v2 Q9). A
 * recipe carrying a {"vegan","vegetarian","pescatarian"} tag short-circuits
 * the classifier; this is only the fallback for the untagged legacy bank.
 * "butter" intentionally lives in DAIRY per the design — the plant recipes it
 * would false-positive (peanut/almond butter) all carry the vegan tag, so the
 * short-circuit protects them before the classifier ever runs.
 */
const DIET_KEYWORDS = {
  meat: ["chicken", "beef", "turkey", "pork", "lamb", "kofta", "sausage", "bacon", "ham", "prosciutto", "veal", "duck", "bulgogi", "meatball"],
  fish: ["salmon", "tuna", "cod", "shrimp", "anchovy", "dashi", "sardine", "mackerel", "crab", "prawn", "fish sauce", "tilapia", "halibut", "trout"],
  dairy: ["milk", "yogurt", "cheese", "whey", "butter", "feta", "halloumi", "cottage", "parmesan", "cream", "kefir", "ghee"],
  egg: ["egg"],
};

/** Which recipe classifications each profile diet admits (strictest last). */
const DIET_ADMITS = {
  omnivore: new Set(["omnivore", "pescatarian", "vegetarian", "vegan"]),
  pescatarian: new Set(["pescatarian", "vegetarian", "vegan"]),
  vegetarian: new Set(["vegetarian", "vegan"]),
  vegan: new Set(["vegan"]),
};

/**
 * Classify a recipe's dietary pattern (survey-v2 Q9 FILTER). A diet tag wins;
 * otherwise keyword classes over non-optional ingredient names decide, in
 * decreasing strictness: any MEAT -> omnivore, else any FISH -> pescatarian,
 * else any DAIRY/EGG -> vegetarian, else vegan. optional:true ingredients are
 * skipped so "add ground turkey if you want" never disqualifies a plant chili.
 * @param {Record<string, any>} recipe
 * @returns {"omnivore" | "pescatarian" | "vegetarian" | "vegan"}
 */
export function dietOf(recipe) {
  const tag = (recipe.tags ?? []).find(
    (/** @type {string} */ t) => t === "vegan" || t === "vegetarian" || t === "pescatarian",
  );
  if (tag) return tag;
  const foods = (recipe.ingredients ?? [])
    .filter((/** @type {any} */ ing) => !ing.optional)
    .map((/** @type {any} */ ing) => String(ing.food ?? "").toLowerCase());
  const has = (/** @type {string[]} */ list) =>
    foods.some((/** @type {string} */ f) => list.some((k) => f.includes(k)));
  if (has(DIET_KEYWORDS.meat)) return "omnivore";
  if (has(DIET_KEYWORDS.fish)) return "pescatarian";
  if (has(DIET_KEYWORDS.dairy) || has(DIET_KEYWORDS.egg)) return "vegetarian";
  return "vegan";
}

/**
 * A profile's working recipe pool from the shared bank plus its own recipes
 * (recipe-bank pilot). Bank recipes tagged with `phases` only serve profiles
 * in one of those phases; an untagged bank recipe serves everyone. A
 * profile's OWN recipes always make the pool — same id as a bank recipe
 * means the profile's adjusted variant wins (e.g. Mom's 480-kcal kofta over
 * the bank's 842-kcal one) — and are never phase-filtered: if you made it
 * for yourself, it's yours.
 * Bank recipes are also screened against the profile's `diet` (survey-v2 Q9,
 * a FILTER: serving beef to a vegetarian is a trust-ending bug) and its
 * `avoidIngredients` (targets.json): case-insensitive substring match on
 * ingredient food names, so "onion" excludes "red onion" and "green onion"
 * too. The avoid screen SKIPS optional:true ingredients — an optional yogurt
 * topping must not drop a recipe from a dairy-free pool. Own recipes are
 * exempt from both — they were authored for this profile and already respect
 * its rules (Mom's 58 were hand-swept for onion; David's bank recipes were
 * not, which is exactly why this screen exists).
 * @param {Record<string, any>[]} bank recipes/ at the data-repo root
 * @param {Record<string, any>[]} own the profile's scoped recipes/ (empty for david — his own ARE the bank)
 * @param {string | undefined} phase the profile's targets.phase
 * @param {string[]} [avoid] the profile's targets.avoidIngredients
 * @param {string} [diet] the profile's targets.diet (absent = omnivore, no diet filter)
 * @returns {Record<string, any>[]}
 */
export function mergeRecipePool(bank, own, phase, avoid, diet) {
  const terms = (avoid ?? []).map((t) => t.toLowerCase()).filter(Boolean);
  const containsAvoided = (/** @type {Record<string, any>} */ r) =>
    (r.ingredients ?? []).some((/** @type {any} */ ing) => {
      if (ing.optional) return false; // optional ingredients never trigger the avoid screen
      const food = String(ing.food ?? "").toLowerCase();
      return terms.some((t) => food.includes(t));
    });
  const admits = diet && diet !== "omnivore" ? DIET_ADMITS[/** @type {keyof typeof DIET_ADMITS} */ (diet)] : null;
  /** @type {Map<string, Record<string, any>>} */
  const byId = new Map();
  for (const r of bank) {
    if (Array.isArray(r.phases) && phase && !r.phases.includes(phase)) continue;
    if (admits && !admits.has(dietOf(r))) continue;
    if (terms.length > 0 && containsAvoided(r)) continue;
    byId.set(r.id, r);
  }
  for (const r of own) byId.set(r.id, r);
  return [...byId.values()];
}

/**
 * Monday..Sunday ISO dates of an ISO week id like "2026-W28".
 * @param {string} weekId
 * @returns {string[]}
 */
export function datesOfWeek(weekId) {
  const m = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return [];
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  // ISO 8601: week 1 contains Jan 4; weeks start Monday
  const jan4 = new Date(isoYear, 0, 4);
  const week1Monday = new Date(isoYear, 0, 4 - ((jan4.getDay() + 6) % 7));
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(week1Monday);
    d.setDate(week1Monday.getDate() + (week - 1) * 7 + i);
    out.push(localIsoDate(d));
  }
  return out;
}

/**
 * ISO week id shifted by n weeks — derived from datesOfWeek/isoWeekId so the
 * week-1 math lives in exactly one place.
 * @param {string} weekId
 * @param {number} delta
 * @returns {string}
 */
export function shiftWeek(weekId, delta) {
  const monday = datesOfWeek(weekId)[0];
  const d = parseLocalIso(monday ?? "");
  d.setDate(d.getDate() + delta * 7);
  return isoWeekId(d);
}

/** @returns {string} unique-per-device entry id */
function genId() {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Deterministic id for a legacy (pre-id) entry: two devices independently
 * self-healing the same file MUST agree on ids, or id-keyed merges would
 * duplicate entries and resurrect deletions. FNV-1a over the entry's stable
 * content plus its index among identical twins.
 * @param {Record<string, any>} e
 * @param {number} twinIndex
 * @returns {string}
 */
function legacyId(e, twinIndex) {
  const s = `${e.date}|${e.slot}|${e.recipeId ?? ""}|${e.freeText ?? ""}|${e.servings}|${twinIndex}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `l${h.toString(16).padStart(8, "0")}`;
}

/**
 * Append a planned item; entries stack, nothing is replaced. Pure.
 * @param {Plan} plan
 * @param {string} date
 * @param {string} slot
 * @param {{ recipeId?: string, freeText?: string, servings: number }} content
 * @returns {Plan}
 */
export function addEntry(plan, date, slot, content) {
  return { ...plan, entries: [...plan.entries, { id: genId(), date, slot, ...content }] };
}

/**
 * @param {Plan} plan
 * @param {string} id
 * @returns {Plan}
 */
export function removeEntryById(plan, id) {
  return { ...plan, entries: plan.entries.filter((e) => e.id !== id) };
}

/**
 * @param {Plan} plan
 * @param {string} id
 * @param {string} date
 * @param {string} slot
 * @returns {Plan}
 */
export function moveEntry(plan, id, date, slot) {
  return {
    ...plan,
    entries: plan.entries.map((e) => (e.id === id ? { ...e, date, slot } : e)),
  };
}

/**
 * Flip one entry's pinned flag by id. Pure.
 * @param {Plan} plan
 * @param {string} id
 * @returns {Plan}
 */
export function togglePinById(plan, id) {
  return {
    ...plan,
    entries: plan.entries.map((e) => (e.id === id ? { ...e, pinned: !e.pinned } : e)),
  };
}

/**
 * Set or clear the whole-week lock. Pure.
 * @param {Plan} plan
 * @param {boolean} locked
 * @returns {Plan}
 */
export function setPlanLocked(plan, locked) {
  return { ...plan, locked };
}

/**
 * Shape a freshly-read (or absent) plan file: guarantees week + entries and
 * self-heals pre-id legacy entries by assigning ids (persisted on next write).
 * @param {Record<string, any> | null} raw
 * @param {string} weekId
 * @returns {Plan}
 */
export function normalizePlan(raw, weekId) {
  if (!raw || !Array.isArray(raw.entries)) return { week: weekId, entries: [] };
  /** @type {Map<string, number>} */
  const twinCounts = new Map();
  return {
    week: typeof raw.week === "string" ? raw.week : weekId,
    ...(raw.locked !== undefined ? { locked: Boolean(raw.locked) } : {}),
    entries: raw.entries.map((/** @type {any} */ e) => {
      if (typeof e.id === "string") return e;
      const contentKey = `${e.date}|${e.slot}|${e.recipeId ?? ""}|${e.freeText ?? ""}|${e.servings}`;
      const twinIndex = twinCounts.get(contentKey) ?? 0;
      twinCounts.set(contentKey, twinIndex + 1);
      return { ...e, id: legacyId(e, twinIndex) };
    }),
  };
}

/**
 * @param {PlanEntry[]} entries
 * @param {string} date
 * @param {string} slot
 * @returns {PlanEntry[]}
 */
export function entriesAt(entries, date, slot) {
  return entries.filter((e) => e.date === date && e.slot === slot);
}

/**
 * Planned calories/protein for one day. freeText and unknown recipes count 0.
 * @param {PlanEntry[]} entries
 * @param {Map<string, any>} recipesById
 * @param {string} date
 * @returns {{ calories: number, protein: number }}
 */
export function dayTotals(entries, recipesById, date) {
  let calories = 0;
  let protein = 0;
  for (const e of entries) {
    if (e.date !== date || !e.recipeId) continue;
    const n = recipesById.get(e.recipeId)?.nutrition;
    if (!n) continue;
    calories += (n.calories ?? 0) * e.servings;
    protein += (n.protein ?? 0) * e.servings;
  }
  return { calories, protein };
}
