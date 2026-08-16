import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  OBJECTIVES,
  OBJECTIVE_WEIGHTS,
  SCORE_AXES,
  scoreFromBuckets,
  buildAnnotateRequest,
  TEMP_LABELS,
  INTRODUCED_TEMP,
  TIER1_FLOOR,
  REFUSAL_TOKEN_RX,
  refusalHits,
  normalize,
  extractTemps,
  proteinFloorFor,
  screenSourceAvoid,
  validateAnnotation,
  saveEligible,
  annotationToRecipe,
  extractRecipeFromHtml,
  sanitizeAnnotateContext,
  hbpSlug,
} from "../worker/src/lib.js";
import { generatorEligible } from "../app/lib/weekbuilder.js";
import { brigadePool } from "../app/lib/tables.js";
import { recipeConflicts } from "../app/lib/plan.js";

// The /annotate validators are the check.ps1 of P2: with the P1 reader gone,
// these deterministic checks are the only thing standing between a model's
// plausible output and the family's plates. Every §0 sentence gets a witness.

const SRC =
  "Beef Chili. Serves 4. Ingredients: 500 g ground beef, 1 onion, 2 cups black beans, " +
  "chili powder. Method: 1. Brown the beef in a pot. 2. Add onion and garlic and cook " +
  "down. 3. Simmer until thick and season to taste.";

const CTX = {
  objective: "taste",
  transcriptNorm: normalize(SRC),
  extractedNorm: normalize(SRC),
  path: /** @type {"url"} */ ("url"),
  refusalForced: false,
};

/** a fixture that must validate green: the scoring.md worked example (70, annotated) */
const good = () => ({
  mode: "annotated",
  objective: "taste",
  buckets: {
    technique: "isolated",
    precision: "several",
    sequence: "isolated",
    time: "none",
    ingredients: "isolated",
  },
  score: 70,
  riskGroups: false,
  sourceSteps: 3,
  sourceQuote: "Simmer until thick",
  allergensFound: [],
  title: "Beef Chili",
  servings: 4,
  totalTime: 60,
  mealType: "dinner",
  ingredients: [
    { food: "ground beef", grams: 500 },
    { food: "onion", grams: 150, wasOriginal: "1 onion" },
    { food: "black beans", grams: 480, wasOriginal: "2 cups" },
  ],
  steps: [
    {
      n: 1,
      title: "Brown",
      text: "Brown the beef hard, in batches, until crusted.",
      notes: ["crust is flavor: crowding steams instead of searing"],
      temps: [{ label: "done-ground", unit: "C", fromSource: false, value: 0 }],
    },
    { n: 2, title: "Aromatics", text: "Cook the onion down, then the garlic briefly.", notes: [], temps: [] },
    { n: 3, title: "Simmer", text: "Simmer gently, then season at the end.", notes: [], temps: [] },
  ],
  nutrition: { calories: 520, protein: 38, carbs: 40, fat: 20 },
  foodGroups: { beans: 1, spicesHerbs: 1 },
  summary: ["everything in grams", "ground-beef doneness pinned to a real number"],
});

// ---- scoring ---------------------------------------------------------------

test("every objective's weights sum to 100, and fit-the-plan is 20/15/15/20/30", () => {
  for (const o of OBJECTIVES) {
    const sum = SCORE_AXES.reduce((s, a) => s + OBJECTIVE_WEIGHTS[o][a], 0);
    assert.equal(sum, 100, o);
  }
  assert.deepEqual(OBJECTIVE_WEIGHTS["fit-the-plan"], {
    technique: 20,
    precision: 15,
    sequence: 15,
    time: 20,
    ingredients: 30,
  });
});

test("scoreFromBuckets reproduces the scoring.md worked example exactly (70)", () => {
  const b = good().buckets;
  assert.equal(scoreFromBuckets(b, "taste"), 70);
  // determinism: the same buckets always land the same integer
  for (let i = 0; i < 5; i++) assert.equal(scoreFromBuckets(b, "taste"), 70);
  // halves round up (67.5 -> 68): taste, isolated everywhere except time none
  const halves = { technique: "isolated", precision: "isolated", sequence: "isolated", time: "isolated", ingredients: "isolated" };
  assert.equal(scoreFromBuckets(halves, "faster"), Math.floor(100 - 25 + 0.5));
});

test("the good fixture validates green, and the introduced value is SUPPLIED by code (A2)", () => {
  const v = validateAnnotation(good(), CTX);
  assert.equal(v.ok, true, JSON.stringify(/** @type {any} */ (v).errors ?? []));
  const t = /** @type {any} */ (v).result.steps[0].temps[0];
  assert.equal(t.value, 71, "done-ground value comes from the floor table, not the model");
});

test("score arithmetic is recomputed: a claimed score that mismatches rejects", () => {
  const v = validateAnnotation({ ...good(), score: 74 }, CTX);
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("score arithmetic")));
});

test("mode must match the score band", () => {
  const v = validateAnnotation({ ...good(), mode: "clean" }, CTX);
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("band")));
});

test("a sub-40 bucket set must be abandon, and abandon never saves (E1)", () => {
  const buckets = { technique: "pervasive", precision: "pervasive", sequence: "pervasive", time: "pervasive", ingredients: "pervasive" };
  const score = scoreFromBuckets(buckets, "taste");
  assert.ok(score < 40);
  const v = validateAnnotation({ ...good(), mode: "abandon", buckets, score }, CTX);
  assert.equal(v.ok, true, JSON.stringify(/** @type {any} */ (v).errors ?? []));
  assert.equal(saveEligible(/** @type {any} */ (v).result, "url").ok, false);
});

// ---- steps -----------------------------------------------------------------

test("annotated mode preserves step count and 1..N numbering exactly", () => {
  const short = good();
  short.steps = short.steps.slice(0, 2);
  assert.equal(validateAnnotation(short, CTX).ok, false, "count mismatch rejects");

  const renumbered = good();
  renumbered.steps[2].n = 5;
  assert.equal(validateAnnotation(renumbered, CTX).ok, false, "a numbering gap rejects");
});

// ---- temperatures ----------------------------------------------------------

test("a fromSource temperature must be independently re-found in the extracted source (A1)", () => {
  const src2 = SRC + " Roast at 180 °C for an hour.";
  const withOven = good();
  withOven.steps[2].temps = [{ label: "oven", unit: "C", fromSource: true, value: 180 }];
  const okCtx = { ...CTX, transcriptNorm: normalize(src2), extractedNorm: normalize(src2) };
  assert.equal(validateAnnotation(withOven, okCtx).ok, true);

  // transcription has it, the extracted buffer does not: call 1's monopoly is broken
  const monopolyCtx = { ...CTX, transcriptNorm: normalize(src2) };
  const v = validateAnnotation(withOven, monopolyCtx);
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("independently")));
});

test("a process-temp label (oven/hold/fry/fridge/proof) can never be INTRODUCED", () => {
  const bad = good();
  bad.steps[2].temps = [{ label: "oven", unit: "C", fromSource: false, value: 0 }];
  const v = validateAnnotation(bad, CTX);
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("fromSource")));
});

test("tier-1 floors hold even for fromSource figures: 68 C chicken rejects (design run 7)", () => {
  const src2 = SRC + " Cook the chicken thighs to 68 °C.";
  const bad = good();
  bad.steps[1].temps = [{ label: "done-poultry", unit: "C", fromSource: true, value: 68 }];
  const v = validateAnnotation(bad, { ...CTX, transcriptNorm: normalize(src2), extractedNorm: normalize(src2) });
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("tier-1 floor")));
});

test("the protein-term scan forces the floor REGARDLESS of the label (gate2 A2)", () => {
  // ground beef labelled done-intact at 54 C, risk flag set, figure in the
  // source: every model-controlled field colludes, the step text convicts
  const src2 = SRC + " Grill the ground beef patties to 54 °C.";
  const bad = good();
  bad.riskGroups = true;
  bad.steps[0].text = "Grill the ground beef patties until done.";
  bad.steps[0].temps = [{ label: "done-intact", unit: "C", fromSource: true, value: 54 }];
  const v = validateAnnotation(bad, { ...CTX, transcriptNorm: normalize(src2), extractedNorm: normalize(src2) });
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("forcing a 71 C floor")));
});

test("tier-2 under the 71 C line needs the risk-group flag, and never saves in v1 (E1)", () => {
  const src2 = SRC + " Sear the duck breast and pull at 54 °C.";
  const ctx2 = { ...CTX, transcriptNorm: normalize(src2), extractedNorm: normalize(src2) };
  const duck = good();
  // a coherent duck dish: the ingredient-list conviction must not fire on
  // the chili fixture's ground beef
  duck.title = "Seared Duck";
  duck.ingredients = [
    { food: "duck breast", grams: 400 },
    { food: "onion", grams: 150 },
  ];
  duck.steps[0].text = "Score the skin and season.";
  duck.steps[0].temps = [];
  duck.steps[1].text = "Sear the duck breast, rest it, slice.";
  duck.steps[1].temps = [{ label: "done-intact", unit: "C", fromSource: true, value: 54 }];

  const noFlag = validateAnnotation(duck, ctx2);
  assert.equal(noFlag.ok, false, "no risk flag rejects");

  duck.riskGroups = true;
  const flagged = validateAnnotation(duck, ctx2);
  assert.equal(flagged.ok, true, JSON.stringify(/** @type {any} */ (flagged).errors ?? []));
  const save = saveEligible(/** @type {any} */ (flagged).result, "url");
  assert.equal(save.ok, false, "tier-2 renders but does not save");
});

test("the unlabelled sweep: any in-band figure anywhere in the response must be declared (B)", () => {
  const bad = good();
  bad.summary = ["bake it to 90 °C at the end"];
  const v = validateAnnotation(bad, CTX);
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("unlabelled")));
});

// ---- refusal class ---------------------------------------------------------

test("refusalHits fires on canning and on vague-ratio fermentation (design run 4)", () => {
  assert.ok(refusalHits(normalize("Process the jars in a water bath, leaving headspace.")).length > 0);
  assert.ok(
    refusalHits(normalize("Add 2 tablespoons salt per head of cabbage and ferment for 5 days.")).length > 0,
    "all fermentation is in — the vaguer the ratio, the MORE protected",
  );
  assert.equal(refusalHits(normalize(SRC)).length, 0, "a plain chili is not refusal class");
});

test("when the token scan fires, a non-refusal mode rejects; refusal is never scored", () => {
  const forced = validateAnnotation(good(), { ...CTX, refusalForced: true });
  assert.equal(forced.ok, false);

  const refusal = {
    ...good(),
    mode: "refusal",
    refusalReason: "the 2% brine is the pathogen control; it is cited, converted alongside, and not moved",
    buckets: undefined,
    score: 0,
  };
  refusal.steps = refusal.steps.map((s) => ({ ...s, temps: [] }));
  refusal.ingredients = refusal.ingredients.map(({ wasOriginal: _wasOriginal, ...i }) => i);
  const v = validateAnnotation(refusal, { ...CTX, refusalForced: true });
  assert.equal(v.ok, true, JSON.stringify(/** @type {any} */ (v).errors ?? []));
  assert.equal(/** @type {any} */ (v).result.score, null);
  assert.equal(saveEligible(/** @type {any} */ (v).result, "url").ok, false, "refusal never saves");

  const scored = { ...refusal, score: 70 };
  assert.equal(validateAnnotation(scored, { ...CTX, refusalForced: true }).ok, false);

  const corrected = { ...refusal, ingredients: good().ingredients };
  assert.equal(
    validateAnnotation(corrected, { ...CTX, refusalForced: true }).ok,
    false,
    "refusal corrects nothing: wasOriginal marks reject",
  );
});

// ---- quote + shape ---------------------------------------------------------

test("sourceQuote must be contained in the extracted buffer (URL path)", () => {
  const v = validateAnnotation({ ...good(), sourceQuote: "a sentence the page never wrote" }, CTX);
  assert.equal(v.ok, false);
  // photo path is exempt: the transcription IS the source
  const p = validateAnnotation(
    { ...good(), sourceQuote: "a sentence the page never wrote" },
    { ...CTX, path: "photo", extractedNorm: "" },
  );
  assert.equal(p.ok, true, JSON.stringify(/** @type {any} */ (p).errors ?? []));
});

test("no mealType rejects (D3: unset mealType is brigade-eligible for every slot)", () => {
  const v = validateAnnotation({ ...good(), mealType: undefined }, CTX);
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("mealType")));
});

test("the photo path never saves in v1 (A1: no machine-readable ground truth)", () => {
  const v = validateAnnotation(good(), { ...CTX, path: "photo", extractedNorm: "" });
  assert.equal(v.ok, true);
  assert.equal(saveEligible(/** @type {any} */ (v).result, "photo").ok, false);
});

// ---- the save transform (D2) ----------------------------------------------

test("annotationToRecipe writes the canonical on-disk shape", () => {
  const withAllergen = { ...good(), allergensFound: ["wheat"] };
  const v = validateAnnotation(withAllergen, CTX);
  assert.equal(v.ok, true);
  const recipe = annotationToRecipe(/** @type {any} */ (v).result, {
    id: "hbp-beef-chili-2026-08-16",
    sourceUrl: "https://example.com/chili",
    transcription: SRC,
    pantryStaples: ["Chili Powder", "rice"],
  });
  // the generator + shopping.js contract: {qty, unit, food}, {step, text}
  assert.deepEqual(recipe.ingredients[0], { qty: 500, unit: "g", food: "ground beef" });
  assert.equal(recipe.instructions[0].step, 1);
  assert.ok(typeof recipe.instructions[0].text === "string" && recipe.instructions[0].text.length > 0);
  assert.equal(recipe.mealType, "dinner");
  assert.deepEqual(recipe.tags, ["hbp-annotated", "contains:wheat"]);
  assert.equal(recipe.nutrition.method, "estimated");
  assert.equal(recipe.foodGroups.method, "estimated");
  assert.equal(recipe.hbp.transcription, SRC, "the transcription persists ON SAVE only (A3)");
  assert.equal(recipe.hbp.score, 70);
  // a pantry staple is marked; the correction survives in the hbp block
  assert.equal(recipe.ingredients.find((i) => i.food === "black beans")?.staple, undefined);
  assert.ok(recipe.hbp.ingredientMarks.some((m) => m.wasOriginal === "2 cups"));
});

// ---- normalize + extraction (the Tribunal-P1 mechanical lessons) -----------

test("normalize first, scan second: markup and entities cannot hide a figure", () => {
  const evil = 'cook to <span class="num-hl">74</span>&nbsp;&deg;C then hold';
  const temps = extractTemps(normalize(evil));
  assert.deepEqual(temps, [{ value: 74, unit: "C" }]);
  assert.deepEqual(extractTemps(normalize("simmer at 71,5 °C")), [{ value: 71.5, unit: "C" }]);
  assert.deepEqual(extractTemps(normalize("bake at 165 degrees F")), [{ value: 165, unit: "F" }]);
  assert.deepEqual(extractTemps(normalize("bring to 90 celsius")), [{ value: 90, unit: "C" }]);
});

test("proteinFloorFor: chicken forces 74, ground/egg force 71, duck is deliberately free", () => {
  assert.deepEqual(proteinFloorFor("roast the chicken thighs"), { C: 74, F: 165 });
  assert.deepEqual(proteinFloorFor("form the ground lamb into kofta"), { C: 71, F: 160 });
  assert.deepEqual(proteinFloorFor("whisk two eggs into the custard"), { C: 71, F: 160 });
  assert.equal(proteinFloorFor("sear the duck breast"), null, "54 C duck is the blessed tier-2 case");
  assert.equal(proteinFloorFor("roast the eggplant"), null, "eggplant is not egg");
});

// ---- URL extraction --------------------------------------------------------

test("extractRecipeFromHtml prefers JSON-LD Recipe, including @graph nesting", () => {
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", name: "Blog" },
      {
        "@type": "Recipe",
        name: "Lentil Soup",
        recipeYield: "4 servings",
        recipeIngredient: ["200 g red lentils", "1 onion"],
        recipeInstructions: [
          { "@type": "HowToStep", text: "Sweat the onion." },
          { "@type": "HowToStep", text: "Add lentils and simmer 25 minutes." },
        ],
      },
    ],
  };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><p>life story</p></body></html>`;
  const out = extractRecipeFromHtml(html);
  assert.ok(out.includes("Lentil Soup"));
  assert.ok(out.includes("200 g red lentils"));
  assert.ok(out.includes("2. Add lentils"));
  assert.ok(!out.includes("life story"), "JSON-LD wins over page prose");

  const plain = extractRecipeFromHtml("<html><body><h1>Soup</h1><p>Boil it.</p></body></html>");
  assert.ok(plain.includes("Soup") && plain.includes("Boil it."));
});

// ---- misc boundaries -------------------------------------------------------

test("screenSourceAvoid names the diner and the hit", () => {
  const hits = screenSourceAvoid(normalize("toss with peanut oil"), [
    { id: "m", name: "Mom", avoid: ["peanut"] },
    { id: "l", name: "Laurie", avoid: [] },
  ]);
  assert.deepEqual(hits, ["Mom: peanut"]);
});

test("sanitizeAnnotateContext bounds everything; hbpSlug is repo-safe", () => {
  const c = sanitizeAnnotateContext({ plan: ["a".repeat(200)], pantry: [1, "rice"], macros: "x".repeat(300) });
  assert.equal(c.plan[0].length, 60);
  assert.deepEqual(c.pantry, ["rice"]);
  assert.equal(c.macros.length, 120);
  assert.equal(hbpSlug("Grandma's Chili!! (v2)"), "grandma-s-chili-v2");
});

// ---- Tribunal final-gate fixes (loop 1) ------------------------------------

test("a doneness figure BELOW the band still hits the safety line (RT B1 + R5)", () => {
  // 10 C done-fish sat under the old 40-99 C band gate and passed clean;
  // since loop 2 it rejects OUTRIGHT, risk flag or not, because no
  // legitimate doneness lives below 49 C (that is storage, not cooking)
  const src2 = SRC + " Chill the salmon at 10 C overnight.";
  const ctx2 = { ...CTX, transcriptNorm: normalize(src2), extractedNorm: normalize(src2) };
  const cold = good();
  cold.title = "Cured-style Salmon";
  cold.ingredients = [
    { food: "salmon", grams: 400 },
    { food: "dill", grams: 10 },
  ];
  cold.steps[0].text = "Pat the salmon dry.";
  cold.steps[0].temps = [];
  cold.steps[1].text = "Chill the salmon and slice it thin.";
  cold.steps[1].temps = [{ label: "done-fish", unit: "C", fromSource: true, value: 10 }];
  const noFlag = validateAnnotation(cold, ctx2);
  assert.equal(noFlag.ok, false, "10 C done-fish without the risk flag must reject");

  cold.riskGroups = true;
  const flagged = validateAnnotation(cold, ctx2);
  assert.equal(flagged.ok, false, "the risk flag does not launder a storage temperature");

  // a REAL tier-2 figure (50 C salmon) still works exactly as designed
  const src3 = SRC + " Pull the salmon at 50 C.";
  const ctx3 = { ...CTX, transcriptNorm: normalize(src3), extractedNorm: normalize(src3) };
  cold.steps[1].temps = [{ label: "done-fish", unit: "C", fromSource: true, value: 50 }];
  const real = validateAnnotation(cold, ctx3);
  assert.equal(real.ok, true, JSON.stringify(/** @type {any} */ (real).errors ?? []));
  assert.equal(
    saveEligible(/** @type {any} */ (real).result, "url").ok,
    false,
    "renders with the risk line, never saves",
  );
});

test("the Fahrenheit twin of a sub-line figure is caught too (RT B1)", () => {
  const src2 = SRC + " Pull the pork at 52 F.";
  const bad = good();
  bad.steps[1].temps = [{ label: "done-intact", unit: "F", fromSource: true, value: 52 }];
  const v = validateAnnotation(bad, {
    ...CTX,
    transcriptNorm: normalize(src2),
    extractedNorm: normalize(src2),
  });
  assert.equal(v.ok, false);
});

test("extractTemps reads ranges and lowercase units (RT B2 / ENG F4)", () => {
  assert.deepEqual(extractTemps(normalize("sear to 140-160 F")), [
    { value: 140, unit: "F" },
    { value: 160, unit: "F" },
  ]);
  assert.deepEqual(extractTemps(normalize("50 to 54 c")), [
    { value: 50, unit: "C" },
    { value: 54, unit: "C" },
  ]);
  assert.deepEqual(extractTemps(normalize("90 c")), [{ value: 90, unit: "C" }]);
});

test("the LOW end of a range in prose must be declared or the sweep rejects (RT B2)", () => {
  const src2 = SRC + " Sear the patties to 140-160 F.";
  const ctx2 = { ...CTX, transcriptNorm: normalize(src2), extractedNorm: normalize(src2) };
  const ranged = good();
  ranged.steps[0].text = "Sear the patties to 140-160 F, flipping once.";
  ranged.steps[0].temps = [{ label: "done-ground", unit: "F", fromSource: true, value: 160 }];
  const v = validateAnnotation(ranged, ctx2);
  assert.equal(v.ok, false, "140 F must not slip through undeclared");
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("140")));
});

test("a sub-40 C prose figure is inside the widened band and must be declared (RT B3)", () => {
  const low = good();
  low.steps[1].text = "Roast the pork until the centre reads 100 F, then rest.";
  const v = validateAnnotation(low, CTX);
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("unlabelled")));
});

test("the ingredient list convicts a paraphrased step (ENG F2)", () => {
  // meatballs: ingredients say ground beef, the step never does, the label
  // says intact and the risk flag is set; every model field colludes
  const src2 =
    "Meatballs. Serves 4. Ingredients: 500 g ground beef, breadcrumbs. " +
    "Method: 1. Roll them. 2. Finish in the sauce at 55 C. 3. Serve.";
  const ctx2 = { ...CTX, transcriptNorm: normalize(src2), extractedNorm: normalize(src2) };
  const sly = good();
  sly.riskGroups = true;
  sly.title = "Meatballs";
  sly.sourceQuote = "Finish in the sauce";
  sly.ingredients = [
    { food: "ground beef", grams: 500 },
    { food: "breadcrumbs", grams: 60 },
  ];
  sly.steps = [
    { n: 1, title: "Roll", text: "Roll them evenly.", notes: [], temps: [] },
    {
      n: 2,
      title: "Finish",
      text: "Finish them in the sauce until just done.",
      notes: [],
      temps: [{ label: "done-intact", unit: "C", fromSource: true, value: 55 }],
    },
    { n: 3, title: "Serve", text: "Serve over pasta.", notes: [], temps: [] },
  ];
  const v = validateAnnotation(sly, ctx2);
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("floor")));
});

test("a legitimate hot-hold is NOT measured against the doneness line (Realist 4)", () => {
  const src2 = SRC + " Keep the pot warm at 60 C until serving.";
  const ctx2 = { ...CTX, transcriptNorm: normalize(src2), extractedNorm: normalize(src2) };
  const held = good();
  held.steps[2].temps = [{ label: "hold", unit: "C", fromSource: true, value: 60 }];
  const v = validateAnnotation(held, ctx2);
  assert.equal(v.ok, true, JSON.stringify(/** @type {any} */ (v).errors ?? []));
});

test("proteinFloorFor catches hamburger, patties, chorizo and quail (RT M2)", () => {
  assert.deepEqual(proteinFloorFor("shape the hamburgers"), { C: 71, F: 160 });
  assert.deepEqual(proteinFloorFor("flip the patties once"), { C: 71, F: 160 });
  assert.deepEqual(proteinFloorFor("crumble the chorizo in"), { C: 71, F: 160 });
  assert.deepEqual(proteinFloorFor("roast the quail whole"), { C: 74, F: 165 });
});

test("cuisine rides the unlabelled sweep (RT M3)", () => {
  const sneaky = { ...good(), cuisine: "duck at 52 C" };
  const v = validateAnnotation(sneaky, CTX);
  assert.equal(v.ok, false);
});

test("the call-2 prompt carries the weight row and penalty table (Realist 1)", () => {
  const req = buildAnnotateRequest({
    source: "recipe text",
    objective: "fit-the-plan",
    diners: [],
    context: { plan: [], pantry: [], macros: "" },
    refusalForced: false,
    model: "m",
  });
  const text = req.messages[0].content[0].text;
  assert.ok(text.includes("technique 20"), "resolved weights travel in the prompt");
  assert.ok(text.includes("pervasive 0.75"));
  assert.ok(text.includes("85+ clean"));
  // and the retry is informed
  const retry = buildAnnotateRequest({
    source: "recipe text",
    objective: "taste",
    diners: [],
    context: { plan: [], pantry: [], macros: "" },
    refusalForced: false,
    priorErrors: ["score arithmetic: buckets compute 70, the model claimed 62"],
    model: "m",
  });
  assert.ok(retry.messages[0].content[0].text.includes("buckets compute 70"));
});

test("saved instructions KEEP the temps and margin notes (Realist 5)", () => {
  const v = validateAnnotation(good(), CTX);
  assert.equal(v.ok, true);
  const recipe = annotationToRecipe(/** @type {any} */ (v).result, {
    id: "hbp-beef-chili-2026-08-16",
    sourceUrl: "https://example.com/chili",
    transcription: SRC,
    pantryStaples: [],
  });
  assert.ok(
    recipe.instructions[0].text.includes("71 \u00b0C (ground meat done temp)"),
    "the supplied doneness figure survives into the text every view renders",
  );
  assert.ok(recipe.instructions[0].text.includes("crust is flavor"), "margin notes survive too");
});

test("the saved recipe holds up in the real consumers (ENG F8b)", () => {
  const v = validateAnnotation(good(), CTX);
  const recipe = annotationToRecipe(/** @type {any} */ (v).result, {
    id: "hbp-beef-chili-2026-08-16",
    sourceUrl: "https://example.com/chili",
    transcription: SRC,
    pantryStaples: [],
  });
  // fenced from both auto-planners until promoted, choosable once promoted
  assert.deepEqual(generatorEligible([recipe]), []);
  assert.equal(generatorEligible([{ ...recipe, promoted: true }]).length, 1);
  const bank = new Map([[recipe.id, recipe]]);
  assert.deepEqual(brigadePool(bank, [{ id: "mom" }], "dinner"), []);
  // screenable by the shared diet/avoid predicate
  assert.ok(recipeConflicts(recipe, "omnivore", ["ground beef"]).length > 0);
  assert.equal(recipeConflicts(recipe, "omnivore", ["shrimp"]).length, 0);
});

test("refusal tokens: raw kidney beans and seed sprouting fire; brussels sprouts do not", () => {
  assert.ok(refusalHits(normalize("soak the dried kidney beans, then slow-cook on low")).length > 0);
  assert.ok(refusalHits(normalize("sprout the mung beans for three days in a jar")).length > 0);
  assert.equal(refusalHits(normalize("roast the brussels sprouts until crisp")).length, 0);
});

test("sanitizeAnnotateContext caps LIST LENGTHS, not just string lengths", () => {
  const c = sanitizeAnnotateContext({
    plan: Array.from({ length: 40 }, (_, i) => `meal-${i}`),
    pantry: Array.from({ length: 80 }, (_, i) => `staple-${i}`),
    macros: "x",
  });
  assert.equal(c.plan.length, 25);
  assert.equal(c.pantry.length, 60);
});

test("extractRecipeFromHtml splits a single-blob method and keeps name-only steps", () => {
  const blob =
    "Preheat the oven to a moderate heat and butter the pan generously. " +
    "Whisk the eggs with the sugar until pale and doubled in volume. " +
    "Fold in the flour gently so the batter keeps its air. " +
    "Bake until the centre springs back when pressed lightly. " +
    "Cool in the pan for ten minutes before turning out onto a rack.";
  const ld = {
    "@type": "Recipe",
    name: "Sponge",
    recipeIngredient: ["4 eggs", "120 g sugar", "120 g flour"],
    recipeInstructions: [blob, { "@type": "HowToStep", name: "Serve with cream." }],
  };
  const html = `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
  const out = extractRecipeFromHtml(html);
  assert.ok(out.includes("2. Whisk the eggs"), "the blob split into real steps");
  assert.ok(out.includes("Serve with cream."), "a name-only step is kept");
});

// ---- Tribunal final-gate fixes (loop 2) ------------------------------------

test("process labels carry physical lines: a 50 C hold and a 45 C fridge reject (R1)", () => {
  const src2 = SRC + " Keep it in the warming drawer at 50 C. Refrigerate at 45 C.";
  const ctx2 = { ...CTX, transcriptNorm: normalize(src2), extractedNorm: normalize(src2) };

  const danger = good();
  danger.steps[2].temps = [{ label: "hold", unit: "C", fromSource: true, value: 50 }];
  const v1 = validateAnnotation(danger, ctx2);
  assert.equal(v1.ok, false, "50 C is the danger zone, not a hold");
  assert.ok(/** @type {any} */ (v1).errors.some((e) => e.includes("hot-holding")));

  const warm = good();
  warm.steps[2].temps = [{ label: "fridge", unit: "C", fromSource: true, value: 45 }];
  const v2 = validateAnnotation(warm, ctx2);
  assert.equal(v2.ok, false, "45 C is not refrigeration");

  const fine = good();
  fine.steps[2].temps = [{ label: "hold", unit: "C", fromSource: true, value: 60 }];
  const src3 = SRC + " Keep the pot warm at 60 C.";
  const v3 = validateAnnotation(fine, {
    ...CTX,
    transcriptNorm: normalize(src3),
    extractedNorm: normalize(src3),
  });
  assert.equal(v3.ok, true, "a real 60 C hot-hold still passes");
});

test("a sub-57 C hold cannot launder an undercook past the process floor (R2)", () => {
  const src2 =
    "Sloppy Joes. Serves 4. Ingredients: 500 g ground beef, buns. " +
    "Method: 1. Cook the mixture through. 2. Keep it in the pan at 50 C until the buns are ready. 3. Serve.";
  const ctx2 = { ...CTX, transcriptNorm: normalize(src2), extractedNorm: normalize(src2) };
  const sly = good();
  sly.title = "Sloppy Joes";
  sly.sourceQuote = "Keep it in the pan";
  sly.ingredients = [
    { food: "ground beef", grams: 500 },
    { food: "buns", grams: 200 },
  ];
  sly.steps = [
    { n: 1, title: "Cook", text: "Cook the mixture through.", notes: [], temps: [] },
    {
      n: 2,
      title: "Hold",
      text: "Keep it in the pan until the buns are ready.",
      notes: [],
      temps: [{ label: "hold", unit: "C", fromSource: true, value: 50 }],
    },
    { n: 3, title: "Serve", text: "Serve on the buns.", notes: [], temps: [] },
  ];
  const v = validateAnnotation(sly, ctx2);
  assert.equal(v.ok, false, "50 C is the danger zone whatever the label says");
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("hot-holding")));
});

test("a spelled-out figure cannot ride a unit token past the sweep (R3)", () => {
  const spelled = good();
  spelled.steps[0].notes = ["pull them at one hundred forty degrees F for a juicier crumb"];
  const v = validateAnnotation(spelled, CTX);
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("no readable figure")));
});

test("extractTemps reads every common range spelling (R4)", () => {
  // superset assertion: the bare-degree pass may add a harmless out-of-band
  // extra reading of the low end; both F readings must be present
  const degRange = extractTemps(normalize("140\u00b0-160\u00b0F"));
  assert.ok(degRange.some((t) => t.value === 140 && t.unit === "F"));
  assert.ok(degRange.some((t) => t.value === 160 && t.unit === "F"));
  assert.deepEqual(extractTemps(normalize("between 140 and 160 F")), [
    { value: 140, unit: "F" },
    { value: 160, unit: "F" },
  ]);
  assert.deepEqual(extractTemps(normalize("140/160 F")), [
    { value: 140, unit: "F" },
    { value: 160, unit: "F" },
  ]);
  // and no false low end on an unrelated "and"
  assert.deepEqual(extractTemps(normalize("bake at 180 C and rest 5 minutes")), [
    { value: 180, unit: "C" },
  ]);
});

test("a room label gives ambient figures a legal declaration (R8)", () => {
  const src2 = SRC + " Rest the dough at 22 C before shaping.";
  const ctx2 = { ...CTX, transcriptNorm: normalize(src2), extractedNorm: normalize(src2) };
  const ambient = good();
  ambient.steps[1].text = "Rest the dough at room temperature before shaping.";
  ambient.steps[1].temps = [{ label: "room", unit: "C", fromSource: true, value: 22 }];
  const v = validateAnnotation(ambient, ctx2);
  assert.equal(v.ok, true, JSON.stringify(/** @type {any} */ (v).errors ?? []));
});

test("saved instruction text uses the cook-facing label names (ENG F5 note)", () => {
  const v = validateAnnotation(good(), CTX);
  const recipe = annotationToRecipe(/** @type {any} */ (v).result, {
    id: "hbp-x",
    sourceUrl: "https://example.com",
    transcription: SRC,
    pantryStaples: [],
  });
  assert.ok(
    recipe.instructions[0].text.includes("(ground meat done temp)"),
    "the enum code stays out of the kitchen",
  );
});

// ---- Tribunal final-gate fixes (loop 3) ------------------------------------

test("unit-less 'degrees' prose is read in BOTH units and must be declared (C1)", () => {
  // "pull the chicken at 140 degrees" means 140 F to a US cook (60 C
  // poultry); with no unit letter it used to be invisible to every net and
  // SAVED. The F reading of 140 sits in the band and now convicts it.
  const sneaky = good();
  sneaky.steps[2].text = "Pull the chicken the moment the thickest part reads 140 degrees, then rest.";
  const v = validateAnnotation(sneaky, CTX);
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("140")));
  // and the low spelled figure too: "63 degrees" convicts via its C reading
  const low = good();
  low.steps[2].text = "Bake until the centre reads 63 degrees.";
  const v2 = validateAnnotation(low, CTX);
  assert.equal(v2.ok, false);
});

test("a legal range cannot PAY for a smuggled figure-less unit (C2)", () => {
  // the old check compared counts: one range = two figures for one unit
  // token, and that surplus bought a spelled-out figure elsewhere
  const src2 = SRC + " Hold the pan between 57 and 60 \u00b0C while the rest finishes.";
  const ctx2 = { ...CTX, transcriptNorm: normalize(src2), extractedNorm: normalize(src2) };
  const payer = good();
  payer.riskGroups = false;
  payer.steps[1].text = "Hold the pan between 57 and 60 \u00b0C while the rest finishes.";
  payer.steps[1].temps = [
    { label: "hold", unit: "C", fromSource: true, value: 57 },
    { label: "hold", unit: "C", fromSource: true, value: 60 },
  ];
  payer.steps[2].notes = ["pull the fillet at one hundred forty \u00b0F, then rest"];
  const v = validateAnnotation(payer, ctx2);
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((e) => e.includes("no readable figure")));
  // control: without the smuggled note the same declared range is fine
  payer.steps[2].notes = [];
  const clean = validateAnnotation(payer, ctx2);
  assert.equal(clean.ok, true, JSON.stringify(/** @type {any} */ (clean).errors ?? []));
});

// ---- parity with the P1 skill (one home per side, gate F2) -----------------

const SKILL = join(homedir(), ".claude", "skills", "half-blood-prince");

test(
  "weights parity with the skill's scoring.md, cell by cell",
  { skip: !existsSync(join(SKILL, "references", "scoring.md")) },
  () => {
    // parse the axis rows of the objective weight matrix and compare every
    // CELL, not just substring presence (a transposed table must fail)
    const md = readFileSync(join(SKILL, "references", "scoring.md"), "utf8");
    const order = ["taste", "same-time", "faster", "simpler", "fit-the-plan"];
    const axisRow = (/** @type {string} */ name) => {
      const m = new RegExp(`\\|\\s*${name}\\s*\\|([^\\n]+)`, "i").exec(md);
      assert.ok(m, `no ${name} row in scoring.md`);
      return m[1]
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)
        .map(Number);
    };
    /** @type {Record<string, number[]>} */
    const byAxis = {
      technique: axisRow("Technique"),
      precision: axisRow("Precision"),
      sequence: axisRow("Sequence"),
      time: axisRow("Time"),
      ingredients: axisRow("Ingredients"),
    };
    for (const a of SCORE_AXES) {
      assert.deepEqual(
        byAxis[a],
        order.map((o) => OBJECTIVE_WEIGHTS[o][a]),
        `${a} row drifted between scoring.md and lib.js`,
      );
    }
  },
);

test(
  "refusal tokens, labels and floors parity with the skill's check.ps1",
  { skip: !existsSync(join(SKILL, "scripts", "check.ps1")) },
  () => {
    const ps = readFileSync(join(SKILL, "scripts", "check.ps1"), "utf8");
    for (const rx of REFUSAL_TOKEN_RX) {
      assert.ok(ps.includes(rx.replace(/\\\\/g, "\\")), `token '${rx}' not mirrored in check.ps1`);
    }
    for (const label of Object.keys(TIER1_FLOOR)) {
      assert.ok(ps.includes(label), `label '${label}' not in check.ps1`);
    }
    assert.ok(ps.includes("floor 74") && ps.includes("floor 71"), "tier floors drifted");
    // P2's enum is check.ps1's list minus `other` (dropped by gate fix A2)
    for (const label of TEMP_LABELS) {
      assert.ok(ps.includes(`'${label}'`), `label '${label}' unknown to check.ps1`);
    }
    assert.ok(!TEMP_LABELS.includes("other"), "'other' stays dropped (A2)");
    void INTRODUCED_TEMP;
  },
);
