// THE TRANSFORM (docs/per-person-plates-design.md, "the engine"): David's
// matrix multiplication, implemented exactly as §0.1 states it —
//
//   plate_p = T_p · r      (a diagonal per-seat transform over role-space)
//   pot     = Σ_p plate_p  (multiply everything FIRST, then add it after)
//
// Deterministic, closed-form, offline, zero API calls. The solve is the
// EXACT optimum for two targets (calories, protein); nothing heuristic
// could beat it, only vary. The AI layer proposes dishes upstream; this
// module does arithmetic and refuses loudly when it cannot (spec §8.9).
//
// THE SHOPPED-WEEK FREEZE (David, 2026-08-10): a week that has been bought
// is untouchable. Callers pass `weekShopped`; when true the transform runs
// rung 0f and returns uniform regardless of tags. No change may affect a
// bought week unless explicitly, explicitly, explicitly stated.
import { SERVINGS_MIN, BRIGADE_SERVINGS_MAX } from "./tables.js";
import { scaleQty } from "./portions.js";

// ---------------------------------------------------------------------------
// DATA. MACRO is AI-drafted per 100 g and guarded by the category-band and
// scale-invariance tests (spec §6.2): §4.4 normalization means only the
// RATIOS between foods matter, so a table uniformly 15% off changes nothing.
// Entries state COOKED unless the bank writes the food raw. PLATE_GRAMS is
// HAND-ENTERED (normalization does NOT protect physical weights) and grows
// with the plated set; a food without a bridge leaves its bucket incomplete
// and the dish degrades to uniform, honestly, per rung 1.
// ---------------------------------------------------------------------------

/** @typedef {"protein" | "carbfat" | "veg" | "flavor"} Part */

/** per 100 g: [kcal, protein g]. COOKED basis unless noted. */
export const MACRO = /** @type {Record<string, [number, number]>} */ ({
  // protein foods
  "chicken breast": [165, 31],
  "chicken thigh": [209, 26],
  chicken: [190, 28],
  "ground turkey": [203, 27],
  turkey: [189, 29],
  "ground beef": [250, 26],
  beef: [250, 26],
  steak: [271, 25],
  pork: [242, 27],
  salmon: [206, 22],
  tuna: [132, 28],
  shrimp: [99, 24],
  cod: [105, 23],
  tilapia: [128, 26],
  egg: [155, 13],
  tofu: [76, 8],
  tempeh: [193, 20],
  "greek yogurt": [59, 10],
  "cottage cheese": [98, 11],
  skyr: [63, 11],
  feta: [264, 14],
  mozzarella: [280, 28],
  cheese: [350, 25],
  halloumi: [321, 22],
  paneer: [321, 21],
  seitan: [141, 25],
  // carbfat foods
  rice: [130, 2.7],
  "brown rice": [112, 2.3],
  farro: [130, 5],
  quinoa: [120, 4.4],
  couscous: [112, 3.8],
  pasta: [158, 5.8],
  noodle: [138, 4.5],
  bread: [265, 9],
  sourdough: [272, 11],
  pita: [275, 9],
  tortilla: [306, 8],
  potato: [87, 1.9],
  "sweet potato": [90, 2],
  oats: [71, 2.5],
  barley: [123, 2.3],
  bulgur: [83, 3.1],
  lentils: [116, 9],
  chickpeas: [164, 8.9],
  "black beans": [132, 8.9],
  beans: [127, 8.7],
  hummus: [166, 8],
  avocado: [160, 2],
  almonds: [579, 21],
  walnuts: [654, 15],
  "peanut butter": [588, 25],
  granola: [471, 10],
  honey: [304, 0.3],
  // veg (kcal barely move; entries exist so the veg bucket is honest)
  broccoli: [35, 2.4],
  spinach: [23, 2.9],
  zucchini: [17, 1.2],
  "bell pepper": [26, 1],
  pepper: [26, 1],
  carrot: [41, 0.9],
  cucumber: [15, 0.7],
  tomato: [18, 0.9],
  lettuce: [15, 1.4],
  kale: [35, 2.9],
  cabbage: [23, 1.3],
  cauliflower: [23, 1.8],
  "green beans": [35, 1.9],
  asparagus: [22, 2.4],
  mushroom: [28, 2.2],
  onion: [40, 1.1],
  celery: [14, 0.7],
});

/**
 * Nutrition-grade gram bridges for NON-MASS units, keyed food -> unit ->
 * grams (spec §6.1: hand-entered, lives HERE and never in FOOD_UNITS, whose
 * own header says "never nutrition-grade"). Cooked-basis, matching MACRO.
 */
export const PLATE_GRAMS = /** @type {Record<string, Record<string, number>>} */ ({
  rice: { cup: 195 },
  "brown rice": { cup: 195 },
  farro: { cup: 170 },
  quinoa: { cup: 185 },
  couscous: { cup: 157 },
  pasta: { cup: 140 },
  lentils: { cup: 198 },
  chickpeas: { cup: 164 },
  "black beans": { cup: 172 },
  beans: { cup: 172 },
  oats: { cup: 90 },
  egg: { unit: 50, large: 50 },
  bread: { slice: 40, unit: 40 },
  sourdough: { slice: 50, unit: 50 },
  pita: { unit: 60 },
  tortilla: { unit: 45 },
  avocado: { unit: 150 },
  potato: { unit: 170 },
  "sweet potato": { unit: 130 },
  "chicken breast": { unit: 174 },
  broccoli: { cup: 91, unit: 300 },
  spinach: { cup: 30 },
  zucchini: { unit: 196, cup: 124 },
  "bell pepper": { unit: 120 },
  carrot: { unit: 61, cup: 122 },
  tomato: { unit: 123 },
  onion: { unit: 110 },
});

/** Foods a rung-3 top-up may add to a plate (a property of the FOOD). */
export const PLATE_ADDABLE = [
  "egg",
  "greek yogurt",
  "cottage cheese",
  "skyr",
  "bread",
  "rice",
  "avocado",
  "almonds",
  "peanut butter",
  "hummus",
  "chickpeas",
];

/** keyword -> part, first match wins; longest keys first at build time */
const PART_KEYWORDS = /** @type {[string, Part][]} */ ([
  // in-pan fats file as flavor DELIBERATELY (spec §4.2 fat rule): "give her
  // a quarter of the cooking oil" is not an instruction a human can follow
  ["olive oil", "flavor"],
  ["sesame oil", "flavor"],
  ["butter", "flavor"],
  ["ghee", "flavor"],
  ["oil", "flavor"],
  ["chicken", "protein"],
  ["turkey", "protein"],
  ["beef", "protein"],
  ["steak", "protein"],
  ["pork", "protein"],
  ["salmon", "protein"],
  ["tuna", "protein"],
  ["shrimp", "protein"],
  ["cod", "protein"],
  ["tilapia", "protein"],
  ["fish", "protein"],
  ["egg", "protein"],
  ["tofu", "protein"],
  ["tempeh", "protein"],
  ["seitan", "protein"],
  ["yogurt", "protein"],
  ["cottage cheese", "protein"],
  ["skyr", "protein"],
  ["kefir", "protein"],
  ["feta", "protein"],
  ["mozzarella", "protein"],
  ["halloumi", "protein"],
  ["paneer", "protein"],
  ["ricotta", "protein"],
  ["cheese", "protein"],
  ["rice", "carbfat"],
  ["farro", "carbfat"],
  ["quinoa", "carbfat"],
  ["couscous", "carbfat"],
  ["pasta", "carbfat"],
  ["noodle", "carbfat"],
  ["bread", "carbfat"],
  ["sourdough", "carbfat"],
  ["pita", "carbfat"],
  ["tortilla", "carbfat"],
  ["potato", "carbfat"],
  ["oat", "carbfat"],
  ["barley", "carbfat"],
  ["bulgur", "carbfat"],
  ["lentil", "carbfat"],
  ["chickpea", "carbfat"],
  ["bean", "carbfat"],
  ["hummus", "carbfat"],
  ["avocado", "carbfat"],
  ["almond", "carbfat"],
  ["walnut", "carbfat"],
  ["peanut", "carbfat"],
  ["granola", "carbfat"],
  ["honey", "carbfat"],
  ["broccoli", "veg"],
  ["spinach", "veg"],
  ["zucchini", "veg"],
  ["pepper", "veg"],
  ["carrot", "veg"],
  ["cucumber", "veg"],
  ["tomato", "veg"],
  ["lettuce", "veg"],
  ["kale", "veg"],
  ["cabbage", "veg"],
  ["cauliflower", "veg"],
  ["green bean", "veg"],
  ["asparagus", "veg"],
  ["mushroom", "veg"],
  ["celery", "veg"],
]);

/**
 * Derive a row's part. An explicit `ingredients[].part` wins; an in-pan fat
 * stays flavor unless the row carries `atPlating: true`; anything unknown
 * resolves to flavor, which never moves — unknown data behaves as today.
 * @param {Record<string, any>} ing
 * @returns {Part}
 */
export function partOf(ing) {
  const explicit = ing?.part;
  if (explicit === "protein" || explicit === "carbfat" || explicit === "veg" || explicit === "flavor") {
    return explicit;
  }
  const food = String(ing?.food ?? "").toLowerCase();
  for (const [kw, part] of PART_KEYWORDS) {
    if (!food.includes(kw)) continue;
    if (part === "flavor" && ing?.atPlating) return "carbfat"; // a plated drizzle IS portionable
    return part;
  }
  return "flavor";
}

/** grams for one qty of a row, or null when no nutrition-grade bridge exists */
function gramsOf(/** @type {Record<string, any>} */ ing) {
  const qty = Number(ing?.qty ?? 0);
  const unit = String(ing?.unit ?? "").toLowerCase();
  if (!(qty > 0)) return null;
  if (unit === "g") return qty;
  if (unit === "kg") return qty * 1000;
  if (unit === "oz") return qty * 28.35;
  if (unit === "lb") return qty * 453.6;
  const food = String(ing?.food ?? "").toLowerCase();
  const key = Object.keys(PLATE_GRAMS).find((k) => food.includes(k));
  const bridge = key ? PLATE_GRAMS[key]?.[unit] : undefined;
  return bridge ? qty * bridge : null;
}

/** MACRO row for a food, or null */
function macroOf(/** @type {string} */ food) {
  const f = food.toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const k of Object.keys(MACRO)) {
    if (f.includes(k) && k.length > bestLen) {
      best = MACRO[k];
      bestLen = k.length;
    }
  }
  return best;
}

export const SYNTH_V = 1;

/** clamps on alpha/beta by phase (spec §4.5, relative form) */
const CLAMPS = /** @type {Record<string, [number, number, number, number]>} */ ({
  gain: [0.8, 2.0, 0.6, 1.6],
  loss: [0.8, 1.75, 0.3, 1.2],
  cut: [0.8, 1.75, 0.3, 1.2],
  recomp: [0.75, 1.5, 0.6, 1.4],
});
const DEFAULT_CLAMPS = /** @type {[number, number, number, number]} */ ([0.75, 1.5, 0.6, 1.4]);

/** absolute per-plate caps, checked on the PLATE, never silently off (§4.5) */
const DEFAULT_PROTEIN_CAP_G = 100;
const DEFAULT_CALORIES_CAP = 2500;

/**
 * Solve ONE seat's multipliers (spec §4.3, relative form).
 *
 * @param {{
 *   recipe: Record<string, any>,
 *   assembly: string | undefined,
 *   seat: { servings: number, rawServings?: number },
 *   targets: Record<string, any> | null,
 *   slotShare: number,
 *   weekShopped?: boolean,
 * }} args
 * @returns {{
 *   synthMode: "solved" | "uniform",
 *   alpha: number, beta: number,
 *   rung: string,
 *   note?: string,
 *   hit?: { calories: number, protein: number, targetCalories: number, targetProtein: number },
 * }}
 */
export function solveSeat({ recipe, assembly, seat, targets, slotShare, weekShopped }) {
  const uniform = (/** @type {string} */ rung, /** @type {string} */ note = "") => ({
    synthMode: /** @type {const} */ ("uniform"),
    alpha: 1,
    beta: 1,
    rung,
    ...(note ? { note } : {}),
  });

  // rung 0f, THE SHOPPED-WEEK FREEZE (David): a bought week is untouchable
  if (weekShopped) return uniform("0f-week-shopped");
  // rung 0: the tag is the rollout mechanism; absent = mixed = today
  if (assembly !== "plated") return uniform("0-mixed");
  // rung 5
  const n = recipe?.nutrition ?? {};
  if (!(n.calories > 0) || !(n.protein > 0)) return uniform("5-no-nutrition");
  // rung 4: unreadable targets -> uniform for THIS seat only
  if (!targets?.macros?.calories || !targets?.macros?.protein) return uniform("4-no-targets");

  const s = Number(seat.servings) || 1;
  // sigma (spec §4.3): stored rawServings when it matches the stored
  // servings' provenance; a HAND-EDITED seat (servings != round(clamp(raw)))
  // means the human's number IS the target: sigma := s_p.
  let sigma = Number(seat.rawServings);
  if (!Number.isFinite(sigma) || sigma <= 0) sigma = s; // rung 0d shape: no raw stored
  else {
    const quarters = Math.round(sigma * 4) / 4;
    const expected = Math.min(BRIGADE_SERVINGS_MAX, Math.max(SERVINGS_MIN, quarters));
    if (Math.abs(expected - s) > 1e-9) sigma = s; // manual override
  }
  if (!Number.isFinite(sigma) || sigma <= 0) return uniform("0d-bad-sigma");

  // per-serving buckets, normalized against the audited blob (§4.4)
  const servings = recipe.servings > 0 ? recipe.servings : 1;
  /** @type {Record<Part, [number, number]>} */
  const raw = { protein: [0, 0], carbfat: [0, 0], veg: [0, 0], flavor: [0, 0] };
  let missing = false;
  for (const ing of recipe.ingredients ?? []) {
    const part = partOf(ing);
    const grams = gramsOf(ing);
    const m = macroOf(String(ing.food ?? ""));
    if (part === "flavor") continue; // never moves; rides in the remainder
    if (grams === null || !m) {
      missing = true;
      continue;
    }
    raw[part][0] += (grams * m[0]) / 100;
    raw[part][1] += (grams * m[1]) / 100;
  }
  const rawC = raw.protein[0] + raw.carbfat[0] + raw.veg[0];
  const rawP = raw.protein[1] + raw.carbfat[1] + raw.veg[1];
  // rung 0b: zero-denominator guard (§4.4) — an all-flavor or unbridged dish
  if (!(rawC > 0) || !(rawP > 0) || missing) return uniform("1-degenerate", "this dish is one thing nutritionally; only the amount can change");

  const kC = n.calories / rawC;
  const kP = n.protein / rawP;
  const Cpro = (raw.protein[0] * kC) / servings;
  const Ppro = (raw.protein[1] * kP) / servings;
  const Ccf = (raw.carbfat[0] * kC) / servings;
  const Pcf = (raw.carbfat[1] * kP) / servings;
  const Cveg = (raw.veg[0] * kC) / servings;
  const Pveg = (raw.veg[1] * kP) / servings;
  const Cfla = n.calories / servings - Cpro - Ccf - Cveg;
  const Pfla = n.protein / servings - Ppro - Pcf - Pveg;

  const Cs = (targets.macros.calories * slotShare) / sigma - (Cveg + Cfla);
  const Ps = (targets.macros.protein * slotShare) / sigma - (Pveg + Pfla);

  const det = Cpro * Pcf - Ccf * Ppro;
  const norm = Math.hypot(Cpro, Ccf) * Math.hypot(Ppro, Pcf);
  // rung 1: RELATIVE conditioning, never a unitless epsilon (spec §4.6)
  if (!(norm > 0) || Math.abs(det) < 0.05 * norm) {
    return uniform("1-degenerate", "this dish is one thing nutritionally; only the amount can change");
  }
  let alpha = (Cs * Pcf - Ccf * Ps) / det;
  let beta = (Cpro * Ps - Cs * Ppro) / det;

  const phase = String(targets.phase ?? "recomp");
  const [aLo, aHi, bLo, bHi] = CLAMPS[phase] ?? DEFAULT_CLAMPS;
  const ca = Math.min(aHi, Math.max(aLo, alpha));
  const cb = Math.min(bHi, Math.max(bLo, beta));
  let clamped = ca !== alpha || cb !== beta;
  alpha = ca;
  beta = cb;

  // absolute plate caps (§4.5): the REAL ceiling — the composite relative
  // range reaches 20x through a hand-edited seat, so these never come off
  const capP = Number(targets.macros.plateProteinCapG) > 0 ? Number(targets.macros.plateProteinCapG) : DEFAULT_PROTEIN_CAP_G;
  const capC = Number(targets.macros.plateCaloriesCap) > 0 ? Number(targets.macros.plateCaloriesCap) : DEFAULT_CALORIES_CAP;
  const plateP = () => s * (alpha * Ppro + beta * Pcf + Pveg + Pfla);
  const plateC = () => s * (alpha * Cpro + beta * Ccf + Cveg + Cfla);
  // the ABSOLUTE caps outrank the relative clamp floors on purpose: a cap
  // that cannot push a multiplier below the clamp floor is not absolute,
  // and the kilogram-of-chicken path re-opens through that gap
  if (plateP() > capP && Ppro > 0) {
    alpha = Math.max(0, (capP / s - beta * Pcf - Pveg - Pfla) / Ppro);
    clamped = true;
  }
  if (plateC() > capC && Ccf > 0) {
    beta = Math.max(0, (capC / s - alpha * Cpro - Cveg - Cfla) / Ccf);
    clamped = true;
  }

  // achieved-vs-target from the CLAMPED multipliers (§4.7 rung 2): never
  // report the target as achieved. Also emitted when the sigma/s_p residual
  // alone exceeds 10% (Red Team R10), independent of any clamp.
  const achC = Math.round(plateC());
  const achP = Math.round(plateP());
  const tgtC = Math.round(targets.macros.calories * slotShare);
  const tgtP = Math.round(targets.macros.protein * slotShare);
  const residual = Math.abs(s / sigma - 1) > 0.1;
  const hit = clamped || residual ? { calories: achC, protein: achP, targetCalories: tgtC, targetProtein: tgtP } : undefined;

  return {
    synthMode: "solved",
    alpha,
    beta,
    rung: clamped ? "2-clamped" : "solved",
    ...(hit ? { hit } : {}),
  };
}

/**
 * Synthesize the POT and the per-seat plate rows for a table (spec §5).
 * `pot.rows` preserves the recipe's row identity EXACTLY (§4.8: same
 * length, same foods, same order, same units — tested). Uniform mode is
 * bit-compatible with today: every multiplier 1.
 *
 * @param {{
 *   recipe: Record<string, any>,
 *   seats: { id: string, servings: number, rawServings?: number, status?: string }[],
 *   targetsById: Map<string, Record<string, any> | null>,
 *   slotShares: Record<string, number>,
 *   weekShopped?: boolean,
 * }} args
 */
export function synthesize({ recipe, seats, targetsById, slotShares, weekShopped }) {
  const assembly = recipe?.assembly;
  const live = (seats ?? []).filter((x) => x.status !== "skipped");
  /** @type {Record<string, ReturnType<typeof solveSeat>>} */
  const bySeat = {};
  let anySolved = false;
  for (const seat of live) {
    const r = solveSeat({
      recipe,
      assembly,
      seat,
      targets: targetsById.get(seat.id) ?? null,
      slotShare: slotShares[seat.id] ?? 0,
      weekShopped,
    });
    bySeat[seat.id] = r;
    if (r.synthMode === "solved") anySolved = true;
  }

  // q[i][p] at full float precision; pot = sum, rounded ONCE (§5.3)
  const rows = (recipe?.ingredients ?? []).map((/** @type {Record<string, any>} */ ing) => {
    const part = partOf(ing);
    const perServing = Number(ing.qty ?? 0) / (recipe.servings > 0 ? recipe.servings : 1);
    /** @type {Record<string, number>} */
    const perSeat = {};
    let total = 0;
    for (const seat of live) {
      const r = bySeat[seat.id] ?? { alpha: 1, beta: 1 };
      const m = part === "protein" ? r.alpha : part === "carbfat" ? r.beta : 1;
      const q = perServing * (Number(seat.servings) || 0) * m;
      perSeat[seat.id] = q;
      total += q;
    }
    return { food: ing.food, unit: ing.unit, part, qty: scaleQty(total, ing.unit, 1), raw: total, perSeat };
  });

  // float tripwire (§5.4.2): catches NaN and unit mishandling, nothing more
  for (const row of rows) {
    const sum = Object.values(row.perSeat).reduce((a, b) => a + b, 0);
    const tol = Math.max(0.01 * Math.abs(row.raw), row.unit === "g" || row.unit === "ml" ? 0.01 : 0.5);
    if (!Number.isFinite(sum) || Math.abs(sum - row.raw) > tol) {
      // refuse the TAILORING, never the dinner (§5.4)
      return { synthMode: /** @type {const} */ ("uniform"), rows: null, bySeat: {}, refused: "conservation" };
    }
  }

  return {
    synthMode: anySolved ? /** @type {const} */ ("solved") : /** @type {const} */ ("uniform"),
    rows,
    bySeat,
  };
}

// ---------------------------------------------------------------------------
// THE FROZEN POT (spec §10): the contract for MONEY AND BUYING, and nothing
// else. Serialized to a STRING so mergeFieldWise treats it atomically (last
// writer wins whole, never a field-wise interleave of two freezes). Frozen
// only when synthMode is "solved" — an unclaimed-or-uniform table has no
// pot and runs today's paths, which is what makes this deploy inert.
// ---------------------------------------------------------------------------

/**
 * Build the frozen pot string for a table, or null when there is nothing to
 * freeze (uniform mode, refused synthesis, no rows).
 * @param {{
 *   recipe: Record<string, any>,
 *   seats: { id: string, servings: number, rawServings?: number, status?: string }[],
 *   targetsById: Map<string, Record<string, any> | null>,
 *   slotShares: Record<string, number>,
 *   weekShopped?: boolean,
 *   targetShas?: Record<string, string>,
 * }} args
 * @returns {string | null}
 */
export function freezePotString({ recipe, seats, targetsById, slotShares, weekShopped, targetShas }) {
  const out = synthesize({ recipe, seats, targetsById, slotShares, weekShopped });
  if (out.synthMode !== "solved" || !out.rows) return null;
  const fingerprint = {
    recipeRev: recipeRevOf(recipe),
    targets: targetShas ?? {},
  };
  return JSON.stringify({
    synthV: SYNTH_V,
    inputs: fingerprint,
    synthMode: "solved",
    rows: out.rows.map((/** @type {any} */ r) => ({ food: r.food, unit: r.unit, qty: r.qty })),
  });
}

/** content hash of the inputs that shape the pot: ingredients + servings + tag */
export function recipeRevOf(/** @type {Record<string, any>} */ recipe) {
  const basis = JSON.stringify({
    s: recipe?.servings ?? 1,
    a: recipe?.assembly ?? "",
    i: (recipe?.ingredients ?? []).map((/** @type {any} */ x) => [x.food, x.qty, x.unit, x.part ?? "", Boolean(x.atPlating)]),
  });
  // djb2: deterministic, tiny, no crypto dependency, not security-bearing
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

/**
 * Parse and VALIDATE a frozen pot against the bank recipe (spec §10,
 * Engineer H3): inside try/catch so a malformed string drops THE POT with
 * the caller told why, never the table; full §4.8 identity (every row's
 * food, in order — a permuted pot passes a length check); finite
 * quantities; no merge keys on rows (§8.1).
 * @param {string | undefined} potString
 * @param {Record<string, any> | undefined} bankRecipe
 * @returns {{ synthV: number, rows: { food: string, unit: string, qty: number }[] } | null}
 */
export function parsePot(potString, bankRecipe) {
  if (typeof potString !== "string" || !potString) return null;
  try {
    const pot = JSON.parse(potString);
    if (pot?.synthMode !== "solved" || !Array.isArray(pot.rows)) return null;
    const ings = bankRecipe?.ingredients ?? [];
    if (pot.rows.length !== ings.length) return null;
    for (let i = 0; i < pot.rows.length; i++) {
      const row = pot.rows[i];
      if (row.food !== ings[i].food || row.unit !== ings[i].unit) return null;
      // typeof check on purpose: JSON.stringify(NaN) becomes null, and
      // Number(null) is 0 — finite, and wrong. Only a real number passes.
      if (typeof row.qty !== "number" || !Number.isFinite(row.qty) || row.qty < 0) return null;
      if ("id" in row || "date" in row) return null; // §8.1: never merge-keyed
    }
    // sanitize: only the contract fields survive into consumers (money,
    // shopping) — extra keys in a hand-editable shared file die here
    return {
      synthV: Number(pot.synthV) || 0,
      rows: pot.rows.map((/** @type {any} */ r) => ({ food: r.food, unit: r.unit, qty: r.qty })),
    };
  } catch {
    return null;
  }
}
