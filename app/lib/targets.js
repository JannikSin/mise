// Targets, the daily check-in row and the allergen table: the food and safety
// half of the old fitness.js, kept in Mise when training left for anvil on
// 2026-08-18. Nothing here is about lifting; the name "fitness" was always
// doing two jobs.
//
// fitness/targets.json and fitness/daily.json keep their paths on purpose. The
// directory name is legacy, renaming it is a seven-call-site change in main.js
// plus every per-profile copy, and it buys nothing.

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
 *   allergenExceptions?: Record<string, string[]>,
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
 * broad: allergy handling wants false positives over false negatives. Terms
 * are SUBSTRING matches, so short ones (fish, rye, malt, soy) over-refuse by
 * design; over-refusing is the safe error. Stored profiles pick up new terms
 * on every read (store.js withCurrentAllergenTerms).
 * @type {Record<string, string[]>}
 */
export const ALLERGEN_TERMS = {
  // pine nut, pesto, marzipan, nutella added after the 2026-10-18 audit: the
  // live bank had pesto and pine nuts passing a nut allergy
  nuts: [
    "almond",
    "walnut",
    "cashew",
    "pecan",
    "pistachio",
    "hazelnut",
    "macadamia",
    "nut butter",
    "pine nut",
    "brazil nut",
    "pesto",
    "marzipan",
    "praline",
    "nutella",
  ],
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
    // 2026-10-18 audit: potato gnocchi passed a gluten allergy
    "gnocchi",
    "semolina",
    "spelt",
    "rye",
    "malt",
    "tortilla",
    "crouton",
    // 2026-10-23 (D-02): Japanese curry roux blocks are wheat flour and fat, so
    // a gluten allergy passed the coconut curry while the food read "curry roux"
    "roux",
    // the same blocks sold under other words or brand names, none of which
    // says "roux" (Tribunal Red Team, 10/24, F4)
    "curry cube",
    "curry block",
    "curry sauce mix",
    "golden curry",
    "vermont curry",
    "java curry",
    "curry sauce block",
    "curry sauce cube",
    "curry brick",
    "curry mix",
    "japanese curry",
    "house curry",
    "kokumaro",
    "japanese style curry",
    "curry flake",
    "instant curry",
    "glico",
    "house foods",
    "s&b curry",
    "kare roux",
  ],
  dairy: [
    "milk",
    // Japanese curry roux blocks often carry milk solids; the label decides,
    // so the screen refuses it for dairy and the cook can check (fails closed),
    // under any of the words the blocks are sold by (Tribunal Red Team, 10/24,
    // F4), and any roux at all, since a classic roux is butter and flour
    "curry roux",
    "roux",
    "curry cube",
    "curry block",
    "curry sauce mix",
    "golden curry",
    "vermont curry",
    "java curry",
    "curry sauce block",
    "curry sauce cube",
    "curry brick",
    "curry mix",
    "japanese curry",
    "house curry",
    "kokumaro",
    "japanese style curry",
    "curry flake",
    "instant curry",
    "glico",
    "house foods",
    "s&b curry",
    "kare roux",
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
    // named cheeses and dairy sauces (2026-10-18 audit: mozzarella, cheddar,
    // queso and pesto all passed a dairy allergy; "cheese" is only in some
    // rows' names)
    "mozzarella",
    "cheddar",
    "ricotta",
    "queso",
    "paneer",
    "gruyere",
    "pecorino",
    "provolone",
    "mascarpone",
    "burrata",
    "brie",
    "gouda",
    "cotija",
    "monterey jack",
    "pepper jack",
    "labneh",
    "pesto",
    "alfredo",
    "tzatziki",
    "raita",
    "custard",
    // semisweet chips are made with milkfat (pensieve, 10/19)
    "chocolate chip",
  ],
  // mayonnaise and aioli are egg (2026-10-18 audit: onigiri with mayo passed)
  eggs: ["egg", "mayonnaise", "mayo", "aioli", "meringue"],
  // tvp and semisweet chocolate chips (soy lecithin) passed (pensieve, 10/19)
  // curry blocks by every name they are sold under (Tribunal Red Team, 10/24, F4)
  soy: [
    "soy",
    "tofu",
    "tempeh",
    "edamame",
    "miso",
    "tamari",
    "tvp",
    "textured vegetable",
    "chocolate chip",
    "curry roux",
    "curry cube",
    "curry block",
    "curry sauce mix",
    "golden curry",
    "vermont curry",
    "java curry",
    "curry sauce block",
    "curry sauce cube",
    "curry brick",
    "curry mix",
    "japanese curry",
    "house curry",
    "kokumaro",
    "japanese style curry",
    "curry flake",
    "instant curry",
    "glico",
    "house foods",
    "s&b curry",
    "kare roux",
  ],
  shellfish: [
    "shrimp",
    "prawn",
    "crab",
    "lobster",
    "scallop",
    "clam",
    "mussel",
    "oyster",
    "squid",
    "calamari",
    "octopus",
  ],
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
    // worcestershire is made with anchovy (2026-10-18 audit: it is in the
    // Wayne shepherd's pie, which passed a fish allergy)
    "worcestershire",
    "bonito",
    "fish",
  ],
  // hummus and everything bagel seasoning passed (pensieve, 10/19)
  sesame: ["sesame", "tahini", "hummus", "everything bagel"],
};

/**
 * The ONLY terms a person may clear from an allergy chip for themselves
 * (P8 plates, P3 knows-you; David's ruling 2026-10-27 for a housemate who is
 * off tree nuts but eats pine nuts and pesto with no nuts but pine nuts in
 * it). Keyed by preset id. Default stays conservative: with no exception
 * stored, the chip refuses every term it lists. An exception removes a term
 * only from what THIS chip (or a typed word naming its family) added; the
 * same term from another chip (dairy also lists "pesto") or a word the person
 * typed stays. "peanut" is never here, and a dish whose ingredient names a
 * tree nut ("walnut pesto", "cashew pesto") is still refused by that nut.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const ALLERGEN_EXCEPTIONS = Object.freeze({
  nuts: Object.freeze(["pine nut", "pesto"]),
});

/**
 * A stored `allergenExceptions` value, read tolerantly: only preset ids and
 * terms listed in ALLERGEN_EXCEPTIONS survive, anything else (a typo, an
 * unknown chip, "peanut") is dropped, so the field can only ever clear what
 * the table allows. Absent or malformed = no exceptions.
 * @param {unknown} raw
 * @returns {Record<string, string[]>}
 */
export function allergenExceptionsOf(raw) {
  /** @type {Record<string, string[]>} */
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, allowed] of Object.entries(ALLERGEN_EXCEPTIONS)) {
    const v = /** @type {Record<string, unknown>} */ (raw)[id];
    if (!Array.isArray(v)) continue;
    const terms = allowed.filter((t) => v.some((x) => String(x).toLowerCase().trim() === t));
    if (terms.length) out[id] = terms;
  }
  return out;
}

/**
 * One chip's terms with the person's own exceptions for that chip taken out.
 * @param {string} id preset id
 * @param {Record<string, string[]>} exc from allergenExceptionsOf
 * @returns {string[]}
 */
function presetTerms(id, exc) {
  const off = (Object.hasOwn(exc, id) ? exc[id] : undefined) ?? [];
  return (ALLERGEN_TERMS[id] ?? []).filter((t) => !off.includes(t));
}

/** Every cheese-like dairy term: what a typed "cheese" means. */
const CHEESE_TERMS = [
  "cheese",
  "feta",
  "halloumi",
  "cottage",
  "parmesan",
  "mozzarella",
  "cheddar",
  "ricotta",
  "queso",
  "paneer",
  "gruyere",
  "pecorino",
  "provolone",
  "mascarpone",
  "burrata",
  "brie",
  "gouda",
  "cotija",
  "monterey jack",
  "pepper jack",
  "labneh",
  "pesto",
  "alfredo",
];

/**
 * A TYPED WORD THAT NAMES A FAMILY MEANS THE FAMILY (Mise 2.0, I-02 / A-09:
 * a guest who typed "cheese" was served cheddar and parmesan, because the
 * substring screen only saw rows whose name says "cheese"). Keys are typed
 * words, singular; values are the preset ids, or "cheese" for the cheese
 * list. Only ever adds terms the person asked for, so it can only refuse more.
 * @type {Record<string, string[]>}
 */
const TYPED_FAMILIES = {
  cheese: ["cheese"],
  dairy: ["dairy"],
  lactose: ["dairy"],
  milk: ["dairy"],
  casein: ["dairy"],
  nut: ["nuts"],
  "tree nut": ["nuts"],
  peanut: ["peanuts"],
  gluten: ["gluten"],
  wheat: ["gluten"],
  celiac: ["gluten"],
  coeliac: ["gluten"],
  egg: ["eggs"],
  soy: ["soy"],
  soya: ["soy"],
  shellfish: ["shellfish"],
  seafood: ["shellfish", "fish"],
  fish: ["fish"],
  sesame: ["sesame"],
};

/**
 * The terms one typed avoid word stands for: itself, plus its family when it
 * names one ("cheeses", "Tree nuts", "eggs" all count), and each food of a
 * typed pair ("celery and okra").
 * The person's allergenExceptions apply to a family only, never to the word
 * itself: a typed "pesto" stays "pesto".
 * @param {string} word
 * @param {unknown} [exceptions] targets.allergenExceptions
 * @returns {string[]}
 */
export function typedAvoidTerms(word, exceptions) {
  const term = String(word ?? "").toLowerCase().trim();
  if (!term) return [];
  // "celery and okra" is two foods, not one phrase no ingredient is named
  // (Mise 2.0, D-01: a guest typed a pair like that on her guest form, 10/18,
  // and as one term it matched nothing). Each part counts on its own, the whole
  // phrase too, so it can only refuse more
  const parts = term.split(/\s+(?:and|or)\s+|\s*[&/;+]\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) {
    return [...new Set([term, ...parts.flatMap((p) => typedAvoidTerms(p, exceptions))])];
  }
  // own keys only: "constructor" or "__proto__" must not reach Object.prototype
  // (Tribunal Red Team, 2.0 loop 1: it threw and stopped SET)
  const famOf = (/** @type {string} */ k) =>
    Object.hasOwn(TYPED_FAMILIES, k) ? TYPED_FAMILIES[k] : undefined;
  const fam = famOf(term) ?? famOf(term.replace(/(es|s)$/, "")) ?? famOf(term.replace(/s$/, ""));
  if (!fam) return [term];
  const out = new Set([term]);
  const exc = allergenExceptionsOf(exceptions);
  for (const id of fam) {
    for (const t of id === "cheese" ? CHEESE_TERMS : presetTerms(id, exc)) out.add(t);
  }
  return [...out];
}

/**
 * Expand chosen allergen preset ids plus a free-text "anything else" string
 * into a deduped avoidIngredients term list (survey-v2 Q10). Free-text terms
 * append lowercased and trimmed, and a word naming a family brings the family
 * (typedAvoidTerms). The person's own exceptions (ALLERGEN_EXCEPTIONS) come
 * out of their chip's terms only.
 * @param {string[]} [allergens] preset ids
 * @param {string} [freeText] comma-separated extra terms
 * @param {unknown} [exceptions] targets.allergenExceptions
 * @returns {string[]}
 */
export function avoidTermsFromAllergens(allergens, freeText, exceptions) {
  const out = new Set();
  const exc = allergenExceptionsOf(exceptions);
  for (const id of allergens ?? []) {
    for (const term of presetTerms(id, exc)) out.add(term);
  }
  for (const t of (freeText ?? "").split(",")) {
    for (const term of typedAvoidTerms(t, exc)) out.add(term);
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
  const reason = typeof targets?.targetReason === "string" ? targets.targetReason.trim() : "";
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
    // `protein` IS the floor when no override is written (council
    // 2026-08-19: "Set protein to 180 g as a FLOOR, add proteinCeiling: 215,
    // delete proteinFloor" / "proteinFloor is DELETED. protein IS the floor
    // now." — the VALUE moved to 190 on David's yes, council 2026-08-26,
    // which also split the AIM out of this field entirely: the floor never
    // steers, the engine aims at macros.proteinAim ?? the ceiling). The old fallback here was `protein - 25`, a leftover of the
    // retired ONE-number semantics where `protein` was a target with a soft
    // floor beneath it. That derivation silently defeated the verdict:
    // David's profile deleted `proteinFloor` exactly as ordered and the
    // generator then enforced 155 against a ratified 180 for four days, with
    // the council's own kill-signal (deliveredG < 200/week) watching a floor
    // that had already been lowered. CARRYING OUT THE INSTRUCTION IS WHAT
    // BROKE IT. A profile that genuinely wants a soft floor beneath its
    // target writes `proteinFloor` explicitly, which is what the key is for.
    protein: written(macros?.proteinFloor) ?? Math.max(0, protein),
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

  // exceptions only for a chip the person picked (P8, David 2026-10-27)
  const exceptions = Object.fromEntries(
    Object.entries(allergenExceptionsOf(prefs.allergenExceptions)).filter(([id]) =>
      (prefs.allergens ?? []).includes(id),
    ),
  );
  const avoidIngredients = avoidTermsFromAllergens(
    prefs.allergens,
    prefs.allergensFreeText,
    exceptions,
  );
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
    ...(Object.keys(exceptions).length ? { allergenExceptions: exceptions } : {}),
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

// EDITING A PROFILE YOU ALREADY HAVE (David, 2026-10-18: "one profile per
// person ... I kind of like the fuller questions"; decision 0013: "targets are
// set from Mise's Settings; hand edits of the mirrored targets pair end").
// P3. The survey re-run is MERGED into the file, never written over it: the
// file carries hand-set fields the survey knows nothing about (currencies,
// supplement ids shared with Anvil, protein provenance...), and a rebuild
// would erase them (Tribunal plan gate).

/** Answers the survey owns. Absent in a fresh answer = its default, so removed. */
export const SURVEY_OWNED = [
  "phase",
  "goalWeightLb",
  "diet",
  "allergens",
  "allergenExceptions",
  "avoidIngredients",
  "snackAppetite",
  "maxWeeknightMinutes",
  "dislikeIngredients",
  "cuisinePrefs",
  "maxDifficulty",
  "equipment",
  "breakfastStyle",
  "budget",
  "stores",
  "shopsPerWeek",
  "tiredOf",
  "region",
  "leftoverTolerance",
  "packsLunch",
  "lunchMicrowave",
  "mealsOutPerWeek",
];

/** Body numbers the survey owns inside `body`; other body keys are kept. */
export const BODY_OWNED = ["sex", "age", "heightIn", "weightLb", "activity", "goalWeightLb"];

/**
 * A stated calorie target outside this band, against Mise's own
 * recommendation, needs a typed reason (P3: "an override outside the
 * physiological safe band requires a stated reason ... a loud advisory,
 * never a hard block").
 * @param {number} stated
 * @param {number} recommended
 */
export function outsideSafeBand(stated, recommended) {
  if (!(recommended > 0) || !(stated > 0)) return false;
  return stated < recommended * 0.75 || stated > recommended * 1.4;
}

/**
 * Merge a fresh survey result into the existing targets file.
 * @param {Record<string, any>} existing the file as it is
 * @param {Record<string, any>} fresh targetsFromQuestionnaire's output
 * @param {{ calories: number, protein: number, reason?: string, todayIso: string,
 *   body?: Record<string, any>, goalDate?: string }} stated the numbers the person
 *   keeps (pre-filled from the file), an override reason, today, the body numbers
 * @returns {Record<string, any>}
 */
export function mergeProfileAnswers(existing, fresh, stated) {
  /** @type {Record<string, any>} */
  const out = { ...(existing ?? {}) };
  for (const k of SURVEY_OWNED) {
    if (fresh[k] === undefined) delete out[k];
    else out[k] = fresh[k];
  }
  // the person's own stated numbers win; floors and the rest of macros stay
  out.macros = {
    ...(existing?.macros ?? {}),
    calories: Math.round(stated.calories),
    protein: Math.round(stated.protein),
  };
  if (existing?.phase !== fresh.phase) out.phaseSince = stated.todayIso;
  // the survey's other defaults fill only what is missing
  for (const k of Object.keys(fresh)) {
    if (k === "macros" || k === "phaseSince" || SURVEY_OWNED.includes(k)) continue;
    if (out[k] === undefined) out[k] = fresh[k];
  }
  if (stated.body) {
    const body = { ...(existing?.body ?? {}) };
    for (const k of BODY_OWNED) if (stated.body[k] !== undefined) body[k] = stated.body[k];
    out.body = body;
  }
  // `base` carries only what the file had nowhere (decision 0013's base stage):
  // the goal's date; the body numbers already live in `body`
  if (stated.goalDate) {
    out.base = { ...(existing?.base ?? {}), goal: { ...(existing?.base?.goal ?? {}), date: stated.goalDate } };
  }
  if (stated.reason?.trim()) {
    out.targetOverride = { reason: stated.reason.trim(), on: stated.todayIso, calories: out.macros.calories };
  }
  return out;
}
