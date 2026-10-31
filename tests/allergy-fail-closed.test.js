// Mise 1.96, the shrike audit (10/25), section 4 items 3, 4, 5 and 8: the
// allergy screen FAILS CLOSED. When the code is unsure, the dish is not safe
// for that seat; "unknown" is never "safe". Made-up people only: Avery avoids
// peanuts, Blake avoids nothing.
import test from "node:test";
import assert from "node:assert/strict";
import {
  labelChecks,
  mergeRecipePool,
  plateRows,
  recipeConflicts,
  softAvoidMatches,
} from "../app/lib/plan.js";
import {
  avoidTermsFromAllergens,
  targetsFromQuestionnaire,
  typedAvoidTerms,
} from "../app/lib/targets.js";
import { withCurrentAllergenTerms } from "../app/lib/store.js";
import { plateRefusal, ruleRecipeCheck } from "../app/lib/tables.js";
import { bowlTailor } from "../app/lib/tailor.js";
import { buildServe } from "../app/lib/serve.js";

const PEANUT = avoidTermsFromAllergens(["peanuts"], "");
const dish = (/** @type {string} */ id, /** @type {string[]} */ foods) => ({
  id,
  ingredients: foods.map((food) => ({ food, qty: 1, unit: "tbsp" })),
});
const pb = dish("pb-toast", ["whole wheat bread", "peanut butter"]);

// a rotating smoothie shaped like the bank's berry-greens one: no peanut in
// `ingredients`, peanut butter in the rotation pool only
const SMOOTHIE = {
  id: "test-rotating-smoothie",
  name: "Test Rotating Smoothie",
  mealType: "smoothie",
  servings: 1,
  nutrition: { calories: 400, protein: 35 },
  ingredients: [
    { food: "whey protein powder", qty: 30, unit: "g" },
    { food: "soy milk", qty: 1, unit: "cup" },
  ],
  rotation: {
    perDay: 2,
    keep: [
      { food: "whey protein powder", qty: 30, unit: "g", calories: 120, protein: 24 },
      { food: "soy milk", qty: 1, unit: "cup", calories: 80, protein: 7 },
    ],
    pool: [
      { food: "banana", qty: 0.5, unit: "each", calories: 50, protein: 1 },
      { food: "kale", qty: 1, unit: "cup", calories: 10, protein: 1 },
      { food: "peanut butter", qty: 1, unit: "tbsp", calories: 95, protein: 4 },
    ],
  },
};
const WEEK = [
  "2026-11-01",
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
  "2026-11-07",
];

// ---- item 3: rotation keep and pool are screened ---------------------------

test("item 3: a peanut in the rotation POOL refuses the recipe for a peanut seat (the smoothie repro)", () => {
  assert.ok(plateRows(SMOOTHIE).some((r) => r.food === "peanut butter"));
  assert.deepEqual(recipeConflicts(SMOOTHIE, undefined, PEANUT), ["contains peanut"]);
  assert.deepEqual(recipeConflicts(SMOOTHIE, undefined, []), [], "Blake still gets it");
  const avery = { avoidIngredients: PEANUT };
  assert.ok(plateRefusal(SMOOTHIE, avery).length > 0, "the plate screen let it through");
  const rule = ruleRecipeCheck(SMOOTHIE, [
    { id: "avery", name: "Avery", targets: avery },
    { id: "blake", name: "Blake", targets: { avoidIngredients: [] } },
  ]);
  assert.deepEqual(rule.blocked, ["Avery: peanut"], "the kitchen rule check saw nothing");
  const pool = mergeRecipePool([SMOOTHIE], [], "maintain", PEANUT);
  assert.equal(pool.length, 0, "the smoothie is still in Avery's planner pool");
});

test("item 3: a peanut in the rotation KEEP refuses too, and a clean rotation still passes", () => {
  const keepHit = {
    ...SMOOTHIE,
    rotation: {
      ...SMOOTHIE.rotation,
      keep: [{ food: "PB2 powder", qty: 2, unit: "tbsp" }],
      pool: [],
    },
  };
  assert.ok(recipeConflicts(keepHit, undefined, PEANUT).length > 0);
  const clean = {
    ...SMOOTHIE,
    rotation: { ...SMOOTHIE.rotation, pool: SMOOTHIE.rotation.pool.slice(0, 2) },
  };
  assert.deepEqual(recipeConflicts(clean, undefined, PEANUT), []);
});

test("item 3: on no day of the week does a peanut seat's plate print peanut butter", () => {
  const seats = [
    { id: "avery", servings: 1 },
    { id: "blake", servings: 1 },
  ];
  let blakeSawIt = false;
  for (const d of WEEK) {
    const out = bowlTailor(SMOOTHIE, seats, d, { avery: PEANUT, blake: [] });
    // a day that rotates it in is refused outright, never plated
    assert.ok(
      !/your own:.*peanut/i.test(out.seats.avery.plate.join(" ")),
      `${d}: ${out.seats.avery.plate}`,
    );
    if (/peanut butter/.test(out.seats.blake.plate[0])) {
      blakeSawIt = true;
      assert.equal(out.seats.avery.plate[0], "not for you: contains peanut. Do not make this one.");
    }
  }
  assert.ok(blakeSawIt, "the fixture never rotated peanut butter in, so this test proved nothing");
});

// ---- item 4: typed phrases --------------------------------------------------

test("item 4: every natural way of typing a peanut allergy refuses peanut butter", () => {
  for (const typed of [
    "peanut",
    "peanuts",
    "Peanuts",
    "peanut allergy",
    "Peanut Allergy",
    "allergic to peanuts",
    "allergic to peanut",
    "no peanuts",
    "no peanut",
    "peanut-free",
    "peanut free",
    "Peanuts (severe)",
    "peanuts.",
    "severe peanut allergy!",
    "I'm allergic to peanuts",
    "groundnuts",
    "nut allergy",
    "no nuts please",
  ]) {
    const terms = avoidTermsFromAllergens([], typed);
    assert.ok(
      recipeConflicts(pb, undefined, terms).length > 0,
      `"${typed}" let peanut butter through`,
    );
  }
});

test("item 4: gluten, dairy, shellfish and egg phrases bring their families", () => {
  const cases = [
    ["gluten allergy", "japanese curry roux"],
    ["gluten-free", "orzo"],
    ["celiac disease", "panko"],
    ["wheat allergy (celiac)", "couscous"],
    ["dairy free", "cheddar"],
    ["dairy-free", "whey protein powder"],
    ["non-dairy", "greek yogurt"],
    ["lactose intolerant", "butter"],
    ["shellfish allergy", "shrimp"],
    ["can't eat eggs", "mayonnaise"],
    ["allergic to peanuts and shellfish", "prawns"],
  ];
  for (const [typed, food] of cases) {
    const terms = avoidTermsFromAllergens([], typed);
    assert.ok(
      recipeConflicts(dish("d", [food]), undefined, terms).length > 0,
      `"${typed}" let ${food} through`,
    );
  }
});

test("item 4: nothing typed is dropped; an unknown phrase stays a literal substring term", () => {
  for (const typed of [
    "peanut allergy",
    "mushroom and okra",
    "the green stuff",
    "allergy",
    "no mushrooms",
  ]) {
    assert.ok(typedAvoidTerms(typed).includes(typed), `"${typed}" was dropped`);
  }
  // the literal still screens by substring, and the food inside it does too
  assert.ok(
    recipeConflicts(dish("x", ["the green stuff"]), undefined, typedAvoidTerms("the green stuff"))
      .length > 0,
  );
  assert.ok(
    recipeConflicts(dish("m", ["cremini mushrooms"]), undefined, typedAvoidTerms("no mushrooms"))
      .length > 0,
  );
  // only wrapper words is no food: kept as typed, never widened into nothing
  assert.deepEqual(typedAvoidTerms("allergy"), ["allergy"]);
  assert.deepEqual(typedAvoidTerms(" Cilantro "), ["cilantro"], "a bare word stays itself");
});

test("item 4: a guest's questionnaire and an old stored phrase both screen", () => {
  const guest = targetsFromQuestionnaire(
    { sex: "f", age: 30, heightFt: 5, heightIn: 6, weightLb: 140, activity: 2, goal: "maintain" },
    "2026-10-25",
    { allergens: [], allergensFreeText: "gluten allergy, peanut allergy" },
  );
  assert.ok(plateRefusal(dish("curry", ["japanese curry roux"]), guest).length > 0);
  assert.ok(plateRefusal(pb, guest).length > 0);
  // a profile saved before this parser existed is widened on read
  const old = withCurrentAllergenTerms({ avoidIngredients: ["peanut allergy"] });
  assert.equal(old.avoidIngredients[0], "peanut allergy", "the stored phrase stays first");
  assert.ok(recipeConflicts(pb, undefined, old.avoidIngredients).length > 0);
});

// ---- item 5: optional allergen rows on the allergic seat's plate ------------

const PRE_BED = {
  id: "test-pre-bed-bowl",
  servings: 1,
  nutrition: { calories: 330, protein: 32 },
  ingredients: [
    { food: "cottage cheese", qty: 1, unit: "cup" },
    { food: "blueberries", qty: 0.5, unit: "cup" },
    { food: "peanut butter", qty: 1, unit: "tbsp", optional: true },
  ],
};

test("item 5: an optional peanut row is left off the peanut seat's plate and named, kept for the others", () => {
  assert.deepEqual(
    recipeConflicts(PRE_BED, undefined, PEANUT),
    [],
    "optional rows still do not unseat",
  );
  const out = bowlTailor(
    PRE_BED,
    [
      { id: "avery", servings: 1 },
      { id: "blake", servings: 1 },
    ],
    "2026-10-26",
    { avery: PEANUT, blake: [] },
  );
  assert.ok(!/peanut/.test(out.seats.avery.plate[0]), out.seats.avery.plate[0]);
  assert.deepEqual(out.seats.avery.plate.slice(1), ["left off for you: peanut butter"]);
  assert.match(out.seats.blake.plate[0], /1 tbsp peanut butter/);
});

test("item 5: a left-off rotation row comes off the seat's macros; an unread allergy list gets no plate", () => {
  const optionalPool = {
    ...SMOOTHIE,
    rotation: {
      ...SMOOTHIE.rotation,
      perDay: 3,
      pool: SMOOTHIE.rotation.pool.map((c) =>
        c.food === "peanut butter" ? { ...c, optional: true } : c,
      ),
    },
  };
  const out = bowlTailor(
    optionalPool,
    [
      { id: "avery", servings: 1 },
      { id: "blake", servings: 1 },
    ],
    "2026-11-03",
    {
      avery: PEANUT,
      blake: [],
    },
  );
  assert.equal(out.seats.blake.estCalories - out.seats.avery.estCalories, 95);
  assert.equal(out.seats.blake.estProtein - out.seats.avery.estProtein, 4);
  const unread = bowlTailor(PRE_BED, [{ id: "avery", servings: 1 }], "2026-10-26", { avery: null });
  assert.match(unread.seats.avery.plate[0], /^not plated: your allergies could not be read/);
  assert.equal(unread.seats.avery.plate.length, 1);
});

test("item 5: the serve step names the optional row for the peanut seat", () => {
  const t = /** @type {any} */ ({
    id: "t1",
    slot: "dinner",
    recipeId: PRE_BED.id,
    seats: [
      { id: "avery", servings: 1 },
      { id: "blake", servings: 1 },
    ],
  });
  const order = [
    { id: "avery", name: "Avery" },
    { id: "blake", name: "Blake" },
  ];
  const serve = buildServe(
    t,
    PRE_BED,
    order,
    { avery: { avoidIngredients: ["peanuts"] }, blake: {} },
    null,
  );
  assert.equal(serve.rows.find((r) => r.id === "avery")?.note, "no peanut butter");
  assert.equal(serve.rows.find((r) => r.id === "blake")?.note, undefined);
  assert.deepEqual(
    softAvoidMatches(PRE_BED, ["peanuts"]),
    ["peanut butter"],
    "a plural avoid notes it too",
  );
});

// ---- item 8: the peanut family and "check the label" ------------------------

test("item 8: every name peanut is sold by is refused for a peanut allergy", () => {
  for (const food of [
    "groundnut oil",
    "arachis oil",
    "satay sauce",
    "PB2 powdered peanut butter",
    "PB2",
    "monkey nuts",
    "mixed nuts",
    "deluxe mixed nuts, salted",
    "trail mix",
    "kung pao sauce",
    "japanese curry roux",
    "japanese curry roux cubes",
    "Golden Curry, medium hot",
    "curry-roux",
  ]) {
    assert.ok(recipeConflicts(dish("d", [food]), undefined, PEANUT).length > 0, `"${food}" passed`);
  }
  // mixed nuts and trail mix are tree nuts too
  const nuts = avoidTermsFromAllergens(["nuts"], "");
  assert.ok(recipeConflicts(dish("d", ["mixed nuts"]), undefined, nuts).length > 0);
  assert.ok(recipeConflicts(dish("d", ["trail mix"]), undefined, nuts).length > 0);
});

test("item 8: roux decision: a roux written as its flour and butter passes a peanut seat; a row that only says roux refuses", () => {
  const plain = dish("bechamel", ["all-purpose flour", "unsalted butter", "whole milk", "nutmeg"]);
  assert.deepEqual(recipeConflicts(plain, undefined, PEANUT), []);
  assert.deepEqual(labelChecks(plain, PEANUT), []);
  // the name cannot say what is in it, so it fails closed (dairy makes the same call)
  assert.ok(recipeConflicts(dish("r", ["roux"]), undefined, PEANUT).length > 0);
});

test("item 8: label-dependent packaged foods carry a check-the-label line for the peanut seat only", () => {
  const muffins = dish("test-muffins", ["rolled oats", "semisweet chocolate chips", "granola"]);
  assert.deepEqual(recipeConflicts(muffins, undefined, PEANUT), [], "a label check never unseats");
  assert.deepEqual(labelChecks(muffins, PEANUT), [
    "check the label for peanut: semisweet chocolate chips, granola",
  ]);
  assert.deepEqual(labelChecks(muffins, ["peanuts"]), labelChecks(muffins, PEANUT));
  assert.deepEqual(labelChecks(muffins, []), [], "Blake gets no peanut line");
  assert.deepEqual(labelChecks(muffins, null), []);
  // a food the hard screen refuses is refused, not flagged
  assert.deepEqual(labelChecks(dish("p", ["peanut butter chocolate chips"]), PEANUT), []);
  // on the plate and on the serve step
  const plate = bowlTailor(muffins, [{ id: "avery", servings: 1 }], "2026-10-26", {
    avery: PEANUT,
  });
  assert.ok(
    plate.seats.avery.plate.includes(
      "check the label for peanut: semisweet chocolate chips, granola",
    ),
  );
  const t = /** @type {any} */ ({
    id: "t2",
    slot: "snack",
    recipeId: "test-muffins",
    seats: [{ id: "avery", servings: 1 }],
  });
  const serve = buildServe(
    t,
    muffins,
    [{ id: "avery", name: "Avery" }],
    { avery: { avoidIngredients: PEANUT } },
    null,
  );
  assert.equal(
    serve.rows[0].note,
    "check the label for peanut: semisweet chocolate chips, granola",
  );
});
