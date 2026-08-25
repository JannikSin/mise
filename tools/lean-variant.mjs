// THE MACRO TRANSFORM (David, 2026-08-25): "taking the recipes we have
// stored in ratios... use a transform like a matrix transform to adjust it
// to the profile — have it make me eat a dinner with less protein and more
// calories."
//
// Exactly that, deterministically. A dish is a component vector in grams;
// its ingredients split into a PROTEIN group and a CARB/FAT group (veg and
// flavor ride along unscaled). Solving
//
//   [ P_p  P_c ] [x]   [ targetProtein - P_veg ]
//   [ C_p  C_c ] [y] = [ targetCalories - C_veg ]
//
// gives the two scale factors (x = protein-group scale, y = carb-group
// scale) that land the dish on the target. Clamped to [0, 3] so the result
// stays a dish; when a clamp binds, the solver re-solves the free axis for
// CALORIES (the floor the day depends on) and reports the protein it
// actually reaches — honest, never silently off-target.
//
// This is an AUTHORING calculator, not a runtime engine: it emits computed
// per-serving macros and scaled gram quantities for a recipe file a human
// then finishes (instructions, food groups, audit). The council line holds:
// deterministic arithmetic in the core, anything cleverer is written down
// as a real bank recipe every consumer already understands.
//
// Usage:
//   node tools/lean-variant.mjs '<json>'
// where <json> is {"components":[{"food":"rice","grams":200,"group":"carb"},...],
//                  "targetProtein":11,"targetCalories":590}
// Macros per 100 g come from app/lib/synth.js MACRO (kcal, protein), plus a
// local carb/fat table for the report line.

import { MACRO } from "../app/lib/synth.js";

/** carbs/fat per 100 g for the foods the lean dinners use — report-only
 * (kcal and protein, the two numbers the engine enforces, come from MACRO).
 * @type {Record<string, [number, number]>} */
export const CARB_FAT = {
  rice: [28, 0.3],
  "brown rice": [23.5, 0.9],
  pasta: [31, 0.9],
  potato: [20, 0.1],
  "sweet potato": [21, 0.1],
  "coconut milk": [6, 21],
  butter: [0.1, 81],
  "olive oil": [0, 100],
  "sesame oil": [0, 100],
  broccoli: [7, 0.4],
  cauliflower: [5, 0.3],
  cabbage: [6, 0.1],
  spinach: [3.6, 0.4],
  mushroom: [3.3, 0.3],
  tomato: [3.9, 0.2],
  "bell pepper": [6, 0.3],
  carrot: [10, 0.2],
  onion: [9.3, 0.1],
  corn: [19, 1.2],
  parmesan: [4, 29],
  bread: [49, 3.2],
};

/** synth MACRO rows this tool also needs that the app table lacks; kcal and
 * protein per 100 g, same convention. Kept here (tool-local) so the app's
 * table only grows when app code needs a food. */
export const EXTRA_MACRO = {
  "coconut milk": [197, 2],
  butter: [717, 0.9],
  "olive oil": [884, 0],
  "sesame oil": [884, 0],
  parmesan: [431, 38],
};

const macroOf = (food) => {
  const m = MACRO[food] ?? EXTRA_MACRO[food];
  if (!m) throw new Error(`no macro row for "${food}" — add it before scaling`);
  return m;
};

/**
 * @param {{ components: { food: string, grams: number, group?: "protein"|"carb"|"fixed" }[],
 *           targetProtein: number, targetCalories: number }} spec
 */
export function solveLean(spec) {
  const groups = { protein: [0, 0], carb: [0, 0], fixed: [0, 0] };
  for (const c of spec.components) {
    const [kcal, pro] = macroOf(c.food);
    const g = groups[c.group ?? "fixed"];
    g[0] += (kcal * c.grams) / 100;
    g[1] += (pro * c.grams) / 100;
  }
  const needPro = spec.targetProtein - groups.fixed[1];
  const needCal = spec.targetCalories - groups.fixed[0];
  const [Cp, Pp] = groups.protein;
  const [Cc, Pc] = groups.carb;
  const det = Pp * Cc - Pc * Cp;
  let x = 1;
  let y = 1;
  if (Cp === 0 && Cc > 0) {
    // no protein group: one unknown, solve the carb scale for CALORIES
    y = needCal / Cc;
  } else if (Cc === 0 && Cp > 0) {
    // no carb group: solve the protein scale for calories
    x = needCal / Cp;
  } else if (det !== 0) {
    x = (needPro * Cc - needCal * Pc) / det;
    y = (needCal * Pp - needPro * Cp) / det;
  }
  const clamp = (v) => Math.min(3, Math.max(0, v));
  const cx = clamp(x);
  const cy = clamp(y);
  const solved = { x: cx, y: cy, clamped: cx !== x || cy !== y };
  if (solved.clamped) {
    // a bound clamp: hold the clamped axis, re-solve the free one for
    // CALORIES (the floor the day depends on); protein lands where it lands
    // and is REPORTED, never fudged
    if (cx !== x && Cc > 0) solved.y = clamp((needCal - cx * Cp) / Cc);
    else if (cy !== y && Cp > 0) solved.x = clamp((needCal - cy * Cc) / Cp);
  }
  const out = spec.components.map((c) => ({
    ...c,
    grams:
      Math.round(
        c.grams * (c.group === "protein" ? solved.x : c.group === "carb" ? solved.y : 1),
      ),
  }));
  const totals = out.reduce(
    (t, c) => {
      const [kcal, pro] = macroOf(c.food);
      const [carb, fat] = CARB_FAT[c.food] ?? [0, 0];
      t.calories += (kcal * c.grams) / 100;
      t.protein += (pro * c.grams) / 100;
      t.carbs += (carb * c.grams) / 100;
      t.fat += (fat * c.grams) / 100;
      return t;
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  return {
    scales: { protein: Math.round(solved.x * 100) / 100, carb: Math.round(solved.y * 100) / 100 },
    clamped: solved.clamped,
    components: out,
    perServing: {
      calories: Math.round(totals.calories),
      protein: Math.round(totals.protein * 10) / 10,
      carbs: Math.round(totals.carbs),
      fat: Math.round(totals.fat),
    },
  };
}

// CLI
const arg = process.argv[2];
if (arg) {
  const spec = JSON.parse(arg);
  console.log(JSON.stringify(solveLean(spec), null, 2));
}
