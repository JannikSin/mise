// Targets, the daily check-in row and the allergen table: the food and safety
// half of the old fitness.js, kept in Mise when training left for anvil on
// 2026-08-18. Nothing here is about lifting; the name "fitness" was always
// doing two jobs.
//
// fitness/targets.json and fitness/daily.json keep their paths on purpose. The
// directory name is legacy, renaming it is a seven-call-site change in main.js
// plus every per-profile copy, and it buys nothing.
import { localIsoDate, parseLocalIso } from "./dates.js";

/**
 * @typedef {{ days: Record<string, any>[] }} Daily
 */


/**
 * Patch (or create) one day's check-in row. Pure.
 * @param {Daily} daily
 * @param {string} date
 * @param {Record<string, any>} patch
 * @returns {Daily}
 */
export function upsertDay(daily, date, patch) {
  const days = daily.days ?? [];
  const existing = days.find((d) => d.date === date);
  return {
    ...daily,
    days: existing
      ? days.map((d) => (d.date === date ? { ...d, ...patch } : d))
      : [...days, { date, ...patch }],
  };
}

/**
 * A day counts toward the streak when every marker the PROFILE ACTUALLY
 * TRACKS is met (K1: the old rule hard-required David's pushups/water/
 * supplements, so a profile without those tracks could never streak):
 * sleep logged, pushups at target, water (liters) at target, every planned
 * supplement ticked — each checked only when its track is on. Water counts
 * in liters — David's rule: a cup is ~250ml, a bottle is 1L (2026-07-06).
 * A profile tracking none of the streak markers never qualifies (a streak
 * of unconditional days would be meaningless).
 * @param {Record<string, any> | undefined} day
 * @param {string[]} supplementIds
 * @param {number} pushupTarget
 * @param {number} waterTargetLiters
 * @param {string[]} [tracks] the profile's targets.tracks; absent = David's
 *   full legacy set (exact pre-K1 behavior)
 * @returns {boolean}
 */
export function dayQualifies(
  day,
  supplementIds,
  pushupTarget,
  waterTargetLiters,
  tracks = ["sleep", "weight", "pushups", "water", "supplements", "dailyDozen"],
) {
  if (!day) return false;
  const streakTracks = ["sleep", "pushups", "water", "supplements"];
  if (!streakTracks.some((t) => tracks.includes(t))) return false;
  if (tracks.includes("sleep") && (typeof day.sleepHours !== "number" || day.sleepHours <= 0))
    return false;
  if (tracks.includes("pushups") && (day.pushups ?? 0) < pushupTarget) return false;
  if (tracks.includes("water") && (day.water ?? 0) < waterTargetLiters) return false;
  if (tracks.includes("supplements")) {
    const supp = day.supplements ?? {};
    if (!supplementIds.every((id) => supp[id] === true)) return false;
  }
  return true;
}

/**
 * Consecutive qualifying days ending today — or ending yesterday when today
 * is still in progress (an unfinished today never breaks a live streak).
 * @param {Record<string, any>[]} days
 * @param {string[]} supplementIds
 * @param {number} pushupTarget
 * @param {number} waterTargetLiters
 * @param {string} todayIso
 * @param {string[]} [tracks] the profile's targets.tracks; absent = David's
 *   full legacy set (exact pre-K1 behavior)
 * @returns {number}
 */
export function computeStreak(
  days,
  supplementIds,
  pushupTarget,
  waterTargetLiters,
  todayIso,
  tracks = ["sleep", "weight", "pushups", "water", "supplements", "dailyDozen"],
) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const qualifies = (/** @type {Date} */ d) =>
    dayQualifies(
      byDate.get(localIsoDate(d)),
      supplementIds,
      pushupTarget,
      waterTargetLiters,
      tracks,
    );
  const cursor = parseLocalIso(todayIso);
  if (!qualifies(cursor)) cursor.setDate(cursor.getDate() - 1); // today still open
  let streak = 0;
  while (qualifies(cursor)) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}


/**
 * @typedef {{
 *   sex: "m" | "f",
 *   age: number,
 *   heightFt: number,
 *   heightIn: number,
 *   weightLb: number,
 *   activity: 1 | 2 | 3 | 4 | 5,
 *   goal: "loss" | "maintain" | "gain",
 *   goalWeightLb?: number
 * }} Questionnaire
 */

/**
 * The optional survey-v2 answers (sections 2 and 3). All progressive: every
 * field has a safe default, so a profile that stops after section 1 still
 * gets a working targets.json. See docs/survey-v2-design.md.
 * @typedef {{
 *   diet?: "omnivore" | "pescatarian" | "vegetarian" | "vegan",
 *   allergens?: string[],
 *   allergensFreeText?: string,
 *   skipBreakfast?: boolean,
 *   smoothie?: boolean,
 *   snackAppetite?: "grazer" | "meals",
 *   maxWeeknightMinutes?: number,
 *   dislikeIngredients?: string[],
 *   cuisinePrefs?: { loved: string[], avoided: string[] },
 *   maxDifficulty?: 1 | 2 | 3,
 *   equipment?: string[],
 *   breakfastStyle?: "sweet" | "savory" | "grab-and-go" | "surprise",
 *   budget?: "tight" | "normal" | "loose",
 *   stores?: string[],
 *   shopsPerWeek?: number,
 *   tiredOf?: string[],
 *   state?: string,
 *   leftoverTolerance?: "none" | "some" | "lots",
 *   packsLunch?: boolean,
 *   lunchMicrowave?: boolean,
 *   mealsOutPerWeek?: number
 * }} SurveyPrefs
 */

/**
 * Allergen preset id -> the ingredient-name substrings it expands to, appended
 * to targets.avoidIngredients (survey-v2 Q10). Shared by the profile gate and
 * SYS so both render the same chips and expand the same way. Deliberately
 * broad: allergy handling wants false positives over false negatives.
 * @type {Record<string, string[]>}
 */
export const ALLERGEN_TERMS = {
  nuts: ["almond", "walnut", "cashew", "pecan", "pistachio", "hazelnut", "macadamia", "nut butter"],
  peanuts: ["peanut"],
  gluten: [
    "wheat",
    "pasta",
    "bread",
    "couscous",
    "farro",
    "orzo",
    "pita",
    "flour",
    "noodle",
    "barley",
    "bulgur",
    "soy sauce",
    "panko",
    "seitan",
    "cracker",
  ],
  dairy: [
    "milk",
    "yogurt",
    "cheese",
    "whey",
    "butter",
    "cream",
    "feta",
    "halloumi",
    "cottage",
    "parmesan",
    "kefir",
    "ghee",
  ],
  eggs: ["egg"],
  soy: ["soy", "tofu", "tempeh", "edamame", "miso"],
  shellfish: ["shrimp", "prawn", "crab", "lobster", "scallop", "clam", "mussel", "oyster"],
  fish: [
    "salmon",
    "tuna",
    "cod",
    "anchovy",
    "sardine",
    "mackerel",
    "tilapia",
    "halibut",
    "trout",
    "fish sauce",
    "dashi",
  ],
  sesame: ["sesame", "tahini"],
};

/**
 * Expand chosen allergen preset ids plus a free-text "anything else" string
 * into a deduped avoidIngredients term list (survey-v2 Q10). Free-text terms
 * append verbatim (lowercased, trimmed).
 * @param {string[]} [allergens] preset ids
 * @param {string} [freeText] comma-separated extra terms
 * @returns {string[]}
 */
export function avoidTermsFromAllergens(allergens, freeText) {
  const out = new Set();
  for (const id of allergens ?? []) {
    for (const term of ALLERGEN_TERMS[id] ?? []) out.add(term);
  }
  for (const t of (freeText ?? "").split(",")) {
    const term = t.trim().toLowerCase();
    if (term) out.add(term);
  }
  return [...out];
}

/** Standard TDEE activity multipliers, sedentary through very active. */
const ACTIVITY_MULT = [1.2, 1.375, 1.55, 1.725, 1.9];

/**
 * P3's soft targets sanity gate (fix list 7.12, David's ruling 2026-08-18):
 * a stated calorie target is never taken on faith. Maintenance is computed
 * from `targets.body` (Mifflin-St Jeor × activity), the stated target is
 * compared against the physiological band, and the result is REPORTED —
 * never blocked, because fasting protocols, sport weight-cuts and 12,000
 * kcal training blocks are all real. An out-of-band target with a written
 * `targets.targetReason` (a doctor's guidance, a named protocol) is
 * respected and quiet; without one it gets a loud advisory.
 * @param {Record<string, any> | null | undefined} targets
 * @returns {{ verdict: "unchecked" | "inside" | "outside" | "outside-with-reason", maintenance?: number, low?: number, high?: number, reason?: string }}
 */
export function targetsSanity(targets) {
  const b = targets?.body;
  const stated = targets?.macros?.calories;
  if (!b || !stated || !(b.weightLb > 0) || !(b.heightIn > 0) || !(b.age > 0)) {
    return { verdict: "unchecked" };
  }
  const kg = b.weightLb * 0.45359237;
  const cm = b.heightIn * 2.54;
  const bmr = 10 * kg + 6.25 * cm - 5 * b.age + (b.sex === "m" ? 5 : -161);
  const maintenance = Math.round(bmr * (ACTIVITY_MULT[(b.activity ?? 3) - 1] ?? 1.55));
  const low = Math.round(maintenance * 0.75);
  const high = Math.round(maintenance * 1.4);
  if (stated >= low && stated <= high) return { verdict: "inside", maintenance, low, high };
  const reason =
    typeof targets?.targetReason === "string" ? targets.targetReason.trim() : "";
  return {
    verdict: reason ? "outside-with-reason" : "outside",
    maintenance,
    low,
    high,
    ...(reason ? { reason } : {}),
  };
}

/**
 * The macro floors the week generator actually ENFORCES for a profile.
 *
 * A WRITTEN floor always wins. It is the number the person read, agreed to,
 * and can hand-edit, and no formula may quietly outrank it: a written 1400 is
 * hand-set and any ratio or derivation says something else. Only a profile
 * that carries no written floor gets one derived, and the derivation is the
 * same one `targetsFromQuestionnaire` writes, so a survey profile and a
 * hand-written profile behave identically.
 *
 * NEVER a ratio of the target. The generator enforced 95% of target for
 * months, which held David to 199.5 g protein against his written 185 and
 * over-fed mom by 72.5 kcal/day, invisibly, because no screen showed the
 * enforced number. (Council 2026-08-07; David, 2026-08-10.)
 * @param {Record<string, any> | null | undefined} macros a targets.macros block
 * @returns {{ calories: number, protein: number }}
 */
export function enforcedFloors(macros) {
  const calories = Number(macros?.calories) || 0;
  const protein = Number(macros?.protein) || 0;
  const written = (/** @type {any} */ v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    calories: written(macros?.caloriesFloor) ?? Math.max(1200, calories - 200),
    protein: written(macros?.proteinFloor) ?? Math.max(0, protein - 25),
  };
}

/** The generator's slack above the calorie target. See `enforcedCeilings`. */
export const CALORIE_CEILING_RATIO = 1.05;

/**
 * The generator's own slack allowance above target. 5% of the calorie target
 * unless a profile writes `macros.caloriesCeiling` down.
 *
 * The asymmetry with `enforcedFloors` is deliberate (council 2026-08-07). A
 * FLOOR is a number the person read and agreed to, so it belongs to them and a
 * formula must never outrank it. A calorie CEILING is the generator's own
 * tolerance for its top-up passes overshooting, and nobody has ever written
 * one down, so a ratio is the honest default.
 *
 * The PROTEIN ceiling is different again and is deliberately NOT derived.
 * P5 makes it a money decision ("protein above target is money spent for
 * nothing"), and a ceiling nobody chose would silently start trimming food off
 * every profile in the app. Absent means unconstrained, and the manifest says
 * so out loud rather than leaving the absence to be discovered.
 *
 * One home for both numbers, because until 2026-08-19 the calorie ceiling was
 * computed inline in two places in weekbuilder.js and in none of the reporting,
 * which is how a live week sat 170 kcal over its ceiling with nothing saying so.
 * @param {Record<string, any> | null | undefined} macros a targets.macros block
 * @returns {{ calories: number, protein: number | null }}
 */
export function enforcedCeilings(macros) {
  const calories = Number(macros?.calories) || 0;
  const written = (/** @type {any} */ v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    calories: written(macros?.caloriesCeiling) ?? calories * CALORIE_CEILING_RATIO,
    protein: written(macros?.proteinCeiling),
  };
}


/**
 * A complete fitness/targets.json from the add-profile questionnaire, so a
 * new household member gets working macro targets without a single hand-set
 * number. Mifflin-St Jeor BMR (imperial inputs converted internally — this
 * household shops in Chicagoland, not Lyon) x activity, then a goal delta
 * (-500 loss / +300 gain). Protein anchors to bodyweight, fat to ~30% of
 * calories, carbs take the remainder. Greger's Daily Dozen targets are the
 * published dozen — the same for everyone; only the macro wrapper differs.
 * The optional `prefs` bundle (survey-v2 sections 2-3) layers taste/diet/
 * budget answers on top; every field is progressive with a safe default, so
 * an empty `prefs` reproduces the pre-survey targets exactly. Each field maps
 * to a real generation mechanism (see docs/survey-v2-design.md); fields left
 * at their default are OMITTED from the output per SCHEMAS.md (absent != null).
 * @param {Questionnaire} q
 * @param {string} [todayIso] stamps phaseSince when provided
 * @param {SurveyPrefs} [prefs] optional survey-v2 answers
 * @returns {Record<string, any>}
 */
export function targetsFromQuestionnaire(q, todayIso, prefs = {}) {
  const kg = q.weightLb * 0.45359237;
  const cm = (q.heightFt * 12 + q.heightIn) * 2.54;
  const bmr = 10 * kg + 6.25 * cm - 5 * q.age + (q.sex === "m" ? 5 : -161);
  const tdee = bmr * (ACTIVITY_MULT[q.activity - 1] ?? 1.2);
  const delta = q.goal === "loss" ? -500 : q.goal === "gain" ? 300 : 0;
  const calories = Math.max(1200, Math.round((tdee + delta) / 50) * 50);
  // Protein anchors to the weight you are heading FOR, not the one you are
  // carrying. On a loss phase the point of the protein floor is to hold onto
  // lean mass, and lean mass does not scale with the fat being lost: keying
  // 0.9 g/lb to a 300 lb bodyweight asks for 270 g, which is neither
  // achievable nor useful, and at a deficit it eats the whole calorie budget.
  // Current weight still drives BMR, which is correct — a heavier body really
  // does burn more.
  const referenceWeightLb =
    q.goal === "loss" && q.goalWeightLb && q.goalWeightLb > 0 && q.goalWeightLb < q.weightLb
      ? q.goalWeightLb
      : q.weightLb;
  const protein = Math.round(referenceWeightLb * (q.goal === "gain" ? 1.0 : 0.9));
  // heavy bodyweights at a loss deficit can push protein+fat past the
  // calorie budget — carbs must never go negative, so fat yields first
  const proteinKcal = protein * 4;
  const fat = Math.max(
    20,
    Math.min(Math.round((calories * 0.3) / 9), Math.floor((calories - proteinKcal) / 9)),
  );
  const carbs = Math.max(0, Math.round((calories - proteinKcal - fat * 9) / 4));
  const phase = q.goal === "loss" ? "loss" : q.goal === "gain" ? "gain" : "recomp";
  // one derivation, shared with the generator's fallback, so the number the
  // survey WRITES and the number generation ENFORCES can never drift apart
  const floors = enforcedFloors({ calories, protein });

  // Meal slots (survey-v2 Q11): base three, drop breakfast if skipped, add
  // smoothie when wanted AND a blender is on hand (Q16 special case — a
  // smoothie slot with no blender is a slot the profile can never cook).
  const hasBlender = !prefs.equipment || prefs.equipment.includes("blender");
  const wantSmoothie = prefs.smoothie ?? phase === "gain";
  const mealSlots = ["breakfast", "lunch", "dinner"]
    .filter((s) => !(s === "breakfast" && prefs.skipBreakfast))
    .concat(wantSmoothie && hasBlender ? ["smoothie"] : []);

  const avoidIngredients = avoidTermsFromAllergens(prefs.allergens, prefs.allergensFreeText);
  const cuisineLoved = prefs.cuisinePrefs?.loved ?? [];
  const cuisineAvoided = prefs.cuisinePrefs?.avoided ?? [];

  return {
    macros: {
      calories,
      caloriesFloor: floors.calories,
      protein,
      proteinFloor: floors.protein,
      fat,
      carbs,
      waterLiters: q.sex === "m" ? 3.5 : 2.7,
    },
    adjustmentRule:
      "Weigh most mornings; judge the 7-day average, not the day. Adjust calories by 150-200 only after two flat weeks.",
    phase,
    ...(todayIso ? { phaseSince: todayIso } : {}),
    // kept so the number that set the protein floor is visible and editable
    // later, rather than being a one-time input nobody can find again
    ...(q.goalWeightLb ? { goalWeightLb: q.goalWeightLb } : {}),
    // survey-v2 answers, each omitted when it equals its safe default so the
    // file stays lean and "absent = default" holds (SCHEMAS.md).
    ...(prefs.diet && prefs.diet !== "omnivore" ? { diet: prefs.diet } : {}),
    ...(prefs.allergens?.length ? { allergens: prefs.allergens } : {}),
    ...(avoidIngredients.length ? { avoidIngredients } : {}),
    ...(prefs.snackAppetite === "meals" ? { snackAppetite: "meals" } : {}),
    ...(prefs.maxWeeknightMinutes ? { maxWeeknightMinutes: prefs.maxWeeknightMinutes } : {}),
    ...(prefs.dislikeIngredients?.length ? { dislikeIngredients: prefs.dislikeIngredients } : {}),
    ...(cuisineLoved.length || cuisineAvoided.length
      ? { cuisinePrefs: { loved: cuisineLoved, avoided: cuisineAvoided } }
      : {}),
    ...(prefs.maxDifficulty && prefs.maxDifficulty < 3
      ? { maxDifficulty: prefs.maxDifficulty }
      : {}),
    ...(prefs.equipment ? { equipment: prefs.equipment } : {}),
    ...(prefs.breakfastStyle && prefs.breakfastStyle !== "surprise"
      ? { breakfastStyle: prefs.breakfastStyle }
      : {}),
    ...(prefs.budget && prefs.budget !== "normal" ? { budget: prefs.budget } : {}),
    ...(prefs.stores?.length ? { stores: prefs.stores } : {}),
    ...(prefs.shopsPerWeek && prefs.shopsPerWeek > 1 ? { shopsPerWeek: prefs.shopsPerWeek } : {}),
    // "eaten too much of lately": soft variety penalty in weekbuilder.
    ...(prefs.tiredOf?.length ? { tiredOf: prefs.tiredOf } : {}),
    // where they buy groceries: drives the List trip's grocery sales tax.
    ...(prefs.state ? { region: { country: "USA", state: prefs.state } } : {}),
    // captured for the generator's leftover scheduling and the chat onboarder,
    // absent = the safe default (some leftovers OK).
    ...(prefs.leftoverTolerance && prefs.leftoverTolerance !== "some"
      ? { leftoverTolerance: prefs.leftoverTolerance }
      : {}),
    ...(prefs.packsLunch ? { packsLunch: true } : {}),
    ...(prefs.packsLunch && prefs.lunchMicrowave ? { lunchMicrowave: true } : {}),
    // typical restaurant/free meals a week: read by the assistant and the
    // planner's OUT-slot expectations, absent = rarely (0)
    ...(prefs.mealsOutPerWeek ? { mealsOutPerWeek: prefs.mealsOutPerWeek } : {}),
    mealSlots,
    tracks:
      phase === "gain"
        ? ["sleep", "weight", "pushups", "water", "supplements", "dailyDozen"]
        : ["sleep", "weight", "waist", "water", "dailyDozen"],
    dailyDozen: {
      beans: 3,
      berries: 1,
      otherFruit: 3,
      cruciferousVeg: 1,
      greens: 2,
      otherVeg: 2,
      flaxseed: 1,
      nuts: 1,
      spicesHerbs: 1,
      wholeGrains: 3,
      // beverages retired 2026-08-18: hydration is tracks:"water", and the
      // bank cannot satisfy a beverages serving target (see SCHEMAS.md)
    },
    sleepHoursTarget: 8,
    priorityStack: ["Sleep", "Protein", "Water", "Everything else"],
    nonNegotiables: [],
    supplementPlan: [],
  };
}
