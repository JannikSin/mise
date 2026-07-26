import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveShoppingList,
  normalizePantry,
  sectionOf,
  applyJustBought,
  ownItemToPantry,
  expirePerishables,
  perishableStatus,
  withAutoUseSoon,
  removeFromPantry,
  shelfLifeDays,
  roundForPurchase,
  householdOthers,
  householdOf,
  pantryPathFor,
  mergeProfileLists,
  swapCandidates,
  toStoreUnits,
  formatStoreQty,
  tripOf,
  emptyPantry,
  applySweep,
  substitutionPlan,
} from "../app/lib/shopping.js";

test("tripOf: perishable sections are the fresh trip, shelf-stable the pantry trip", () => {
  assert.equal(tripOf("produce"), "fresh");
  assert.equal(tripOf("meat"), "fresh");
  assert.equal(tripOf("dairy"), "fresh");
  assert.equal(tripOf("seafood"), "fresh");
  assert.equal(tripOf("bakery"), "fresh");
  assert.equal(tripOf("grains"), "pantry");
  assert.equal(tripOf("canned"), "pantry");
  assert.equal(tripOf("condiments"), "pantry");
  assert.equal(tripOf("frozen"), "pantry");
  assert.equal(tripOf("spices"), "pantry");
  assert.equal(tripOf("other"), "pantry");
});

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

test("fromDate skips entries already eaten; buffer still shops", () => {
  const recipes = new Map([
    [
      "oats",
      { id: "oats", servings: 1, ingredients: [{ qty: 80, unit: "g", food: "rolled oats" }] },
    ],
    [
      "stew",
      { id: "stew", servings: 1, ingredients: [{ qty: 1, unit: "can", food: "chickpeas" }] },
    ],
    ["bites", { id: "bites", servings: 1, ingredients: [{ qty: 50, unit: "g", food: "dates" }] }],
  ]);
  const plan = {
    week: "2026-W30",
    entries: [
      { id: "m", date: "2026-07-20", slot: "breakfast", recipeId: "oats", servings: 1 },
      { id: "w", date: "2026-07-22", slot: "dinner", recipeId: "stew", servings: 1 },
    ],
    buffer: { recipeId: "bites", portions: 5 },
  };
  const pantry = { staples: [], perishables: [] };

  const midWeek = deriveShoppingList(plan, recipes, pantry, null, "2026-07-21");
  assert.equal(
    midWeek.items.find((i) => i.food === "rolled oats"),
    undefined,
  );
  assert.ok(midWeek.items.find((i) => i.food === "chickpeas"));
  assert.ok(midWeek.items.find((i) => i.food === "dates"));

  // absent fromDate = whole week, unchanged behavior
  const full = deriveShoppingList(plan, recipes, pantry);
  assert.ok(full.items.find((i) => i.food === "rolled oats"));
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
  // beef: 225*1 + 225*2 (beef-bowl) + 225*(1/2 of salad's 2-serving batch) = 787.5,
  // rounded up to a purchasable 800g (100-999g band rounds to nearest 25g)
  const beef = list.items.find((i) => i.food === "ground beef");
  assert.equal(beef.qty, 800);
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

test("a KNOWN food in two units becomes ONE row (the broccoli complaint)", () => {
  // David, 2026-07-25: the list showed the same food several times. A food in
  // the canonical table now merges across units and reads in its own unit.
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
  assert.equal(oils.length, 1, "one food, one row");
  assert.equal(oils[0].unit, "tbsp", "and it reads in the unit you measure oil in");
  assert.equal(oils[0].qty, 18); // 1 cup = 16 tbsp, plus 2
});

test("an UNKNOWN food in two units still gets distinct ids (merge/toggle safety)", () => {
  // the safety property the old unit-aware id existed for: a name the table
  // has never seen must never silently collapse two different things
  const recipes = new Map([
    [
      "a",
      {
        id: "a",
        servings: 1,
        ingredients: [{ qty: 1, unit: "cup", food: "dragon fruit", staple: false }],
      },
    ],
    [
      "b",
      {
        id: "b",
        servings: 1,
        ingredients: [{ qty: 2, unit: "each", food: "dragon fruit", staple: false }],
      },
    ],
  ]);
  const plan = {
    week: "2026-W28",
    entries: [
      { id: "a", date: "2026-07-06", slot: "dinner", recipeId: "a", servings: 1 },
      { id: "b", date: "2026-07-06", slot: "lunch", recipeId: "b", servings: 1 },
    ],
  };
  const list = deriveShoppingList(plan, recipes, { staples: [], perishables: [] });
  const rows = list.items.filter((i) => i.food === "dragon fruit");
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
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

test("sectionOf classifies common foods across the wider aisle taxonomy", () => {
  // David, 2026-07-25: "the items are not sorted in any helpful way". Seven
  // buckets became fourteen real aisles, shared with the pantry groups.
  assert.equal(sectionOf("chicken breast"), "meat");
  assert.equal(sectionOf("salmon fillet"), "seafood");
  assert.equal(sectionOf("greek yogurt"), "dairy");
  assert.equal(sectionOf("blueberries"), "produce");
  assert.equal(sectionOf("frozen mixed vegetables"), "frozen");
  assert.equal(sectionOf("mixed vegetables"), "produce");
  assert.equal(sectionOf("whole wheat pita"), "bakery");
  assert.equal(sectionOf("rolled oats"), "grains");
  assert.equal(sectionOf("olive oil"), "condiments");
  assert.equal(sectionOf("smoked paprika"), "spices");
  assert.equal(sectionOf("mystery powder"), "other");
  // the trap: fresh green beans are produce, tinned legumes are canned
  assert.equal(sectionOf("green beans"), "produce");
  assert.equal(sectionOf("black beans"), "canned");
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

test("roundForPurchase: countable units round up to the next whole number", () => {
  assert.deepEqual(roundForPurchase(1.88, "each"), { qty: 2, unit: "each" });
  assert.deepEqual(roundForPurchase(10.5, "each"), { qty: 11, unit: "each" });
  assert.deepEqual(roundForPurchase(0.2, "clove"), { qty: 1, unit: "clove" });
  assert.deepEqual(roundForPurchase(1, "can"), { qty: 1, unit: "can" });
});

test("roundForPurchase: countable units never round a nonzero qty down to 0", () => {
  assert.deepEqual(roundForPurchase(0.01, "each"), { qty: 1, unit: "each" });
});

test("roundForPurchase: exact values pass through unchanged", () => {
  assert.deepEqual(roundForPurchase(2, "each"), { qty: 2, unit: "each" });
});

test("roundForPurchase: grams under 100 round up to the nearest 10g", () => {
  assert.deepEqual(roundForPurchase(42, "g"), { qty: 50, unit: "g" });
});

test("roundForPurchase: grams 100-999 round up to the nearest 25g", () => {
  assert.deepEqual(roundForPurchase(956.25, "g"), { qty: 975, unit: "g" });
});

test("roundForPurchase: grams 1000+ promote to kg, one decimal, rounded up", () => {
  assert.deepEqual(roundForPurchase(1240, "g"), { qty: 1.3, unit: "kg" });
});

test("roundForPurchase: ml under 100 round up to the nearest 10ml", () => {
  assert.deepEqual(roundForPurchase(35, "ml"), { qty: 40, unit: "ml" });
});

test("roundForPurchase: ml 100-999 round up to the nearest 50ml", () => {
  assert.deepEqual(roundForPurchase(210, "ml"), { qty: 250, unit: "ml" });
});

test("roundForPurchase: ml 1000+ promote to L, one decimal, rounded up", () => {
  assert.deepEqual(roundForPurchase(1450, "ml"), { qty: 1.5, unit: "l" });
});

test("roundForPurchase: cups/tbsp/tsp round up to the nearest 0.25", () => {
  assert.deepEqual(roundForPurchase(1.1, "cup"), { qty: 1.25, unit: "cup" });
  assert.deepEqual(roundForPurchase(0.6, "tbsp"), { qty: 0.75, unit: "tbsp" });
  assert.deepEqual(roundForPurchase(0.05, "tsp"), { qty: 0.25, unit: "tsp" });
});

test("roundForPurchase: lb rounds up to the nearest 0.25, oz to the nearest 1", () => {
  assert.deepEqual(roundForPurchase(1.1, "lb"), { qty: 1.25, unit: "lb" });
  assert.deepEqual(roundForPurchase(3.2, "oz"), { qty: 4, unit: "oz" });
});

test("roundForPurchase: unknown units round up to 1 decimal place", () => {
  assert.deepEqual(roundForPurchase(1.234, "bunch"), { qty: 1.3, unit: "bunch" });
});

test("deriveShoppingList rounds AFTER summing across recipes, not per-recipe", () => {
  // two recipes each need 0.3 bell pepper (each). Summed first: 0.6 -> ceil -> 1.
  // Ceiling each recipe's contribution before summing would wrongly give 1+1=2.
  const recipes = new Map([
    [
      "recipe-a",
      {
        id: "recipe-a",
        servings: 1,
        ingredients: [{ qty: 0.3, unit: "each", food: "bell pepper", staple: false }],
      },
    ],
    [
      "recipe-b",
      {
        id: "recipe-b",
        servings: 1,
        ingredients: [{ qty: 0.3, unit: "each", food: "bell pepper", staple: false }],
      },
    ],
  ]);
  const plan = {
    week: "2026-W28",
    entries: [
      { id: "a", date: "2026-07-06", slot: "dinner", recipeId: "recipe-a", servings: 1 },
      { id: "b", date: "2026-07-07", slot: "dinner", recipeId: "recipe-b", servings: 1 },
    ],
  };
  const list = deriveShoppingList(plan, recipes, { staples: [], perishables: [] });
  const pepper = list.items.find((i) => i.food === "bell pepper");
  assert.equal(pepper.qty, 1);
  assert.equal(pepper.unit, "each");
});

test("mergeProfileLists sums overlapping items by id and tracks per-profile sources", () => {
  const david = {
    items: [
      {
        id: "feta-cheese-cup",
        food: "feta cheese",
        qty: 1,
        unit: "cup",
        section: "dairy",
        checked: false,
        manual: false,
      },
      {
        id: "chicken-thigh-g",
        food: "chicken thigh",
        qty: 900,
        unit: "g",
        section: "meat",
        checked: true,
        manual: false,
      },
    ],
  };
  const mom = {
    items: [
      {
        id: "feta-cheese-cup",
        food: "feta cheese",
        qty: 0.5,
        unit: "cup",
        section: "dairy",
        checked: true,
        manual: false,
      },
      {
        id: "blue-cheese-cup",
        food: "blue cheese",
        qty: 0.25,
        unit: "cup",
        section: "dairy",
        checked: false,
        manual: false,
      },
    ],
  };
  const combined = mergeProfileLists([
    { profileId: "david", list: david },
    { profileId: "mom", list: mom },
  ]);

  const feta = combined.find((i) => i.id === "feta-cheese-cup");
  assert.equal(feta.qty, 1.5);
  assert.deepEqual(feta.sources.map((s) => s.profileId).sort(), ["david", "mom"]);
  // half-bought is not bought: david's source unchecked
  assert.equal(
    feta.sources.every((s) => s.checked),
    false,
  );

  const chicken = combined.find((i) => i.id === "chicken-thigh-g");
  assert.equal(chicken.sources.length, 1);
  assert.equal(
    chicken.sources.every((s) => s.checked),
    true,
  );

  // sorted section-first like the per-profile list
  const sections = combined.map((i) => i.section);
  assert.deepEqual(sections, [...sections].sort());
});

test("swapCandidates flags single-profile partial-container items with what others already buy", () => {
  const combined = mergeProfileLists([
    {
      profileId: "david",
      list: {
        items: [
          {
            id: "feta-cheese-cup",
            food: "feta cheese",
            qty: 1,
            unit: "cup",
            section: "dairy",
            checked: false,
            manual: false,
          },
          {
            id: "ground-beef-g",
            food: "ground beef",
            qty: 400,
            unit: "g",
            section: "meat",
            checked: false,
            manual: false,
          },
        ],
      },
    },
    {
      profileId: "mom",
      list: {
        items: [
          {
            id: "blue-cheese-cup",
            food: "blue cheese",
            qty: 0.25,
            unit: "cup",
            section: "dairy",
            checked: false,
            manual: false,
          },
          {
            id: "chicken-thigh-g",
            food: "chicken thigh",
            qty: 500,
            unit: "g",
            section: "meat",
            checked: false,
            manual: false,
          },
        ],
      },
    },
  ]);
  const cands = swapCandidates(combined);
  // blue cheese: only mom buys it, dairy is partial-container-prone, and
  // david is already buying feta in the same section -> candidate
  const blue = cands.find((c) => c.item.id === "blue-cheese-cup");
  assert.ok(blue);
  assert.deepEqual(
    blue.alreadyBuying.map((i) => i.id),
    ["feta-cheese-cup"],
  );
  // meat is a use-it-all section: never suggested
  assert.equal(
    cands.some((c) => c.item.section === "meat"),
    false,
  );
});

test("swapCandidates stays quiet when there is nothing to pair", () => {
  const combined = mergeProfileLists([
    {
      profileId: "david",
      list: {
        items: [
          {
            id: "feta-cheese-cup",
            food: "feta cheese",
            qty: 1,
            unit: "cup",
            section: "dairy",
            checked: false,
            manual: false,
          },
        ],
      },
    },
    { profileId: "mom", list: { items: [] } },
  ]);
  assert.deepEqual(swapCandidates(combined), []);
});

test("toStoreUnits converts faithfully — never re-stepped, imperial always agrees with metric", () => {
  // 800 g is already purchasable; display must be the faithful 1.76 lb, not a re-ceiled 1.80 lb
  assert.deepEqual(toStoreUnits(800, "g"), { qty: 1.76, unit: "lb" });
  assert.deepEqual(toStoreUnits(900, "g"), { qty: 1.98, unit: "lb" });
  assert.deepEqual(toStoreUnits(200, "g"), { qty: 7.1, unit: "oz" });
  assert.deepEqual(toStoreUnits(399, "g"), { qty: 14.1, unit: "oz" });
  assert.deepEqual(toStoreUnits(400, "g"), { qty: 0.88, unit: "lb" });
  assert.deepEqual(toStoreUnits(1.8, "kg"), { qty: 3.97, unit: "lb" });
  assert.deepEqual(toStoreUnits(500, "ml"), { qty: 16.9, unit: "fl oz" });
  assert.deepEqual(toStoreUnits(1, "l"), { qty: 1.06, unit: "qt" });
  // native-US units pass through untouched
  assert.equal(toStoreUnits(3, "cup"), null);
  assert.equal(toStoreUnits(2, "each"), null);
  assert.equal(toStoreUnits(1, "can"), null);
});

test("formatStoreQty shows imperial first with the authoritative metric in parens", () => {
  assert.equal(formatStoreQty(900, "g"), "1.98 lb (900 g)");
  assert.equal(formatStoreQty(75, "g"), "2.6 oz (75 g)");
  assert.equal(formatStoreQty(3, "cup"), "3 cup");
});

test("householdOthers merges only same-household profiles, absent household = home", () => {
  const profiles = [
    { id: "david", name: "David" }, // no household -> "home"
    { id: "mom", name: "Mom" }, // no household -> "home"
    { id: "laurie", name: "Laurie", household: "laurie" },
  ];
  // pre-household behavior preserved: david still sees mom, and only mom
  assert.deepEqual(
    householdOthers(profiles, "david").map((p) => p.id),
    ["mom"],
  );
  assert.deepEqual(
    householdOthers(profiles, "mom").map((p) => p.id),
    ["david"],
  );
  // laurie is alone in her household -> no EVERYONE tab
  assert.deepEqual(householdOthers(profiles, "laurie"), []);
  // an unknown active id defaults to "home" rather than crashing
  assert.deepEqual(
    householdOthers(profiles, "ghost").map((p) => p.id),
    ["david", "mom"],
  );
});

test("shelfLifeDays maps foods to reasonable windows, default 14", () => {
  assert.equal(shelfLifeDays("chicken breast"), 4);
  assert.equal(shelfLifeDays("baby spinach"), 6);
  assert.equal(shelfLifeDays("salmon fillet"), 3);
  assert.equal(shelfLifeDays("firm tofu"), 8);
  assert.equal(shelfLifeDays("eggs"), 28);
  assert.equal(shelfLifeDays("dragonfruit"), 14); // unknown default
});

test("expirePerishables drops only items past shelf life, keeps dateless ones", () => {
  const pantry = {
    perishables: [
      { food: "spinach", added: "2026-07-01" }, // 18 days old, 6-day life -> gone
      { food: "chicken breast", added: "2026-07-17" }, // 2 days old, 4-day life -> keep
      { food: "eggs", added: "2026-07-01" }, // 18 days, 28-day life -> keep
      { food: "mystery leftovers" }, // no date -> keep
    ],
  };
  const { pantry: out, expired } = expirePerishables(pantry, "2026-07-19");
  assert.deepEqual(expired, ["spinach"]);
  assert.deepEqual(
    out.perishables.map((p) => p.food),
    ["chicken breast", "eggs", "mystery leftovers"],
  );
  // nothing expired -> same object back (no needless write)
  const none = expirePerishables(
    { perishables: [{ food: "eggs", added: "2026-07-18" }] },
    "2026-07-19",
  );
  assert.equal(none.expired.length, 0);
});

test("removeFromPantry deletes staples and perishables by id", () => {
  const pantry = {
    staples: [
      { id: "salt", name: "Salt" },
      { id: "oil", name: "Oil" },
    ],
    perishables: [
      { id: "p1", food: "spinach" },
      { id: "p2", food: "chicken" },
    ],
  };
  assert.deepEqual(
    removeFromPantry(pantry, "staple", "salt").staples.map((s) => s.id),
    ["oil"],
  );
  assert.deepEqual(
    removeFromPantry(pantry, "perishable", "p1").perishables.map((p) => p.food),
    ["chicken"],
  );
});

test("normalizePantry self-heals stable perishable ids, deterministically", () => {
  const pantry = {
    staples: [],
    perishables: [
      { food: "spinach", added: "2026-07-20", qty: "1 bag" },
      { food: "spinach", added: "2026-07-20", qty: "1 bag" }, // identical twin
      { id: "keep", food: "chicken", added: "2026-07-19" },
    ],
  };
  const a = normalizePantry(pantry);
  const b = normalizePantry(pantry); // a second device healing the same file
  assert.ok(a.perishables.every((p) => typeof p.id === "string" && p.id.length > 0));
  // twins get DISTINCT ids; two independent heals agree exactly
  assert.notEqual(a.perishables[0].id, a.perishables[1].id);
  assert.deepEqual(
    a.perishables.map((p) => p.id),
    b.perishables.map((p) => p.id),
  );
  // an existing id is never rewritten
  assert.equal(a.perishables[2].id, "keep");
  // already-healed pantry passes through untouched (same reference)
  assert.equal(normalizePantry(a), a);
});

test("applyJustBought gives new perishables unique ids", () => {
  const shopping = {
    items: [
      { id: "spinach-g", food: "spinach", qty: 200, unit: "g", section: "produce", checked: true },
      { id: "berries-g", food: "berries", qty: 300, unit: "g", section: "produce", checked: true },
    ],
  };
  const { pantry } = applyJustBought(shopping, { staples: [], perishables: [] }, "2026-07-21");
  const ids = pantry.perishables.map((p) => p.id);
  assert.ok(ids.every((i) => typeof i === "string" && i.length > 0));
  assert.equal(new Set(ids).size, ids.length);
});

test("deriveShoppingList shops the weekly buffer batch like a planned entry", () => {
  const recipes = new Map([
    [
      "bean-tub",
      {
        id: "bean-tub",
        servings: 6,
        ingredients: [{ qty: 3, unit: "can", food: "black beans", staple: false }],
      },
    ],
  ]);
  const plan = {
    week: "2026-W28",
    entries: [],
    buffer: { recipeId: "bean-tub", portions: 6 },
  };
  const list = deriveShoppingList(plan, recipes, { staples: [], perishables: [] });
  const row = list.items.find((i) => i.food === "black beans");
  assert.ok(row, "buffer ingredients must land on the list");
  assert.equal(row.qty, 3); // 6 portions of a serves-6 batch = the full recipe
});

test("perishableStatus computes good-until and days left from the shelf-life table", () => {
  // spinach = 6 days shelf life
  const s = perishableStatus({ food: "spinach", added: "2026-07-18" }, "2026-07-20");
  assert.equal(s.goodUntil, "2026-07-24");
  assert.equal(s.daysLeft, 4);
  // last day = 0 days left, not expired
  const last = perishableStatus({ food: "salmon", added: "2026-07-17" }, "2026-07-20");
  assert.equal(last.daysLeft, 0);
  // no added date = unjudgeable
  assert.deepEqual(perishableStatus({ food: "mystery" }, "2026-07-20"), {
    goodUntil: null,
    daysLeft: null,
  });
});

test("withAutoUseSoon flags perishables in their last 3 days, preserves manual flags, never mutates", () => {
  const pantry = {
    staples: [],
    perishables: [
      { food: "spinach", added: "2026-07-18" }, // 4d left — not flagged
      { food: "chicken breast", added: "2026-07-18" }, // 2d left — flagged
      { food: "carrot", added: "2026-07-19", useSoon: true }, // manual flag kept
      { food: "mystery" }, // no date — untouched
    ],
  };
  const out = withAutoUseSoon(pantry, "2026-07-20");
  assert.equal(out.perishables[0].useSoon, undefined);
  assert.equal(out.perishables[1].useSoon, true);
  assert.equal(out.perishables[2].useSoon, true);
  assert.equal(out.perishables[3].useSoon, undefined);
  // input not mutated
  assert.equal(pantry.perishables[1].useSoon, undefined);
});

test("householdOf and pantryPathFor: household keys the shared pantry (B2)", () => {
  const profiles = [{ id: "david" }, { id: "mom" }, { id: "laurie", household: "laurie-apt" }];
  assert.equal(householdOf(profiles, "david"), "home");
  assert.equal(householdOf(profiles, "laurie"), "laurie-apt");
  assert.equal(householdOf(profiles, "ghost"), "home"); // unknown id = default
  assert.equal(pantryPathFor("home"), "households/home/pantry.json");
  assert.equal(pantryPathFor("laurie-apt"), "households/laurie-apt/pantry.json");
  assert.equal(pantryPathFor(""), "households/home/pantry.json");
  // one household = one file: david and mom resolve to the SAME pantry
  assert.equal(
    pantryPathFor(householdOf(profiles, "david")),
    pantryPathFor(householdOf(profiles, "mom")),
  );
});

test("shelf life now knows WHERE the food is, and never lengthens an unknown", () => {
  // David asked how the expiry matching works. It keyed on the food name
  // alone, so spinach was six days whether it sat in the fridge or the
  // freezer. Location is optional and its absence must behave exactly as
  // before, because expirePerishables DELETES rows on every load.
  assert.equal(shelfLifeDays("baby spinach"), 6, "no location = unchanged");
  assert.equal(shelfLifeDays("baby spinach", "fridge"), 6);
  assert.ok(shelfLifeDays("baby spinach", "freezer") > 100, "frozen greens keep for months");
  assert.equal(shelfLifeDays("chicken breast", "fridge"), 4);
  assert.equal(shelfLifeDays("chicken breast", "freezer"), 90);
  // potatoes genuinely prefer a cupboard to the fridge
  assert.ok(shelfLifeDays("potato", "pantry") > shelfLifeDays("potato", "fridge"));
  // a food the location table does not cover keeps its fridge number, never
  // a longer guess — this function deletes food
  assert.equal(shelfLifeDays("mystery item", "freezer"), shelfLifeDays("mystery item"));
  assert.equal(shelfLifeDays("greek yogurt", "freezer"), shelfLifeDays("greek yogurt"));
  // an unrecognized location falls back to the fridge, so a typo cannot
  // silently extend a chicken breast to eight months
  assert.equal(shelfLifeDays("chicken breast", "garage"), 4);
});

test("normalizePantry quarantines legacy rows as UNSORTED, never guesses fridge", () => {
  const out = normalizePantry({
    staples: [],
    perishables: [{ food: "spinach", added: "2026-07-20" }],
  });
  const p = out.perishables[0];
  assert.equal(p.location, "unsorted", "a guess of fridge would put it in a sweep's blast radius");
  assert.equal(p.group, "produce");
  assert.equal(typeof p.id, "string");
  // and it is idempotent
  assert.equal(normalizePantry(out), out);
});

test("a location sweep replaces ONLY that location, and never staples or unsorted", () => {
  const pantry = {
    staples: [{ id: "olive-oil", name: "olive oil", onHand: true, runningLow: false }],
    perishables: [
      { id: "a", food: "old milk", location: "fridge", added: "2026-07-01" },
      { id: "b", food: "peas", location: "freezer", added: "2026-07-01" },
      { id: "c", food: "mystery", location: "unsorted", added: "2026-07-01" },
    ],
  };
  const out = applySweep(pantry, "fridge", [{ food: "spinach" }, { food: "yogurt" }], "2026-07-25");

  assert.deepEqual(
    out.perishables.map((p) => p.food).sort(),
    ["mystery", "peas", "spinach", "yogurt"],
    "the fridge row is replaced; freezer and unsorted survive untouched",
  );
  assert.deepEqual(out.staples, pantry.staples, "staples are never touched by a sweep");
  const spinach = out.perishables.find((p) => p.food === "spinach");
  assert.equal(spinach.location, "fridge");
  assert.equal(spinach.group, "produce");
  assert.equal(spinach.added, "2026-07-25");

  // content-derived ids: two people sweeping the same shelf converge on one
  // row instead of duplicating it on the 409 merge
  const again = applySweep(
    pantry,
    "fridge",
    [{ food: "spinach" }, { food: "yogurt" }],
    "2026-07-25",
  );
  assert.deepEqual(
    out.perishables.map((p) => p.id).sort(),
    again.perishables.map((p) => p.id).sort(),
  );
});

test("emptyPantry can keep the permanent shelf or wipe everything", () => {
  const pantry = {
    staples: [{ id: "salt", name: "salt", onHand: true }],
    perishables: [{ id: "a", food: "spinach" }],
  };
  const kept = emptyPantry(pantry, true);
  assert.deepEqual(kept.staples, pantry.staples);
  assert.deepEqual(kept.perishables, []);

  const all = emptyPantry(pantry, false);
  assert.deepEqual(all.staples, []);
  assert.deepEqual(all.perishables, []);
});

test("SUBSTITUTE proposes swaps to MY week only, toward what the house already buys", () => {
  // Red Team vetoed the version that edits other people's plans: their
  // avoid-list may have changed since my copy synced, and a recipe arriving as
  // a plain plan entry passes no screen on their device. So this converges my
  // own week instead, which is what the ask means from the seat of the person
  // pressing the button.
  const mine = {
    id: "blue-salad",
    name: "Blue cheese salad",
    mealType: "lunch",
    servings: 1,
    nutrition: { calories: 500 },
    ingredients: [
      { qty: 50, unit: "g", food: "blue cheese" },
      { qty: 100, unit: "g", food: "baby spinach" },
    ],
  };
  const better = {
    id: "feta-salad",
    name: "Feta salad",
    mealType: "lunch",
    servings: 1,
    nutrition: { calories: 520 },
    ingredients: [
      { qty: 50, unit: "g", food: "feta cheese" },
      { qty: 100, unit: "g", food: "baby spinach" },
    ],
  };
  const wrongMeal = { ...better, id: "feta-dinner", mealType: "dinner" };
  const wrongSize = { ...better, id: "feta-huge", nutrition: { calories: 900 } };
  const pool = [mine, better, wrongMeal, wrongSize];
  const byId = new Map(pool.map((r) => [r.id, r]));

  // Mom already buys feta; only I buy blue cheese
  const combined = [
    {
      id: "blue-cheese",
      food: "blue cheese",
      qty: 50,
      unit: "g",
      section: "dairy",
      sources: [{ profileId: "david", checked: false }],
    },
    {
      id: "feta-cheese",
      food: "feta cheese",
      qty: 200,
      unit: "g",
      section: "dairy",
      sources: [{ profileId: "mom", checked: false }],
    },
    {
      id: "baby-spinach",
      food: "baby spinach",
      qty: 200,
      unit: "g",
      section: "produce",
      sources: [
        { profileId: "david", checked: false },
        { profileId: "mom", checked: false },
      ],
    },
  ];
  const entries = [
    { id: "e1", date: "2026-07-27", slot: "lunch", recipeId: "blue-salad", servings: 1 },
  ];

  const swaps = substitutionPlan(combined, "david", entries, pool, byId);
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].toId, "feta-salad", "swaps toward the cheese already in the trolley");
  assert.deepEqual(swaps[0].drops, ["blue-cheese"]);
  assert.equal(swaps[0].entryId, "e1", "and it targets MY entry");
});

test("SUBSTITUTE leaves alone what it must not touch", () => {
  const r = (id, extra = {}) => ({
    id,
    name: id,
    mealType: "lunch",
    servings: 1,
    nutrition: { calories: 500 },
    ingredients: [{ qty: 1, unit: "x", food: "blue cheese" }],
    ...extra,
  });
  const pool = [r("a"), r("b")];
  const byId = new Map(pool.map((x) => [x.id, x]));
  const combined = [
    {
      id: "blue-cheese",
      food: "blue cheese",
      qty: 1,
      unit: "x",
      section: "dairy",
      sources: [{ profileId: "david", checked: false }],
    },
  ];
  const base = { date: "2026-07-27", slot: "lunch", recipeId: "a", servings: 1 };

  // a pinned meal is a decision, an OUT slot is a restaurant, a table is the
  // house's, and none of them are mine to rewrite
  for (const guard of [{ pinned: true }, { out: true }, { table: "t1" }]) {
    assert.deepEqual(
      substitutionPlan(combined, "david", [{ id: "e", ...base, ...guard }], pool, byId),
      [],
    );
  }
  // and a swap that saves nothing is not proposed
  assert.deepEqual(substitutionPlan(combined, "david", [{ id: "e", ...base }], pool, byId), []);
});

test("a PARTIAL shop buys only the days you picked, and leaves the plan alone", () => {
  // David, 2026-07-26: guests over, fridge full, still eating to plan. Opting
  // the meals OUT was wrong because the meals are still happening; only the
  // shopping is partial.
  const recipes = new Map([
    ["a", { id: "a", servings: 1, ingredients: [{ qty: 100, unit: "g", food: "tofu" }] }],
    ["b", { id: "b", servings: 1, ingredients: [{ qty: 200, unit: "g", food: "cod" }] }],
  ]);
  const plan = {
    week: "2026-W31",
    entries: [
      { id: "1", date: "2026-07-27", slot: "dinner", recipeId: "a", servings: 1 },
      { id: "2", date: "2026-07-29", slot: "dinner", recipeId: "b", servings: 1 },
    ],
    buffer: { recipeId: "a", portions: 7 },
  };
  const pantry = { staples: [], perishables: [] };

  const monOnly = deriveShoppingList(plan, recipes, pantry, null, undefined, {
    dates: ["2026-07-27"],
  });
  assert.ok(monOnly.items.find((i) => i.food === "tofu"));
  assert.equal(
    monOnly.items.find((i) => i.food === "cod"),
    undefined,
    "Wednesday is not bought",
  );

  // the whole week still behaves exactly as before
  const all = deriveShoppingList(plan, recipes, pantry);
  assert.ok(all.items.find((i) => i.food === "cod"));
});

test("a partial shop sits the weekly buffer batch out", () => {
  const recipes = new Map([
    ["a", { id: "a", servings: 1, ingredients: [{ qty: 100, unit: "g", food: "tofu" }] }],
    ["buf", { id: "buf", servings: 1, ingredients: [{ qty: 50, unit: "g", food: "cashews" }] }],
  ]);
  const plan = {
    week: "2026-W31",
    entries: [{ id: "1", date: "2026-07-27", slot: "dinner", recipeId: "a", servings: 1 }],
    buffer: { recipeId: "buf", portions: 7 },
  };
  const pantry = { staples: [], perishables: [] };

  // a week-long stand-by batch has no business in a three-day shop
  const partial = deriveShoppingList(plan, recipes, pantry, null, undefined, {
    dates: ["2026-07-27"],
  });
  assert.equal(
    partial.items.find((i) => i.food === "cashews"),
    undefined,
  );
  // but a full build still shops it
  assert.ok(deriveShoppingList(plan, recipes, pantry).items.find((i) => i.food === "cashews"));
});

test("a partial shop can narrow to particular meals too", () => {
  const recipes = new Map([
    ["brk", { id: "brk", servings: 1, ingredients: [{ qty: 80, unit: "g", food: "rolled oats" }] }],
    ["din", { id: "din", servings: 1, ingredients: [{ qty: 200, unit: "g", food: "cod" }] }],
  ]);
  const plan = {
    week: "2026-W31",
    entries: [
      { id: "1", date: "2026-07-27", slot: "breakfast", recipeId: "brk", servings: 1 },
      { id: "2", date: "2026-07-27", slot: "dinner", recipeId: "din", servings: 1 },
    ],
  };
  const out = deriveShoppingList(plan, recipes, { staples: [], perishables: [] }, null, undefined, {
    dates: ["2026-07-27"],
    slots: ["dinner"],
  });
  assert.ok(out.items.find((i) => i.food === "cod"));
  assert.equal(
    out.items.find((i) => i.food === "rolled oats"),
    undefined,
  );
});
