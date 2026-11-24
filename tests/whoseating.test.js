import { test } from "node:test";
import assert from "node:assert/strict";
import { whoIsEating, portionsLabel } from "../app/lib/whoseating.js";

const soup = {
  id: "soup",
  mealType: "dinner",
  servings: 4,
  nutrition: { calories: 600, protein: 40 },
  ingredients: [
    { food: "chicken", qty: 400, unit: "g" },
    { food: "peanut butter", qty: 30, unit: "g" },
  ],
};
const gain = { macros: { calories: 3700 }, diet: [], avoidIngredients: [], avoidRecipes: [] };
const light = { macros: { calories: 2000 }, diet: [], avoidIngredients: [], avoidRecipes: [] };

test("a profile counts its own portion; a bigger day eats more of the same pot", () => {
  const { rows } = whoIsEating(soup, [
    { id: "david", name: "David", targets: gain },
    { id: "mom", name: "Mom", targets: light },
  ]);
  assert.ok(rows[0].portions > rows[1].portions, JSON.stringify(rows));
  assert.equal(rows[0].kcal, Math.round(600 * rows[0].portions));
});

test("a typed name with no profile counts one portion", () => {
  const r = whoIsEating(soup, [{ id: "g:sam", name: "Sam", guest: true }]);
  assert.equal(r.rows[0].portions, 1);
  assert.equal(r.cookPortions, 1);
});

test("the allergy screen refuses a seat and it is not counted", () => {
  const allergic = { ...light, avoidIngredients: ["peanut"] };
  const r = whoIsEating(soup, [
    { id: "elliot", name: "Elliot", targets: allergic },
    { id: "g:sam", name: "Sam", guest: true },
  ]);
  assert.equal(r.rows[0].portions, 0);
  assert.ok(r.rows[0].blocked.length > 0);
  assert.equal(r.total, 1);
});

test("an unreadable profile fails closed", () => {
  const r = whoIsEating(soup, [{ id: "x", name: "X", targets: null }]);
  assert.equal(r.rows[0].portions, 0);
  assert.deepEqual(r.rows[0].blocked, ["their profile could not be read"]);
});

test("the pot rounds up to whole portions", () => {
  const r = whoIsEating(soup, [
    { id: "david", name: "David", targets: gain },
    { id: "g:sam", name: "Sam", guest: true },
  ]);
  assert.equal(r.cookPortions, Math.ceil(r.total));
  assert.equal(portionsLabel(1), "1 portion");
  assert.equal(portionsLabel(1.75), "1.75 portions");
});
