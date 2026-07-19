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
  assert.deepEqual(p.ingredients.map((i) => i.qty), [14, 1]);
  assert.match(p.note, /Scaled to your meal/);
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
  assert.deepEqual(p.ingredients.map((i) => i.qty), [2]); // unscaled
  assert.match(p.note, /save the other 3.75/);
});

test("cookPlan full mode: cooking the whole recipe (or cookbook browse) doesn't scale", () => {
  const recipe = { servings: 2, ingredients: [{ food: "x", qty: 10, unit: "g" }] };
  // planned >= servings
  assert.equal(cookPlan(recipe, 2).mode, "full");
  // no planned servings (cookbook) -> full recipe
  const browse = cookPlan(recipe, undefined);
  assert.equal(browse.mode, "full");
  assert.deepEqual(browse.ingredients.map((i) => i.qty), [10]);
});
