import test from "node:test";
import assert from "node:assert/strict";
import { isBatchRecipe, scaleQty, cookPlan } from "../app/lib/portions.js";

test("isBatchRecipe: batch tags or a project effort count, everyday recipes don't", () => {
  assert.equal(isBatchRecipe({ tags: ["batch-friendly"] }), true);
  assert.equal(isBatchRecipe({ tags: ["freezes-well"] }), true);
  assert.equal(isBatchRecipe({ effort: "project" }), true);
  assert.equal(isBatchRecipe({ tags: ["quick"], effort: "cook" }), false);
  assert.equal(isBatchRecipe({}), false);
});

test("scaleQty rounds for cooking; countable units keep a half-item floor", () => {
  assert.equal(scaleQty(28, "oz", 0.5), 14);
  assert.equal(scaleQty(300, "g", 1 / 3), 100);
  // 2 eggs at half a recipe -> 1 egg
  assert.equal(scaleQty(2, "eggs", 0.5), 1);
  // 1 egg scaled to a quarter -> never vanishes, floors at 0.5
  assert.equal(scaleQty(1, "egg", 0.25), 0.5);
  // grams scaled small still keep 2 decimals
  assert.equal(scaleQty(5, "g", 0.5), 2.5);
});

test("cookPlan single mode scales an everyday recipe down to the meal", () => {
  const recipe = {
    servings: 2,
    tags: ["quick"],
    effort: "cook",
    ingredients: [
      { food: "firm tofu", qty: 28, unit: "oz" },
      { food: "broccoli", qty: 2, unit: "cups" },
    ],
  };
  const p = cookPlan(recipe, 1);
  assert.equal(p.mode, "single");
  assert.equal(p.cookServings, 1);
  assert.equal(p.extraServings, 0);
  assert.deepEqual(
    p.ingredients.map((i) => i.qty),
    [14, 1],
  );
  // no serving counts in anything a person reads (David, 2026-08-10)
  assert.match(p.note, /YOUR plate/);
  assert.ok(!/serving/i.test(p.note), p.note);
});

test("cookPlan batch mode cooks the full batch and banks the rest", () => {
  const recipe = {
    servings: 5,
    tags: ["batch-friendly"],
    ingredients: [{ food: "black beans", qty: 2, unit: "cans" }],
  };
  const p = cookPlan(recipe, 1.25);
  assert.equal(p.mode, "batch");
  assert.equal(p.cookServings, 5); // cook it all
  assert.equal(p.eatServings, 1.25);
  assert.equal(p.extraServings, 3.75);
  assert.deepEqual(
    p.ingredients.map((i) => i.qty),
    [2],
  ); // unscaled
  assert.match(p.note, /fridge/);
  assert.ok(!/serving/i.test(p.note), p.note);
});

test("cookPlan full mode: cooking the whole recipe (or cookbook browse) doesn't scale", () => {
  const recipe = { servings: 2, ingredients: [{ food: "x", qty: 10, unit: "g" }] };
  // planned >= servings
  assert.equal(cookPlan(recipe, 2).mode, "full");
  // no planned servings (cookbook) -> full recipe
  const browse = cookPlan(recipe, undefined);
  assert.equal(browse.mode, "full");
  assert.deepEqual(
    browse.ingredients.map((i) => i.qty),
    [10],
  );
});

test("cooking MORE than the recipe makes scales every ingredient UP (family batch)", () => {
  // David 2026-08-03: "cook ×5.75 of a 2-serving recipe" showed the
  // 2-serving amounts with a multiplier to do in your head. The cook reads
  // real numbers now.
  const recipe = {
    id: "sheet-pan",
    servings: 2,
    tags: [],
    ingredients: [
      { qty: 300, unit: "g", food: "salmon" },
      { qty: 1, unit: "each", food: "broccoli crown" },
    ],
  };
  const plan = cookPlan(recipe, 5.75);
  assert.equal(plan.mode, "scaled");
  assert.equal(plan.cookServings, 5.75);
  assert.equal(plan.ingredients[0].qty, 862.5, "300 g × 5.75/2");
  assert.equal(plan.ingredients[1].qty, 3, "counts round to a cookable half");
  assert.match(plan.note, /WHOLE POT/);
  assert.ok(!/serving/i.test(plan.note), plan.note);
  // exact yield unchanged: still mode full, unscaled
  assert.equal(cookPlan(recipe, 2).mode, "full");
});

// ---- assembled per bowl (David 2026-09-07, the yogurt bowl's 1 cup vs 1.5 cup) --

import { readFileSync } from "node:fs";
import { isPerBowl } from "../app/lib/portions.js";

const BOWL = {
  id: "bowl",
  servings: 1,
  effort: "assembly",
  cookTime: 0,
  tags: ["no-cook"],
  ingredients: [
    { qty: 1, unit: "cup", food: "greek yogurt" },
    { qty: 0.5, unit: "each", food: "banana" },
    { qty: 1, unit: "tbsp", food: "honey" },
  ],
};

test("isPerBowl: written for one, nothing through heat, not a batch", () => {
  assert.equal(isPerBowl(BOWL), true);
  assert.equal(isPerBowl({ ...BOWL, effort: "assemble" }), true);
  // a rotating recipe is per bowl outright: its target and tolerance are per serving
  assert.equal(
    isPerBowl({
      servings: 1,
      effort: "cook",
      rotation: { perDay: 2, pool: [{ food: "a" }, { food: "b" }, { food: "c" }] },
    }),
    true,
  );
  // a 2-serving fried rice tagged "assembly" still comes out of one pan
  assert.equal(isPerBowl({ ...BOWL, servings: 2 }), false);
  // heat means a pan, and a pan is shared
  assert.equal(isPerBowl({ ...BOWL, cookTime: 6 }), false);
  // a batch of energy bites is made as a batch
  assert.equal(isPerBowl({ ...BOWL, tags: ["meal-prep"] }), false);
  assert.equal(isPerBowl({ ...BOWL, effort: "cook" }), false);
  assert.equal(isPerBowl(undefined), false);
});

test("cookPlan bowl mode: ONE bowl at this eater's portion, and it says so", () => {
  // opened from the cookbook: the recipe as written, still labelled a bowl
  const asWritten = cookPlan(BOWL);
  assert.equal(asWritten.mode, "bowl");
  assert.equal(asWritten.ingredients[0].qty, 1);
  assert.match(asWritten.note, /ONE portion/);
  assert.match(asWritten.note, /their own/);
  assert.ok(!/serving/i.test(asWritten.note), asWritten.note);
  // a 0.75 seat gets a 0.75 bowl, not a pot
  const seat = cookPlan(BOWL, 0.75);
  assert.equal(seat.mode, "bowl");
  assert.equal(seat.eatServings, 0.75);
  assert.equal(seat.ingredients[0].qty, 0.75, "yogurt scales to the seat");
  assert.equal(seat.ingredients[1].qty, 0.5, "half a banana stays half a banana");
  // a two-seat table total must NOT become "the whole pot" for a bowl: the
  // caller never passes cookTotal for a per-bowl dish, and even if it did
  // the mode stays bowl and the note never says pot
  const pooled = cookPlan(BOWL, 1.5);
  assert.equal(pooled.mode, "bowl");
  assert.ok(!/WHOLE POT/.test(pooled.note), pooled.note);
});

test("THE LIVE YOGURT BOWL is per bowl, and its list scales with the seat", () => {
  const live = JSON.parse(
    readFileSync(
      new URL("../../mise-data/recipes/berry-walnut-greek-yogurt-bowl.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(isPerBowl(live), true);
  const plan = cookPlan(live, 0.75);
  assert.equal(plan.mode, "bowl");
  const yogurt = plan.ingredients.find((i) => /greek yogurt/i.test(i.food));
  assert.equal(yogurt.qty, 0.75);
});
