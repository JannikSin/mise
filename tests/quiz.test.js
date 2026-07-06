import test from "node:test";
import assert from "node:assert/strict";
import { rankRecipes } from "../app/lib/quiz.js";

/** Minimal recipe factory matching the SCHEMAS.md shape the ranker reads. */
function r(
  id,
  { purpose = ["everyday"], totalTime = 20, calories = 600, protein = 40, foods = [] } = {},
) {
  return {
    id,
    name: id,
    purpose,
    totalTime,
    nutrition: { calories, protein, carbs: 0, fat: 0, method: "estimated" },
    ingredients: foods.map((f) => ({ qty: 1, unit: "x", food: f })),
  };
}

test("recipes over the time budget are excluded entirely", () => {
  const out = rankRecipes([r("fast", { totalTime: 10 }), r("slow", { totalTime: 45 })], {
    time: 15,
    purpose: null,
    load: null,
  });
  assert.deepEqual(
    out.map((s) => s.recipe.id),
    ["fast"],
  );
});

test("purpose match outranks non-match", () => {
  const out = rankRecipes(
    [r("plain", { purpose: ["everyday"] }), r("recov", { purpose: ["recovery"] })],
    { time: 999, purpose: "recovery", load: null },
  );
  assert.equal(out[0].recipe.id, "recov");
  assert.ok(out[0].score > out[1].score);
});

test("heavy load prefers high-calorie recipes", () => {
  const out = rankRecipes([r("light-meal", { calories: 450 }), r("big-meal", { calories: 900 })], {
    time: 999,
    purpose: null,
    load: "heavy",
  });
  assert.equal(out[0].recipe.id, "big-meal");
});

test("light load prefers low-calorie recipes", () => {
  const out = rankRecipes([r("light-meal", { calories: 450 }), r("big-meal", { calories: 900 })], {
    time: 999,
    purpose: null,
    load: "light",
  });
  assert.equal(out[0].recipe.id, "light-meal");
});

test("a use-soon pantry item in the ingredients boosts the recipe", () => {
  const out = rankRecipes(
    [r("no-cabbage", { foods: ["rice"] }), r("with-cabbage", { foods: ["cabbage", "rice"] })],
    { time: 999, purpose: null, load: null, useSoonFoods: ["half cabbage"] },
  );
  assert.equal(out[0].recipe.id, "with-cabbage");
});

test("ties break toward higher protein", () => {
  const out = rankRecipes([r("low-p", { protein: 20 }), r("high-p", { protein: 60 })], {
    time: 999,
    purpose: null,
    load: null,
  });
  assert.equal(out[0].recipe.id, "high-p");
});

test("every result carries human-readable reasons", () => {
  const out = rankRecipes([r("recov", { purpose: ["recovery"], totalTime: 10 })], {
    time: 15,
    purpose: "recovery",
    load: null,
  });
  assert.ok(Array.isArray(out[0].reasons));
  assert.ok(out[0].reasons.length >= 1);
});
