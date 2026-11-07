// CONSOLIDATE (P5; David, 2026-11-06: "not need to cut just consolidate.
// things are cheaper in bulk so repeast ingredients more"). The same food
// written in two units, or under two names, is ONE row on the List and one
// package at the store. Found on the 11/15 week of his real kitchen: kale
// as 80 g and 2.25 cup (two bags), "cinnamon" and "ground cinnamon" (two
// jars), vanilla by tsp and by gram.
import test from "node:test";
import assert from "node:assert/strict";
import { deriveShoppingList } from "../app/lib/shopping.js";
import { canonicalFood, toPreferred } from "../app/lib/ingredients.js";
import { recipesById } from "../app/lib/plan.js";

const recipe = (id, ingredients) => ({ id, name: id, servings: 1, ingredients });

test("consolidate: one food in grams and cups is one List row", () => {
  const bank = [
    recipe("soup", [{ food: "kale", qty: 80, unit: "g" }]),
    recipe("salad", [{ food: "kale", qty: 2.25, unit: "cup" }]),
  ];
  const plan = {
    week: "2026-W47",
    entries: [
      { id: "a", date: "2026-11-16", slot: "dinner", recipeId: "soup", servings: 1 },
      { id: "b", date: "2026-11-17", slot: "dinner", recipeId: "salad", servings: 1 },
    ],
  };
  const list = deriveShoppingList(/** @type {any} */ (plan), recipesById(bank), { items: [] });
  const kale = list.items.filter((i) => canonicalFood(i.food) === "kale");
  assert.equal(kale.length, 1, JSON.stringify(kale));
  // 80 g + 2.25 cup at 67 g a cup = 230.75 g, rounded up for purchase
  assert.equal(kale[0].unit, "g");
  assert.ok(kale[0].qty >= 230.75 && kale[0].qty <= 260, `${kale[0].qty} ${kale[0].unit}`);
});

test("consolidate: ground cinnamon and cinnamon are one jar", () => {
  assert.equal(canonicalFood("ground cinnamon"), canonicalFood("cinnamon"));
  const bank = [
    recipe("jar", [{ food: "cinnamon", qty: 1, unit: "tsp" }]),
    recipe("muffin", [{ food: "ground cinnamon", qty: 2, unit: "g" }]),
  ];
  const plan = {
    week: "2026-W47",
    entries: [
      { id: "a", date: "2026-11-16", slot: "breakfast", recipeId: "jar", servings: 1 },
      { id: "b", date: "2026-11-16", slot: "snack", recipeId: "muffin", servings: 1 },
    ],
  };
  const list = deriveShoppingList(/** @type {any} */ (plan), recipesById(bank), { items: [] });
  const rows = list.items.filter((i) => /cinnamon/.test(i.food));
  assert.equal(rows.length, 1, JSON.stringify(rows));
});

test("consolidate: every unit his pantry foods are written in converts (dates, almond butter, vanilla, brown sugar)", () => {
  for (const [food, units] of /** @type {[string, string[]][]} */ ([
    ["dates", ["g", "cup"]],
    ["almond butter", ["g", "tbsp", "cup"]],
    ["vanilla extract", ["g", "tsp"]],
    ["brown sugar", ["g", "tbsp"]],
    ["frozen spinach", ["g", "box"]],
  ])) {
    for (const u of units) {
      assert.ok(toPreferred(1, u, canonicalFood(food)), `${food} in ${u} must convert`);
    }
  }
});
