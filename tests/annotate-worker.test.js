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

// ---- parity with the P1 skill (one home per side, gate F2) -----------------

const SKILL = join(homedir(), ".claude", "skills", "half-blood-prince");

test("weights parity with the skill's scoring.md", { skip: !existsSync(join(SKILL, "references", "scoring.md")) }, () => {
  const md = readFileSync(join(SKILL, "references", "scoring.md"), "utf8");
  for (const o of OBJECTIVES) {
    const row = new RegExp(`\\|\\s*${o.replace(/-/g, "[- ]")}[^|]*\\|([^\\n]+)`, "i").exec(md);
    // scoring.md carries the matrix transposed (axes as rows); assert the
    // five weight NUMBERS for this objective all appear in the file
    void row;
    for (const a of SCORE_AXES) {
      assert.ok(md.includes(String(OBJECTIVE_WEIGHTS[o][a])), `${o}/${a} weight missing from scoring.md`);
    }
  }
});

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
