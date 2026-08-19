// 7.2: every bought perishable gets used before it dies — the coverage check
import test from "node:test";
import assert from "node:assert/strict";
import { perishableCoverage } from "../app/lib/coverage.js";

const RECIPES = [
  { id: "stir-fry", ingredients: [{ food: "chicken breast", qty: 400, unit: "g" }, { food: "broccoli", qty: 300, unit: "g" }] },
  { id: "salad", ingredients: [{ food: "baby spinach", qty: 2, unit: "cup" }] },
];

const pantryOf = (items) => ({ items });

test("a perishable cooked inside its window is covered; one with no home is a gap", () => {
  const plan = { week: "2026-W34", entries: [
    { id: "e1", date: "2026-08-20", slot: "dinner", recipeId: "stir-fry", servings: 1 },
  ] };
  const pantry = pantryOf([
    { id: "a", food: "chicken breast", qty: "500 g", added: "2026-08-19", expires: "2026-08-23", location: "fridge" },
    { id: "b", food: "baby spinach", qty: "10 oz", added: "2026-08-19", expires: "2026-08-25", location: "fridge" },
  ]);
  const { gaps, checked } = perishableCoverage(plan, RECIPES, pantry, "2026-08-19");
  assert.equal(checked, 2);
  assert.deepEqual(gaps.map((g) => g.food), ["baby spinach"], "spinach has no scheduled meal");
});

test("a meal AFTER expiry is not a home; cooked/out/past entries never cover", () => {
  const plan = { week: "2026-W34", entries: [
    { id: "late", date: "2026-08-26", slot: "dinner", recipeId: "salad", servings: 1 },
    { id: "done", date: "2026-08-20", slot: "lunch", recipeId: "stir-fry", servings: 1, cookedAt: "2026-08-19" },
    { id: "gone", date: "2026-08-18", slot: "dinner", recipeId: "stir-fry", servings: 1 },
  ] };
  const pantry = pantryOf([
    { id: "b", food: "baby spinach", qty: "10 oz", added: "2026-08-19", expires: "2026-08-25", location: "fridge" },
    { id: "a", food: "chicken breast", qty: "500 g", added: "2026-08-19", expires: "2026-08-23", location: "fridge" },
  ]);
  const { gaps } = perishableCoverage(plan, RECIPES, pantry, "2026-08-19");
  assert.deepEqual(gaps.map((g) => g.food), ["chicken breast", "baby spinach"], "soonest-dying first");
});

test("freezer rows, state items, and already-expired rows are not gaps", () => {
  const plan = { week: "2026-W34", entries: [] };
  const pantry = pantryOf([
    { id: "f", food: "chicken breast", qty: "2 lb", added: "2026-08-01", location: "freezer" },
    { id: "s", food: "salt", state: "plenty" },
    { id: "x", food: "old spinach", qty: "1 bag", added: "2026-08-01", expires: "2026-08-05", location: "fridge" },
  ]);
  const { gaps, checked } = perishableCoverage(plan, RECIPES, pantry, "2026-08-19");
  assert.equal(checked, 0);
  assert.deepEqual(gaps, []);
});
