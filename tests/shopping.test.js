import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveShoppingList,
  sectionOf,
  applyJustBought,
  ownItemToPantry,
} from "../app/lib/shopping.js";

test("on-hand pantry staples are subtracted from the derived list by name", () => {
  const recipes = new Map([
    [
      "risotto",
      {
        id: "risotto",
        servings: 1,
        ingredients: [
          { qty: 30, unit: "g", food: "dried porcini mushrooms", staple: false },
          { qty: 300, unit: "g", food: "arborio rice", staple: false },
        ],
      },
    ],
  ]);
  const plan = {
    week: "2026-W28",
    entries: [{ id: "a", date: "2026-07-06", slot: "dinner", recipeId: "risotto", servings: 1 }],
  };
  const pantry = {
    staples: [
      {
        id: "dried-porcini-mushrooms",
        name: "dried porcini mushrooms",
        section: "dry-goods",
        onHand: true,
        runningLow: false,
      },
      // runningLow on-hand staples must NOT be subtracted
      {
        id: "arborio-rice",
        name: "arborio rice",
        section: "dry-goods",
        onHand: true,
        runningLow: true,
      },
    ],
    perishables: [],
  };
  const list = deriveShoppingList(plan, recipes, pantry);
  assert.equal(
    list.items.find((i) => i.food === "dried porcini mushrooms"),
    undefined,
  );
  assert.ok(list.items.find((i) => i.food === "arborio rice"));
});

test("ownItemToPantry removes ALL list rows of that food, any unit", () => {
  const shopping = {
    generatedFrom: "2026-W28",
    items: [
      {
        id: "olive-oil-cup",
        food: "olive oil",
        qty: 1,
        unit: "cup",
        section: "dry-goods",
        checked: false,
        manual: false,
      },
      {
        id: "olive-oil-tbsp",
        food: "olive oil",
        qty: 2,
        unit: "tbsp",
        section: "dry-goods",
        checked: false,
        manual: false,
      },
      {
        id: "tuna-can",
        food: "tuna",
        qty: 1,
        unit: "can",
        section: "other",
        checked: false,
        manual: false,
      },
    ],
  };
  const r = ownItemToPantry(shopping, { staples: [], perishables: [] }, "olive-oil-cup");
  assert.deepEqual(
    r.shopping.items.map((i) => i.id),
    ["tuna-can"],
  );
});

test("ownItemToPantry: list item becomes a permanent staple and leaves the list", () => {
  const shopping = {
    generatedFrom: "2026-W28",
    items: [
      {
        id: "dried-porcini-g",
        food: "dried porcini",
        qty: 30,
        unit: "g",
        section: "dry-goods",
        checked: false,
        manual: false,
      },
      {
        id: "tuna-can",
        food: "tuna",
        qty: 1,
        unit: "can",
        section: "other",
        checked: false,
        manual: false,
      },
    ],
  };
  const pantry = { staples: [], perishables: [] };
  const r = ownItemToPantry(shopping, pantry, "dried-porcini-g");
  assert.deepEqual(
    r.shopping.items.map((i) => i.id),
    ["tuna-can"],
  );
  const s = r.pantry.staples[0];
  assert.equal(s.name, "dried porcini");
  assert.equal(s.onHand, true);
  assert.equal(s.runningLow, false);
  assert.equal(s.section, "dry-goods");
});

test("ownItemToPantry: existing staple is refreshed, not duplicated", () => {
  const shopping = {
    generatedFrom: "2026-W28",
    items: [
      {
        id: "soy-sauce-x",
        food: "Soy sauce",
        qty: 1,
        unit: "x",
        section: "dry-goods",
        checked: false,
        manual: false,
      },
    ],
  };
  const pantry = {
    staples: [
      { id: "soy-sauce", name: "Soy sauce", section: "dry-goods", onHand: false, runningLow: true },
    ],
    perishables: [],
  };
  const r = ownItemToPantry(shopping, pantry, "soy-sauce-x");
  assert.equal(r.pantry.staples.length, 1);
  assert.equal(r.pantry.staples[0].onHand, true);
  assert.equal(r.pantry.staples[0].runningLow, false);
  assert.equal(r.shopping.items.length, 0);
});

test("ownItemToPantry: unknown id is a no-op", () => {
  const shopping = { generatedFrom: "2026-W28", items: [] };
  const pantry = { staples: [], perishables: [] };
  const r = ownItemToPantry(shopping, pantry, "nope");
  assert.deepEqual(r.shopping.items, []);
  assert.deepEqual(r.pantry.staples, []);
});

const RECIPES = new Map([
  [
    "beef-bowl",
    {
      id: "beef-bowl",
      servings: 1,
      ingredients: [
        { qty: 225, unit: "g", food: "ground beef", staple: false },
        { qty: 2, unit: "cup", food: "white rice", staple: true },
        { qty: 0.5, unit: "x", food: "onion", staple: true },
      ],
    },
  ],
  [
    "salad",
    {
      id: "salad",
      servings: 2,
      ingredients: [
        { qty: 2, unit: "can", food: "tuna", staple: false },
        { qty: 200, unit: "g", food: "green beans", staple: false },
        { qty: 225, unit: "g", food: "ground beef", staple: false },
      ],
    },
  ],
]);

const PLAN = {
  week: "2026-W28",
  entries: [
    { id: "a", date: "2026-07-06", slot: "dinner", recipeId: "beef-bowl", servings: 1 },
    { id: "b", date: "2026-07-07", slot: "dinner", recipeId: "beef-bowl", servings: 2 },
    { id: "c", date: "2026-07-08", slot: "lunch", recipeId: "salad", servings: 1 },
    { id: "d", date: "2026-07-09", slot: "lunch", freeText: "eating out", servings: 1 },
  ],
};

test("aggregates ingredients across the week, scaled by servings", () => {
  const list = deriveShoppingList(PLAN, RECIPES, { staples: [], perishables: [] });
  // beef: 225*1 + 225*2 (beef-bowl) + 225*(1/2 of salad's 2-serving batch) = 787.5
  const beef = list.items.find((i) => i.food === "ground beef");
  assert.equal(beef.qty, 787.5);
  assert.equal(beef.unit, "g");
});

test("per-serving scaling divides by the recipe's own servings", () => {
  const list = deriveShoppingList(PLAN, RECIPES, { staples: [], perishables: [] });
  const tuna = list.items.find((i) => i.food === "tuna");
  assert.equal(tuna.qty, 1); // 2 cans / 2 recipe servings * 1 planned serving
});

test("staple-flagged ingredients are excluded", () => {
  const list = deriveShoppingList(PLAN, RECIPES, { staples: [], perishables: [] });
  assert.equal(
    list.items.find((i) => i.food === "white rice"),
    undefined,
  );
  assert.equal(
    list.items.find((i) => i.food === "onion"),
    undefined,
  );
});

test("pantry staples marked runningLow are ADDED to the list", () => {
  const pantry = {
    staples: [
      { id: "cayenne", name: "Cayenne", section: "spices", onHand: true, runningLow: true },
      { id: "soy-sauce", name: "Soy sauce", section: "dry-goods", onHand: true, runningLow: false },
    ],
    perishables: [],
  };
  const list = deriveShoppingList(PLAN, RECIPES, pantry);
  const cay = list.items.find((i) => i.food === "Cayenne");
  assert.ok(cay);
  assert.equal(cay.section, "spices");
  assert.equal(
    list.items.find((i) => i.food === "Soy sauce"),
    undefined,
  );
});

test("items carry sections and generatedFrom is the week id", () => {
  const list = deriveShoppingList(PLAN, RECIPES, { staples: [], perishables: [] });
  assert.equal(list.generatedFrom, "2026-W28");
  assert.equal(list.items.find((i) => i.food === "ground beef").section, "meat");
  assert.equal(list.items.find((i) => i.food === "green beans").section, "produce");
});

test("regeneration preserves check-state and manual items", () => {
  const previous = {
    generatedFrom: "2026-W28",
    items: [
      {
        id: "ground-beef-g",
        food: "ground beef",
        qty: 500,
        unit: "g",
        section: "meat",
        checked: true,
        manual: false,
      },
      {
        id: "batteries-pack",
        food: "batteries",
        qty: 1,
        unit: "pack",
        section: "other",
        checked: false,
        manual: true,
      },
    ],
  };
  const list = deriveShoppingList(PLAN, RECIPES, { staples: [], perishables: [] }, previous);
  assert.equal(list.items.find((i) => i.food === "ground beef").checked, true);
  const manual = list.items.find((i) => i.food === "batteries");
  assert.ok(manual);
  assert.equal(manual.manual, true);
});

test("same food in different units gets DISTINCT ids (merge/toggle safety)", () => {
  const recipes = new Map([
    [
      "soup",
      {
        id: "soup",
        servings: 1,
        ingredients: [{ qty: 1, unit: "cup", food: "olive oil", staple: false }],
      },
    ],
    [
      "dressing",
      {
        id: "dressing",
        servings: 1,
        ingredients: [{ qty: 2, unit: "tbsp", food: "olive oil", staple: false }],
      },
    ],
  ]);
  const plan = {
    week: "2026-W28",
    entries: [
      { id: "a", date: "2026-07-06", slot: "dinner", recipeId: "soup", servings: 1 },
      { id: "b", date: "2026-07-06", slot: "lunch", recipeId: "dressing", servings: 1 },
    ],
  };
  const list = deriveShoppingList(plan, recipes, { staples: [], perishables: [] });
  const oils = list.items.filter((i) => i.food === "olive oil");
  assert.equal(oils.length, 2);
  assert.notEqual(oils[0].id, oils[1].id);
});

test("running-low staple is suppressed when a recipe already shops that food", () => {
  const recipes = new Map([
    [
      "stirfry",
      {
        id: "stirfry",
        servings: 1,
        ingredients: [{ qty: 2, unit: "tbsp", food: "soy sauce", staple: false }],
      },
    ],
  ]);
  const plan = {
    week: "2026-W28",
    entries: [{ id: "a", date: "2026-07-06", slot: "dinner", recipeId: "stirfry", servings: 1 }],
  };
  const pantry = {
    staples: [
      { id: "soy-sauce", name: "Soy sauce", section: "dry-goods", onHand: true, runningLow: true },
    ],
    perishables: [],
  };
  const list = deriveShoppingList(plan, recipes, pantry);
  const soys = list.items.filter((i) => i.food.toLowerCase().includes("soy"));
  assert.equal(soys.length, 1); // the quantified recipe line only, no duplicate
  assert.equal(soys[0].qty, 2);
});

test("sectionOf classifies common foods", () => {
  assert.equal(sectionOf("chicken breast"), "meat");
  assert.equal(sectionOf("greek yogurt"), "dairy");
  assert.equal(sectionOf("blueberries"), "produce");
  assert.equal(sectionOf("frozen mixed vegetables"), "frozen");
  assert.equal(sectionOf("mixed vegetables"), "produce");
  assert.equal(sectionOf("mystery powder"), "other");
});

test("applyJustBought: checked staples go onHand, others land in perishables", () => {
  const shopping = {
    generatedFrom: "2026-W28",
    items: [
      {
        id: "cayenne-x",
        food: "Cayenne",
        qty: 1,
        unit: "x",
        section: "spices",
        checked: true,
        manual: false,
      },
      {
        id: "ground-beef-g",
        food: "ground beef",
        qty: 787.5,
        unit: "g",
        section: "meat",
        checked: true,
        manual: false,
      },
      {
        id: "tuna-can",
        food: "tuna",
        qty: 1,
        unit: "can",
        section: "other",
        checked: false,
        manual: false,
      },
    ],
  };
  const pantry = {
    staples: [
      { id: "cayenne", name: "Cayenne", section: "spices", onHand: false, runningLow: true },
    ],
    perishables: [],
  };
  const result = applyJustBought(shopping, pantry, "2026-07-11");
  const cay = result.pantry.staples.find((s) => s.id === "cayenne");
  assert.equal(cay.onHand, true);
  assert.equal(cay.runningLow, false);
  assert.equal(result.pantry.perishables.length, 1);
  assert.equal(result.pantry.perishables[0].food, "ground beef");
  assert.equal(result.pantry.perishables[0].added, "2026-07-11");
  // checked items leave the list; unchecked stay
  assert.deepEqual(
    result.shopping.items.map((i) => i.food),
    ["tuna"],
  );
});
