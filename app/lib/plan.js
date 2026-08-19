// Weekly plan operations (plans/<week>.json). Entries carry a unique id —
// the key mergeFieldWise prefers — so multiple entries may STACK in the same
// date+slot and two devices editing the same week merge cleanly.
import { isoWeekId, localIsoDate, parseLocalIso } from "./dates.js";

/**
 * @typedef {{ id: string, date: string, slot: string, recipeId?: string, freeText?: string, servings: number, pinned?: boolean, out?: boolean, currency?: string, table?: string, viewRecipeId?: string, cookTotal?: number, estCalories?: number, estProtein?: number, cookedAt?: string, cookSeconds?: number, cookComment?: string, occasion?: string, occasionName?: string, occasionNote?: string, potFromBank?: boolean }} PlanEntry
 * @typedef {{ recipeId: string, portions: number }} PlanBuffer
 * @typedef {{ week: string, entries: PlanEntry[], locked?: boolean, shoppedAt?: string, buffer?: PlanBuffer, unlocked?: string[], manifest?: Record<string, any>, fallback?: { savedAt: string, entries: PlanEntry[] }, spend?: { store: string, date: string, total: number }[] }} Plan
 */
// cookedAt is optional; absent = not confirmed cooked. Set (local YYYY-MM-DD)
// by the DONE button at the end of Cook mode — the honest-state rule: a past
// date never implies eaten, only a confirmation does.
// shoppedAt is optional; absent = groceries NOT confirmed for this week. Set
// when a receipt is scanned and applied (the receipt IS the confirmation);
// cook reminders (Worker cron) fire only for shopped weeks.
// buffer is optional; absent = no weekly buffer (pre-buffer data, unchanged).
// It names ONE batch-prepped snack recipe for the whole week — the measured
// fridge stand-by for any moment of extra hunger — plus how many portions the
// Sunday batch makes. Chosen by GENERATE WEEK, shopped by deriveShoppingList,
// tallied per day on the Today view (fitness/daily.json `buffer` count).
// pinned is optional; absent = unpinned (today's default, unchanged). true =
// GENERATE WEEK must never clear or overwrite this entry (app/lib/weekbuilder.js).
// locked is optional; absent = unlocked (today's default, unchanged). true =
// you've already shopped for this week — GENERATE WEEK/RE-ROLL WEEK refuse to
// run and individual edits (add/remove/move) ask for confirmation first.
// occasion / occasionName / occasionNote are optional; absent = a normal
// entry. Present = this entry was placed by a dated OCCASION (app/lib/
// occasions.js) and its DATE is held: generateWeek leaves the whole day
// alone, exactly like a day already eaten, so no macro top-up stacks snacks
// onto a clear-liquid prep day. `occasion` is the occasion id (also the
// removal key), `occasionName` is what the day's banner reads, `occasionNote`
// is the per-item instruction ("cold, through a straw").
// out is optional; absent = a normal entry. true = this slot is an
// EATING-OUT placeholder (free lunch, restaurant dinner): always paired with
// pinned:true so GENERATE WEEK leaves the slot alone, carries freeText so
// every view renders it, and, being freeText, contributes nothing to the
// shopping list. estCalories/estProtein carry the restaurant meal's ASSUMED
// macros (slotMacroEstimate: pool average x an undershoot factor), counted by
// dayTotals so the rest of the day is planned around a realistic day total
// instead of a fictional 0-calorie dinner.

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
  meat: [
    "chicken",
    "beef",
    "turkey",
    "pork",
    "lamb",
    "kofta",
    "sausage",
    "bacon",
    "ham",
    "prosciutto",
    "veal",
    "duck",
    "bulgogi",
    "meatball",
  ],
  fish: [
    "salmon",
    "tuna",
    "cod",
    "shrimp",
    "anchovy",
    "dashi",
    "sardine",
    "mackerel",
    "crab",
    "prawn",
    "fish sauce",
    "tilapia",
    "halibut",
    "trout",
  ],
  dairy: [
    "milk",
    "yogurt",
    "cheese",
    "whey",
    "butter",
    "feta",
    "halloumi",
    "cottage",
    "parmesan",
    "cream",
    "kefir",
    "ghee",
  ],
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
 * @param {string[]} [avoidRecipes] the profile's targets.avoidRecipes: recipe
 *   ids banned outright ("never show me the office lunch box again", David
 *   2026-08-01). Unlike every other screen this one also applies to OWN
 *   recipes — a ban is a ban — so the recipe vanishes from this profile's
 *   cookbook, generator, and swap suggestions everywhere the merged pool is
 *   the source of truth.
 * @returns {Record<string, any>[]}
 */
export function mergeRecipePool(bank, own, phase, avoid, diet, avoidRecipes) {
  const banned = new Set(avoidRecipes ?? []);
  /** @type {Map<string, Record<string, any>>} */
  const byId = new Map();
  for (const r of bank) {
    if (banned.has(r.id)) continue;
    if (Array.isArray(r.phases) && phase && !r.phases.includes(phase)) continue;
    if (recipeConflicts(r, diet, avoid).length > 0) continue;
    byId.set(r.id, r);
  }
  for (const r of own) {
    if (banned.has(r.id)) continue;
    // OWN recipes are screened too (David, 2026-08-10). They used to be exempt
    // on the reasoning that a human authored them for this profile and had
    // already respected its rules. That held only while a human wrote every
    // one: the exemption followed the DIRECTORY, not any actual verification,
    // so anything that ever generates a file into profiles/<id>/recipes/ would
    // inherit a bypass around the one screen the app calls trust-ending.
    // Verified before shipping: this removes ZERO of the 58 hand-written
    // variants on disk, so it costs nothing today and closes the hole for good.
    if (recipeConflicts(r, diet, avoid).length > 0) continue;
    byId.set(r.id, r);
  }
  return [...byId.values()];
}

/**
 * THE auto-plan trust fence, shared by the week generator and the brigade
 * pool so the two gates can never drift apart again. An AI-written recipe —
 * invented (`ai-special`) or annotated-from-source (`hbp-annotated`) — is
 * choosable deliberately from the cookbook but never auto-planned until a
 * human sets `promoted: true` (council 2026-07-23: "AI at the table, never
 * in the plan"). Keyed on TAGS, the field the writers actually set: the old
 * brigade fence keyed on `recipe.source`, which no recipe on disk carries,
 * so it never fired.
 * @param {Record<string, any>} recipe
 * @returns {boolean} true when auto-planners must skip this recipe
 */
export function untrustedForAutoPlan(recipe) {
  const tags = recipe.tags ?? [];
  return (
    (tags.includes("ai-special") || tags.includes("hbp-annotated")) && recipe.promoted !== true
  );
}

/**
 * THE shared diet/avoid screen (Tribunal amendment 1): the same predicate
 * mergeRecipePool filters with, exported so table creation and derivation
 * can never bypass it. Returns human-readable conflict reasons, empty =
 * clean. Optional ingredients never trigger the avoid screen.
 * @param {Record<string, any>} recipe
 * @param {string} [diet] the profile's targets.diet (absent/omnivore = no diet screen)
 * @param {string[]} [avoid] the profile's targets.avoidIngredients
 * @param {string[]} [avoidRecipes] the profile's targets.avoidRecipes — a
 *   banned recipe id conflicts here too, so a hand-set table can't pin food
 *   a profile has sworn off (the seat screen and derivation both route
 *   through this predicate; a screen with a bypass is not a screen)
 * @returns {string[]} conflict reasons, e.g. ["contains shallot", "not vegetarian"]
 */
export function recipeConflicts(recipe, diet, avoid, avoidRecipes) {
  /** @type {string[]} */
  const reasons = [];
  if ((avoidRecipes ?? []).includes(recipe.id)) reasons.push("on their never-again list");
  const admits =
    diet && diet !== "omnivore"
      ? DIET_ADMITS[/** @type {keyof typeof DIET_ADMITS} */ (diet)]
      : null;
  if (admits && !admits.has(dietOf(recipe))) reasons.push(`not ${diet}`);
  const terms = (avoid ?? []).map((t) => t.toLowerCase()).filter(Boolean);
  for (const ing of recipe.ingredients ?? []) {
    if (ing.optional) continue; // optional ingredients never trigger the avoid screen
    const food = String(ing.food ?? "").toLowerCase();
    const hit = terms.find((t) => food.includes(t));
    if (hit && !reasons.includes(`contains ${hit}`)) reasons.push(`contains ${hit}`);
  }
  return reasons;
}

/**
 * Hand-written allergen-family synonyms (per-person-plates-design §8.2).
 * The substring screen alone misses family members ("onion" never matches
 * "leek"), and the AI tailor that used to be a weak semantic backstop is
 * being retired. SOFT TIER ONLY: these expand the serve-step notes below,
 * never the hard recipeConflicts screen — widening that predicate would
 * silently shrink every recipe pool in the app (it has eight call sites,
 * including the week generator and the brigade intersection screen).
 * Promoting a family into the hard screen is a separate, data-reviewed
 * change with a pool-size test.
 */
const AVOID_FAMILIES = /** @type {Record<string, string[]>} */ ({
  onion: ["onion", "shallot", "scallion", "leek", "chive", "ramp"],
  shallot: ["onion", "shallot", "scallion", "leek", "chive", "ramp"],
});

/** @param {string[] | undefined} avoid @returns {string[]} lowercase terms + family synonyms */
export function expandAvoidTerms(avoid) {
  const out = new Set();
  for (const t of avoid ?? []) {
    const term = String(t).toLowerCase().trim();
    if (!term) continue;
    out.add(term);
    for (const syn of AVOID_FAMILIES[term] ?? []) out.add(syn);
  }
  return [...out];
}

/**
 * The SOFT seating tier (per-person-plates-design §8.2): matches the hard
 * screen deliberately skips. Two sources: `optional: true` ingredient rows
 * (which never unseat, but must never be silently plated to the person
 * avoiding them — Red Team walked an optional red-onion garnish straight
 * onto an un-skippable serve line), and family-synonym matches on any row.
 * Returns the matched food names, empty = nothing to note. A match here
 * NEVER unseats; it turns into a named note on the serve step.
 * @param {Record<string, any>} recipe
 * @param {string[]} [avoid]
 * @returns {string[]} matched ingredient food names, deduped
 */
export function softAvoidMatches(recipe, avoid) {
  const hard = (avoid ?? []).map((t) => String(t).toLowerCase()).filter(Boolean);
  const soft = expandAvoidTerms(avoid);
  /** @type {string[]} */
  const out = [];
  for (const ing of recipe.ingredients ?? []) {
    const food = String(ing.food ?? "").toLowerCase();
    const hitsSoft = soft.some((t) => food.includes(t));
    if (!hitsSoft) continue;
    const hitsHard = hard.some((t) => food.includes(t));
    // non-optional hard hits already unseat via recipeConflicts; everything
    // else (optional rows, synonym-only matches) is the soft tier
    if (!ing.optional && hitsHard) continue;
    if (!out.includes(String(ing.food))) out.push(String(ing.food));
  }
  return out;
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
 * The prep Sunday for a week: the day BEFORE its Monday (Sunday-batch
 * routine). Belongs to the previous ISO week by definition.
 * @param {string} weekId
 * @returns {string}
 */
export function prepSundayOf(weekId) {
  const monday = datesOfWeek(weekId)[0];
  if (!monday) return "";
  const d = parseLocalIso(monday);
  d.setDate(d.getDate() - 1);
  return localIsoDate(d);
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
 * @param {{ recipeId?: string, freeText?: string, servings: number, pinned?: boolean, out?: boolean }} content
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

/** The eating-out placeholder a slot's OUT toggle creates. */
export const OUT_TEXT = "eating out";

/**
 * Deliberate UNDERSHOOT on the eating-out macro estimate (David's call,
 * 2026-07-20): you don't know what the restaurant serves until you've eaten
 * it, so credit slightly less than average and let the generator's snack
 * top-up close the small remaining gap — a snack you can skip if dinner ran
 * big beats a day planned around calories that never arrived.
 */
const OUT_ESTIMATE_RATIO = 0.85;

/**
 * Fallback per-slot estimates for an empty recipe pool (fresh profile,
 * recipes not loaded): rough shares of a ~3400 kcal day, same shape the
 * pool average would produce.
 */
const OUT_FALLBACK = {
  breakfast: { calories: 600, protein: 30 },
  lunch: { calories: 800, protein: 40 },
  dinner: { calories: 900, protein: 45 },
  smoothie: { calories: 650, protein: 40 },
  snack: { calories: 250, protein: 15 },
};

/**
 * The macro credit an eating-out slot is assumed to deliver: the profile
 * pool's average calories/protein for that meal type, times the undershoot
 * ratio. Falls back to a fixed per-slot table when the pool has no recipes
 * of that type.
 * @param {Record<string, any>[]} recipes the profile's recipe pool
 * @param {string} slot
 * @returns {{ estCalories: number, estProtein: number }}
 */
export function slotMacroEstimate(recipes, slot) {
  const pool = recipes.filter((r) => r.mealType === slot && (r.nutrition?.calories ?? 0) > 0);
  const base =
    pool.length > 0
      ? {
          calories: pool.reduce((s, r) => s + (r.nutrition?.calories ?? 0), 0) / pool.length,
          protein: pool.reduce((s, r) => s + (r.nutrition?.protein ?? 0), 0) / pool.length,
        }
      : (OUT_FALLBACK[/** @type {keyof typeof OUT_FALLBACK} */ (slot)] ?? OUT_FALLBACK.dinner);
  return {
    estCalories: Math.round((base.calories * OUT_ESTIMATE_RATIO) / 5) * 5,
    estProtein: Math.round(base.protein * OUT_ESTIMATE_RATIO),
  };
}

/**
 * The eating-out placeholder entry at date+slot, if any.
 * @param {PlanEntry[]} entries
 * @param {string} date
 * @param {string} slot
 * @returns {PlanEntry | undefined}
 */
export function outEntryAt(entries, date, slot) {
  return entries.find((e) => e.date === date && e.slot === slot && e.out);
}

/**
 * Flip a slot's eating-out state. OFF→ON (marking out): every entry in the
 * slot is replaced by one pinned placeholder — the whole point is "get rid of
 * the planned meal, don't shop for it, don't re-roll it". ON→OFF: the
 * placeholder is removed and the slot is empty again (drag or GENERATE fills
 * it). Pure.
 * @param {Plan} plan
 * @param {string} date
 * @param {string} slot
 * @param {{ estCalories: number, estProtein: number }} [est] assumed macros
 *   for the restaurant meal (slotMacroEstimate); omit for a 0-credit
 *   placeholder (backfilled at the next GENERATE from the live pool)
 * @returns {Plan}
 */
export function toggleSlotOut(plan, date, slot, est) {
  const existing = outEntryAt(plan.entries, date, slot);
  if (existing) {
    // remove EVERY placeholder in the slot, not just the first: two devices
    // marking the same slot out then merging leaves twins, and an off-toggle
    // that removed only one would leave the slot stuck reading "out"
    return {
      ...plan,
      entries: plan.entries.filter((e) => !(e.date === date && e.slot === slot && e.out)),
    };
  }
  const kept = plan.entries.filter((e) => !(e.date === date && e.slot === slot));
  return addEntry({ ...plan, entries: kept }, date, slot, {
    freeText: OUT_TEXT,
    servings: 1,
    pinned: true,
    out: true,
    ...(est ?? {}),
  });
}

/** The placeholder a currency-covered slot carries (7.11). */
export const SWIPE_TEXT = "dining swipe";

/**
 * The macro credit a BUFFET slot is assumed to deliver (7.11, P5+P10,
 * David's arbitrage 2026-08-19): all-you-can-eat means the slot ABSORBS the
 * expensive macros — pile the protein there because its marginal cost is
 * zero, and the grocery list buys less of the costliest thing it prices.
 * So where a restaurant slot deliberately undershoots, a buffet slot
 * deliberately overshoots protein (x1.5) and modestly overshoots calories
 * (x1.15) against the pool average for the meal type.
 * @param {Record<string, any>[]} recipes the profile's recipe pool
 * @param {string} slot
 * @returns {{ estCalories: number, estProtein: number }}
 */
export function buffetMacroEstimate(recipes, slot) {
  const base = slotMacroEstimate(recipes, slot);
  // slotMacroEstimate already applied the 0.85 undershoot; rebase to the
  // pool average, then load
  const calories = (base.estCalories / 0.85) * 1.15;
  const protein = (base.estProtein / 0.85) * 1.5;
  return {
    estCalories: Math.round(calories / 5) * 5,
    estProtein: Math.round(protein),
  };
}

/**
 * One tap walks a slot through its away states (7.11):
 *   planned/empty → EATING OUT → DINING SWIPE (only when the profile has a
 *   buffet currency) → back to an empty slot.
 * The swipe placeholder is an out entry that also carries `currency`, so
 * everything that already understands OUT (generator pinning, dayTotals'
 * est counting, the shopping derive) works unchanged; only the estimates
 * differ (buffet overshoots protein where a restaurant undershoots).
 * @param {Plan} plan
 * @param {string} date
 * @param {string} slot
 * @param {{ estCalories: number, estProtein: number }} outEst
 * @param {{ estCalories: number, estProtein: number }} swipeEst
 * @param {string | null} currencyId null = profile has no buffet currency,
 *   the cycle is the classic two-state OUT toggle
 * @returns {Plan}
 */
export function cycleSlotAway(plan, date, slot, outEst, swipeEst, currencyId) {
  const existing = outEntryAt(plan.entries, date, slot);
  if (!existing) return toggleSlotOut(plan, date, slot, outEst);
  const isSwipe = Boolean(/** @type {any} */ (existing).currency);
  if (isSwipe || !currencyId) {
    // swipe (or plain OUT with no currency configured) → clear the slot
    return {
      ...plan,
      entries: plan.entries.filter((e) => !(e.date === date && e.slot === slot && e.out)),
    };
  }
  // OUT → SWIPE: same placeholder, buffet-loaded estimates
  return {
    ...plan,
    entries: plan.entries.map((e) =>
      e.date === date && e.slot === slot && e.out
        ? { ...e, freeText: SWIPE_TEXT, currency: currencyId, ...swipeEst }
        : e,
    ),
  };
}

/**
 * Swipes (or any per-week currency) used by this week's plan: entries whose
 * `currency` matches. The planner shows used-of-perWeek so an expiring
 * balance is never silently wasted (use-or-lose is the whole point).
 * @param {Plan} plan
 * @param {string} currencyId
 * @returns {number}
 */
export function currencyUsed(plan, currencyId) {
  return plan.entries.filter((e) => /** @type {any} */ (e).currency === currencyId).length;
}

/**
 * Set or clear the whole-week lock. Pure.
 * LEGACY (7.2, canon P4: the locked week is ABOLISHED — shopping locks the
 * INGREDIENTS, never the plan). Kept so old devices' plans still normalize
 * and old writes stay mergeable; no new UI calls it.
 * @param {Plan} plan
 * @param {boolean} locked
 * @returns {Plan}
 */
export function setPlanLocked(plan, locked) {
  return { ...plan, locked };
}

/**
 * GOING TO THE STORE (7.2, canon P4): stores the generated week as the
 * FALLBACK plan — the shape you shopped for, always there to return to —
 * and from that moment the plan may change freely under the one governing
 * rule (perishableCoverage). Re-tapping refreshes the snapshot.
 * @param {Plan} plan
 * @param {string} todayIso
 * @returns {Plan}
 */
export function saveFallback(plan, todayIso) {
  return {
    ...plan,
    fallback: { savedAt: todayIso, entries: plan.entries.map((e) => ({ ...e })) },
  };
}

/**
 * Back to the shopped plan: the fallback's entries replace the current ones,
 * except entries already COOKED stay as cooked reality (a restore must never
 * un-cook food or resurrect an eaten meal as pending). No fallback = no-op.
 * @param {Plan} plan
 * @returns {Plan}
 */
export function restoreFallback(plan) {
  const fb = /** @type {any} */ (plan).fallback;
  if (!fb || !Array.isArray(fb.entries)) return plan;
  const cooked = plan.entries.filter((e) => e.cookedAt);
  // exclusion is by ID, never by slot: entries STACK in a slot (the snack
  // top-up plans up to three distinct snacks at one date+slot), and a
  // slot-keyed exclusion silently dropped the cooked entry's uncooked
  // siblings on every restore (diff review 2026-08-19). An id survives
  // SWITCH (setEntryRecipe keeps it), so the cooked meal's fallback twin is
  // exactly the one entry the cooked reality replaces.
  const cookedIds = new Set(cooked.map((e) => e.id));
  const restored = fb.entries.filter((/** @type {PlanEntry} */ e) => !cookedIds.has(e.id));
  return { ...plan, entries: [...cooked, ...restored] };
}

/**
 * The next recipe to offer for a planned meal (David, 2026-07-27: SWITCH
 * replaces the old ✕, "instead of being able to only get rid of I want an
 * automatic replacement").
 *
 * Cycles rather than randomises: tapping SWITCH repeatedly walks the eligible
 * list in order and wraps, so pressing it four times and pressing it once are
 * both predictable, and you can always get back to where you started. A
 * random pick would make the button feel like a slot machine and could serve
 * the same alternative twice in a row.
 *
 * Candidates are screened the same way the tray was: same meal type as the
 * slot, and never a recipe already planned elsewhere in that DAY, because
 * switching lunch onto the same thing you are having for dinner is not a
 * switch. The pool handed in is already diet/phase/avoid-screened by
 * mergeRecipePool, so nothing unsafe can enter here.
 * @param {Plan} plan
 * @param {string} entryId
 * @param {Record<string, any>[]} recipes screened pool
 * @returns {string | null} the next recipe id, or null when there is nothing to switch to
 */
export function switchCandidate(plan, entryId, recipes) {
  const entry = (plan?.entries ?? []).find((e) => e.id === entryId);
  if (!entry || !entry.recipeId) return null;
  const sameDay = new Set(
    (plan.entries ?? [])
      .filter((e) => e.date === entry.date && e.id !== entryId && e.recipeId)
      .map((e) => e.recipeId),
  );
  const pool = (recipes ?? [])
    .filter((r) => r && r.id && r.mealType === entry.slot && !sameDay.has(r.id))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (pool.length === 0) return null;
  const at = pool.findIndex((r) => r.id === entry.recipeId);
  // current recipe not in the pool (its meal type changed, or it came from a
  // table): offer the first candidate rather than nothing
  const next = pool[(at + 1) % pool.length];
  return next && next.id !== entry.recipeId ? next.id : null;
}

/**
 * Swap one planned entry onto a different recipe, keeping its date, slot,
 * servings and id. The id is deliberately preserved: it is the 409 merge key
 * and the cooked-confirmation key. A switched meal is NOT cooked any more, so
 * any confirmation on it is dropped.
 * @param {Plan} plan
 * @param {string} entryId
 * @param {string} recipeId
 * @returns {Plan}
 */
export function setEntryRecipe(plan, entryId, recipeId) {
  if (!recipeId) return plan;
  return {
    ...plan,
    entries: plan.entries.map((e) => {
      if (e.id !== entryId) return e;
      const rest = { ...e };
      // a switched meal is not the meal you cooked
      delete rest.cookedAt;
      return { ...rest, recipeId, freeText: undefined };
    }),
  };
}

/**
 * The cook timer's END (fix list 7.10, promise P7): the recorded span is the
 * truth the recipe's stated time answers to, and ending the timer IS how a
 * meal records itself cooked — the rehomed COOKED write PF.2 required before
 * Cook Mode can die. Never un-cooks: a second END on a cooked entry only
 * refreshes the span.
 * @param {Plan} plan
 * @param {string} entryId
 * @param {string} dateIso
 * @param {number} seconds recorded hands-on span; 0/negative records nothing
 * @returns {Plan}
 */
export function recordCook(plan, entryId, dateIso, seconds) {
  return {
    ...plan,
    entries: plan.entries.map((e) =>
      e.id !== entryId
        ? e
        : {
            ...e,
            cookedAt: e.cookedAt ?? dateIso,
            ...(seconds > 0 ? { cookSeconds: Math.round(seconds) } : {}),
          },
    ),
  };
}

/**
 * The "overrun was me, not the plan" note on a cooked entry (7.10): the
 * weekly review (P11) reads it beside stated-vs-recorded. Empty text clears.
 * @param {Plan} plan
 * @param {string} entryId
 * @param {string} comment
 * @returns {Plan}
 */
export function setCookComment(plan, entryId, comment) {
  const text = String(comment ?? "").trim().slice(0, 200);
  return {
    ...plan,
    entries: plan.entries.map((e) => {
      if (e.id !== entryId) return e;
      if (!text) {
        const rest = { ...e };
        delete rest.cookComment;
        return rest;
      }
      return { ...e, cookComment: text };
    }),
  };
}

/**
 * Groceries confirmed for this week (a scanned receipt is the confirmation).
 * Pure.
 * @param {Plan} plan
 * @param {string} dateIso
 * @param {{ store: string, date: string, total: number } | null} [spend] the
 *   receipt's trip total, recorded on the plan (PF.3 spend leg)
 * @returns {Plan}
 */
export function setPlanShopped(plan, dateIso, spend) {
  return {
    ...plan,
    shoppedAt: dateIso,
    // the spend leg of the one ledger (PF.3): the receipt's trip total is
    // RECORDED on the week it shopped, so P5's spent-vs-budgeted axis and
    // P11's review have a real number instead of estimates-only. Appended,
    // never replaced: a week can hold several receipts.
    ...(spend
      ? { spend: [...(Array.isArray(/** @type {any} */ (plan).spend) ? /** @type {any} */ (plan).spend : []), spend] }
      : {}),
  };
}

/**
 * Is this recipe's METHOD still behind the receipt?
 *
 * David, 2026-07-25: recipes should not show until the receipt is there. He
 * chose the soft version: the meal name, its macros and its ingredients stay
 * visible all week, and only the steps wait, with a per-meal override for the
 * nights you cook out of the pantry.
 *
 * `houseShopped` is the whole reason this takes three arguments. `shoppedAt`
 * lives on a profile's OWN week plan, but a brigade has one cook and one
 * receipt: Mom, Dad and Laurie never scan anything, so keying the gate to
 * each person's own plan would hide every instruction from three of the four
 * of them permanently. The gate asks whether the HOUSE has shopped.
 * @param {Plan | null | undefined} plan
 * @param {string} recipeId
 * @param {boolean} [houseShopped] anyone in the house confirmed this week
 * @returns {boolean}
 */
export function recipeGated(plan, recipeId, houseShopped) {
  if (!plan || !recipeId) return false;
  if (plan.shoppedAt || houseShopped) return false;
  return !(plan.unlocked ?? []).includes(recipeId);
}

/**
 * "I already have this": open one recipe for the rest of the week without
 * pretending a shop happened. Pure, and idempotent.
 * @param {Plan} plan
 * @param {string} recipeId
 * @returns {Plan}
 */
export function unlockRecipe(plan, recipeId) {
  const unlocked = plan.unlocked ?? [];
  if (!recipeId || unlocked.includes(recipeId)) return plan;
  return { ...plan, unlocked: [...unlocked, recipeId] };
}

/**
 * Toggle an entry's cooked confirmation (the DONE button after cooking).
 * Toggling, not just setting, keeps a mis-tap reversible. Pure.
 * @param {Plan} plan
 * @param {string} entryId
 * @param {string} dateIso
 * @returns {Plan}
 */
export function toggleEntryCooked(plan, entryId, dateIso) {
  return {
    ...plan,
    entries: plan.entries.map((e) =>
      e.id === entryId
        ? e.cookedAt
          ? (({ cookedAt: _gone, ...rest }) => rest)(e)
          : { ...e, cookedAt: dateIso }
        : e,
    ),
  };
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
    ...(typeof raw.shoppedAt === "string" ? { shoppedAt: raw.shoppedAt } : {}),
    // the shopped-plan snapshot (7.2): survives normalization untouched
    ...(raw.fallback &&
    typeof raw.fallback === "object" &&
    Array.isArray(raw.fallback.entries)
      ? { fallback: raw.fallback }
      : {}),
    // the spend leg (PF.3): normalize used to build an explicit shape, which
    // silently DROPPED recorded receipt totals on the next load
    ...(Array.isArray(raw.spend) ? { spend: raw.spend } : {}),
    ...(Array.isArray(raw.unlocked)
      ? { unlocked: raw.unlocked.filter((/** @type {any} */ r) => typeof r === "string") }
      : {}),
    ...(raw.buffer && typeof raw.buffer.recipeId === "string"
      ? { buffer: { recipeId: raw.buffer.recipeId, portions: Number(raw.buffer.portions) || 0 } }
      : {}),
    // the generation manifest (fix list 2.5) rides on the plan so every
    // device sees what every subsystem did on the week it is looking at
    ...(raw.manifest && typeof raw.manifest === "object" && !Array.isArray(raw.manifest)
      ? { manifest: raw.manifest }
      : {}),
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
 * Planned calories/protein for one day. Unknown recipes count 0, but ANY
 * non-recipe entry carrying est fields counts them — eating-out
 * placeholders, derived table entries, and described away meals (P9: a
 * freeText meal with est macros is real food eaten by this person; counting
 * it 0 made the manifest misreport every week containing one).
 * @param {PlanEntry[]} entries
 * @param {Map<string, any>} recipesById
 * @param {string} date
 * @returns {{ calories: number, protein: number }}
 */
export function dayTotals(entries, recipesById, date) {
  let calories = 0;
  let protein = 0;
  for (const e of entries) {
    if (e.date !== date) continue;
    // est fields are the honest path for anything not cooked from this
    // profile's own pool (a table's recipe may not even be IN their
    // filtered pool; a described away meal has no recipe at all)
    if (e.out || e.table || (!e.recipeId && (e.estCalories != null || e.estProtein != null))) {
      calories += e.estCalories ?? 0;
      protein += e.estProtein ?? 0;
      continue;
    }
    if (!e.recipeId) continue;
    const n = recipesById.get(e.recipeId)?.nutrition;
    if (!n) continue;
    calories += (n.calories ?? 0) * e.servings;
    protein += (n.protein ?? 0) * e.servings;
  }
  return { calories, protein };
}
