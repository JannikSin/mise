import test from "node:test";
import assert from "node:assert/strict";
import { recipesById } from "../app/lib/plan.js";
import {
  deriveShoppingList,
  normalizePantry,
  sectionOf,
  packPantry,
  pantryItems,
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
  inheritsLegacyPantry,
  mergeProfileLists,
  swapCandidates,
  toStoreUnits,
  formatStoreQty,
  tripOf,
  emptyPantry,
  applySweep,
  substitutionPlan,
  locationForBuy,
  applyReceiptStock,
  consumeForCook,
  subtractPantryFromTrip,
  clearReceiptRows,
  packHint,
  normalizeShoppingList,
  cycleDayPick,
  expiryFrom,
  cartLines,
  isStapleRow,
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

test("weekly-snack mode: the buffer batch nets out planned entries of the same recipe", () => {
  // snackStyle "weekly": every planned snack IS the buffer recipe and the
  // batch `portions` already count them, so shopping both bought the week's
  // snack nearly twice (reviewer catch 2026-08-25)
  const recipes = new Map([
    ["mix", { id: "mix", servings: 1, ingredients: [{ qty: 70, unit: "g", food: "trail mix" }] }],
  ]);
  const plan = {
    week: "2026-W30",
    entries: [
      { id: "a", date: "2026-07-20", slot: "snack", recipeId: "mix", servings: 1 },
      { id: "b", date: "2026-07-22", slot: "snack", recipeId: "mix", servings: 2 },
    ],
    buffer: { recipeId: "mix", portions: 7 },
  };
  const list = deriveShoppingList(plan, recipes, { staples: [], perishables: [] });
  const row = list.items.find((i) => i.food === "trail mix");
  // 3 planned + net 4 stand-by = 7 servings x 70 g = 490 g, shelf-rounded to
  // 500 — never the 10 x 70 g = 700 the double-count bought
  assert.equal(row.qty, 500);
});

test("a buffer batch smaller than its planned entries shops nothing extra, never negative", () => {
  const recipes = new Map([
    ["mix", { id: "mix", servings: 1, ingredients: [{ qty: 70, unit: "g", food: "trail mix" }] }],
  ]);
  const plan = {
    week: "2026-W30",
    entries: [{ id: "a", date: "2026-07-20", slot: "snack", recipeId: "mix", servings: 9 }],
    buffer: { recipeId: "mix", portions: 7 },
  };
  const list = deriveShoppingList(plan, recipes, { staples: [], perishables: [] });
  // 9 planned servings x 70 g = 630 g, shelf-rounded to 650; the batch adds
  // nothing (7 - 9 clamps to 0), and never a negative pseudo-entry
  assert.equal(list.items.find((i) => i.food === "trail mix").qty, 650);
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
  // the aisle is DERIVED from the food, never carried from the list row
  // (2026-08-27). "dry-goods" is a retired bucket name: a row that kept it
  // would match no section group and silently vanish from the pantry, which
  // is the same failure normalizeShoppingList already re-derives to avoid.
  assert.equal(s.section, "other");
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

test("staple-flagged ingredients are BOUGHT unless the pantry registry owns them", () => {
  // David, 2026-08-09: "staples run out — assume I don't have it if it was
  // not in the pantry scan." The recipe author's `staple: true` guess no
  // longer suppresses buying; only pantry onHand does.
  const empty = deriveShoppingList(PLAN, RECIPES, { staples: [], perishables: [] });
  assert.ok(empty.items.find((i) => i.food === "white rice"), "unowned staple-tag is bought");
  assert.ok(empty.items.find((i) => i.food === "onion"));
  const owned = deriveShoppingList(PLAN, RECIPES, {
    staples: [
      { id: "white-rice", name: "white rice", section: "dry-goods", onHand: true, runningLow: false },
    ],
    perishables: [],
  });
  assert.equal(
    owned.items.find((i) => i.food === "white rice"),
    undefined,
    "a scanned/owned registry row still suppresses the buy",
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

test("the aisle taxonomy: the specific food beats the general keyword", () => {
  // Every case here is a real row from David's first Wayne camera scan
  // (2026-08-26), where a general keyword in an earlier rule stole the food.
  assert.equal(sectionOf("cayenne pepper"), "spices"); // produce claimed `pepper`
  assert.equal(sectionOf("black pepper"), "spices");
  assert.equal(sectionOf("red pepper flakes"), "spices");
  assert.equal(sectionOf("bell pepper"), "produce"); // the fresh one still is
  assert.equal(sectionOf("almond butter"), "condiments"); // dairy claimed `butter`
  assert.equal(sectionOf("peanut butter"), "condiments");
  assert.equal(sectionOf("unsalted butter"), "dairy"); // real butter still is
  assert.equal(sectionOf("butter beans"), "canned"); // a tin, not a dairy case
  assert.equal(sectionOf("parmesan crisps"), "snacks"); // dairy claimed `parmesan`
  assert.equal(sectionOf("almond flour crackers"), "snacks"); // baking claimed `flour`
  assert.equal(sectionOf("dark chocolate chips"), "baking"); // but these ARE baking
  assert.equal(sectionOf("dried italian herbs"), "spices"); // produce claimed `herbs`
  assert.equal(sectionOf("fresh parsley"), "produce"); // the fresh one still is
  assert.equal(sectionOf("crushed tomatoes"), "canned"); // produce claimed `tomatoes`
  assert.equal(sectionOf("tomato paste"), "canned");
  assert.equal(sectionOf("cherry tomatoes"), "produce");
});

test("the aisle taxonomy reads PLURALS, because that is what a label says", () => {
  // David, 2026-08-27: most of the fresh half of his first Wayne pantry landed
  // in OTHER. Every keyword was singular inside a word boundary, so a camera
  // that faithfully wrote "bananas" and "pumpkin seeds" classified nothing.
  for (const [singular, plural] of [
    ["banana", "bananas"],
    ["lemon", "lemons"],
    ["carrot", "carrots"],
    ["onion", "onions"],
    ["scallion", "scallions"],
    ["mushroom", "mushrooms"],
  ]) {
    assert.equal(sectionOf(plural), sectionOf(singular), `${plural} vs ${singular}`);
    assert.notEqual(sectionOf(plural), "other");
  }
  assert.equal(sectionOf("kiwi"), "produce");
  // the seeds all landed apart: chia matched `chia`, the rest matched nothing
  for (const f of ["chia seeds", "pumpkin seeds", "black sesame seeds", "hemp hearts"]) {
    assert.equal(sectionOf(f), "snacks", f);
  }
});

test("a stored pantry aisle self-heals when the taxonomy is fixed", () => {
  // Before 2026-08-27 the aisle was written once at scan time and kept behind
  // `?? aisleOf(...)`, so fixing the taxonomy could not reach a row that was
  // already wrong and rescanning the shelf was the only cure.
  const pantry = packPantry([
    { id: "cayenne-pepper", food: "cayenne pepper", section: "produce", state: "plenty" },
    { id: "abc12345", food: "bananas", qty: "1 bunch", added: "2026-08-26", group: "other" },
  ]);
  const items = pantryItems(pantry);
  assert.equal(items[0].section, "spices");
  assert.equal(items[1].group, "produce");
  // the legacy mirror the app still writes agrees with the items array
  assert.equal(pantry.staples[0].section, "spices");
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

test("a declared household starts with an EMPTY pantry, never the legacy one", () => {
  // 2026-08-26: moving into the Wayne house created households/wayne/pantry.json
  // by copying the old house's legacy root pantry, so a kitchen with bare
  // shelves reported 52 staples at "plenty" and the shopping list then refused
  // to buy them. Only the undeclared pre-B2 default describes the kitchen that
  // legacy file came from; every declared household is a NEW kitchen.
  assert.equal(inheritsLegacyPantry("home"), true);
  assert.equal(inheritsLegacyPantry(""), true); // absent household field
  assert.equal(inheritsLegacyPantry("wayne"), false);
  assert.equal(inheritsLegacyPantry("taranowski"), false);
  assert.equal(inheritsLegacyPantry("laurie-apt"), false);
  const profiles = [{ id: "david", household: "wayne" }, { id: "mom" }];
  assert.equal(inheritsLegacyPantry(householdOf(profiles, "david")), false);
  assert.equal(inheritsLegacyPantry(householdOf(profiles, "mom")), true);
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
  // one-pantry model: the staples MIRROR is re-derived on every write, so
  // compare the fields that matter rather than object identity
  assert.deepEqual(
    out.staples.map((s) => ({ id: s.id, name: s.name, onHand: s.onHand, runningLow: s.runningLow })),
    pantry.staples.map((s) => ({
      id: s.id,
      name: s.name,
      onHand: s.onHand,
      runningLow: s.runningLow,
    })),
    "state items are never touched by a sweep",
  );
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
  // mirror is re-derived: compare the meaningful fields
  assert.deepEqual(
    kept.staples.map((s) => ({ id: s.id, name: s.name, onHand: s.onHand })),
    [{ id: "salt", name: "salt", onHand: true }],
  );
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

test("FAMILY day picks: one member's partial-week derive keeps ticks + manual rows and merges with a full list", () => {
  // David, 2026-08-09: buy the first three days for mom, the whole week for
  // everyone else. Mom's contribution is re-derived from HER plan for just
  // those dates, with her stored list as `previous` so aisle ticks and manual
  // rows survive; the merge then sums as usual.
  const recipes = new Map([
    ["a", { id: "a", servings: 1, ingredients: [{ qty: 100, unit: "g", food: "tofu" }] }],
    ["b", { id: "b", servings: 1, ingredients: [{ qty: 200, unit: "g", food: "cod" }] }],
  ]);
  const momPlan = {
    week: "2026-W32",
    entries: [
      { id: "1", date: "2026-08-03", slot: "dinner", recipeId: "a", servings: 1 },
      { id: "2", date: "2026-08-06", slot: "dinner", recipeId: "b", servings: 1 },
    ],
  };
  const momStored = {
    generatedFrom: "2026-W32",
    items: [
      { id: "tofu-g", food: "tofu", qty: 100, unit: "g", section: "protein", checked: true },
      { id: "cod-g", food: "cod", qty: 200, unit: "g", section: "meat", checked: false },
      { id: "batteries-x", food: "batteries", qty: 1, unit: "x", section: "other", checked: false, manual: true },
    ],
  };
  const momPartial = deriveShoppingList(
    momPlan,
    recipes,
    { staples: [], perishables: [] },
    momStored,
    undefined,
    { dates: ["2026-08-03"] },
  );
  // Thursday's cod is out; Monday's tofu keeps its aisle tick; manual rides along
  assert.equal(
    momPartial.items.find((i) => i.food === "cod"),
    undefined,
  );
  assert.equal(momPartial.items.find((i) => i.food === "tofu")?.checked, true);
  assert.ok(momPartial.items.find((i) => i.food === "batteries"));

  const combined = mergeProfileLists([
    { profileId: "david", list: { items: [{ id: "tofu-g", food: "tofu", qty: 300, unit: "g", section: "protein", checked: false }] } },
    { profileId: "mom", list: momPartial },
  ]);
  const tofu = combined.find((i) => i.id === "tofu-g");
  assert.equal(tofu.qty, 400, "partial contribution sums into the trip like any list");
  assert.equal(tofu.sources.length, 2);
  // each source carries its OWN contribution qty: the tick write-through
  // stores what was actually shopped for that person, not their stale
  // whole-week row (which the receipt step would otherwise over-bank)
  assert.equal(tofu.sources.find((s) => s.profileId === "david").qty, 300);
  assert.equal(tofu.sources.find((s) => s.profileId === "mom").qty, 100);
  assert.equal(tofu.sources.find((s) => s.profileId === "mom").food, "tofu");
});

test("cycleDayPick: whole-week baseline, last-day guard, and malformed-week guard", () => {
  const all = ["2026-08-03", "2026-08-04", "2026-08-05"];
  // first un-tap starts from the whole week
  assert.deepEqual(cycleDayPick([], all, "2026-08-04"), ["2026-08-03", "2026-08-05"]);
  // re-lighting the last dark day normalises back to whole week ([])
  assert.deepEqual(cycleDayPick(["2026-08-03", "2026-08-05"], all, "2026-08-04"), []);
  // un-tapping the only lit day also resets to whole week, never to zero days
  assert.deepEqual(cycleDayPick(["2026-08-03"], all, "2026-08-03"), []);
  // a malformed weekId yields no dates: the tap is ignored, not normalised
  assert.equal(cycleDayPick([], [], "2026-08-03"), null);
});

test("locationForBuy: frozen goes to the freezer, fresh to the fridge, the rest to the pantry", () => {
  assert.equal(locationForBuy("frozen"), "freezer");
  assert.equal(locationForBuy("produce"), "fridge");
  assert.equal(locationForBuy("meat"), "fridge");
  assert.equal(locationForBuy("dairy"), "fridge");
  assert.equal(locationForBuy("grains"), "pantry");
  assert.equal(locationForBuy("canned"), "pantry");
});

test("applyJustBought: bought food lands on a real shelf, never unsorted", () => {
  const shopping = {
    items: [
      { id: "spinach-g", food: "spinach", qty: 200, unit: "g", section: "produce", checked: true },
      { id: "peas-g", food: "peas", qty: 500, unit: "g", section: "frozen", checked: true },
      { id: "rice-g", food: "rice", qty: 1000, unit: "g", section: "grains", checked: true },
    ],
  };
  const out = applyJustBought(shopping, { staples: [], perishables: [] }, "2026-07-26");
  const at = (food) => out.pantry.perishables.find((p) => p.food === food).location;
  assert.equal(at("spinach"), "fridge");
  assert.equal(at("peas"), "freezer");
  assert.equal(at("rice"), "pantry");
});

test("applyReceiptStock: receipt lines empty the list and stock the shelves", () => {
  const shopping = {
    items: [
      { id: "chicken-thigh-g", food: "chicken thigh", qty: 900, unit: "g", section: "meat", checked: false },
      { id: "rice-g", food: "rice", qty: 1000, unit: "g", section: "grains", checked: false },
    ],
  };
  const out = applyReceiptStock(
    shopping,
    { staples: [], perishables: [] },
    [{ name: "chicken thigh" }, { name: "rice" }],
    "2026-07-26",
  );
  assert.deepEqual(out.shopping.items, []);
  assert.deepEqual(
    out.pantry.perishables.map((p) => p.food).sort(),
    ["chicken thigh", "rice"],
  );
});

test("applyReceiptStock: a row ticked in the aisle but missed by the scan still counts as bought", () => {
  const shopping = {
    items: [
      { id: "milk-ml", food: "milk", qty: 1000, unit: "ml", section: "dairy", checked: true },
      { id: "oats-g", food: "rolled oats", qty: 500, unit: "g", section: "grains", checked: false },
    ],
  };
  const out = applyReceiptStock(shopping, { staples: [], perishables: [] }, [{ name: "milk" }], "2026-07-26");
  assert.deepEqual(
    out.shopping.items.map((i) => i.food),
    ["rolled oats"],
  );
});

test("consumeForCook: cooking subtracts the meal from the shelf and leaves the rest", () => {
  const pantry = {
    staples: [{ id: "olive-oil", name: "Olive oil", onHand: true }],
    perishables: [
      { id: "a", food: "chicken thigh", qty: "900 g", added: "2026-07-25", location: "fridge" },
    ],
  };
  const out = consumeForCook(pantry, [
    { food: "chicken thigh", qty: 300, unit: "g" },
    { food: "olive oil", qty: 1, unit: "tbsp", staple: true },
  ]);
  assert.equal(out.pantry.perishables.length, 1);
  assert.equal(out.pantry.perishables[0].qty, "600 g");
  // staples are never decremented — onHand is what stops the list re-buying them
  assert.equal(out.pantry.staples[0].onHand, true);
});

test("consumeForCook: a finished row leaves, and the shortfall carries to the next pack", () => {
  const pantry = {
    perishables: [
      { id: "old", food: "chicken thigh", qty: "200 g", added: "2026-07-20", location: "fridge" },
      { id: "new", food: "chicken thigh", qty: "900 g", added: "2026-07-25", location: "fridge" },
    ],
  };
  const out = consumeForCook(pantry, [{ food: "chicken thigh", qty: 500, unit: "g" }]);
  assert.deepEqual(
    out.pantry.perishables.map((p) => p.id),
    ["new"],
  );
  assert.equal(out.pantry.perishables[0].qty, "600 g");
  assert.deepEqual(out.used, ["chicken thigh"]);
});

test("consumeForCook: a free-text quantity is removed, never fake-subtracted", () => {
  const pantry = {
    perishables: [{ id: "c", food: "cabbage", qty: "half a head", added: "2026-07-25", location: "fridge" }],
  };
  const out = consumeForCook(pantry, [{ food: "cabbage", qty: 0.5, unit: "head" }]);
  assert.deepEqual(out.pantry.perishables, []);
  assert.deepEqual(out.used, ["cabbage"]);
});

test("consumeForCook: food that is not on any shelf changes nothing", () => {
  const pantry = { perishables: [{ id: "a", food: "spinach", qty: "200 g", added: "2026-07-25" }] };
  const out = consumeForCook(pantry, [{ food: "salmon", qty: 200, unit: "g" }]);
  assert.equal(out.pantry, pantry);
  assert.deepEqual(out.used, []);
});

// ---- fridge-first trips (David 2026-08-01: "only buy stuff that we need") ----

const tripItem = (id, food, qty, unit, extra = {}) => ({
  id,
  food,
  qty,
  unit,
  section: "meat",
  checked: false,
  manual: false,
  ...extra,
});

test("subtractPantryFromTrip: a fully covered row leaves the buy list honestly", () => {
  const pantry = { perishables: [{ food: "chicken thigh", qty: "600 g", added: "2026-07-30" }] };
  const { toBuy, covered } = subtractPantryFromTrip(
    [tripItem("chicken-thigh", "chicken thigh", 500, "g")],
    pantry,
  );
  assert.equal(toBuy.length, 0);
  assert.equal(covered.length, 1);
  assert.equal(covered[0].food, "chicken thigh");
});

test("subtractPantryFromTrip: partial cover reduces the buy and flags the row", () => {
  const pantry = { perishables: [{ food: "chicken thigh", qty: "200 g", added: "2026-07-30" }] };
  const { toBuy, covered } = subtractPantryFromTrip(
    [tripItem("chicken-thigh", "chicken thigh", 500, "g")],
    pantry,
  );
  assert.equal(covered.length, 0);
  assert.equal(toBuy.length, 1);
  assert.ok(toBuy[0].qty < 500 && toBuy[0].qty >= 300, `re-rounded remainder, got ${toBuy[0].qty}`);
  assert.equal(toBuy[0].kitchenHas, true);
});

test("subtractPantryFromTrip: free-text pantry quantities never fake-subtract", () => {
  const pantry = { perishables: [{ food: "chicken thigh", qty: "half a pack", added: "2026-07-30" }] };
  const { toBuy, covered } = subtractPantryFromTrip(
    [tripItem("chicken-thigh", "chicken thigh", 500, "g")],
    pantry,
  );
  assert.equal(covered.length, 0);
  assert.equal(toBuy[0].qty, 500, "cannot count it, so the full buy stands");
  assert.equal(toBuy[0].kitchenHas, undefined);
});

test("subtractPantryFromTrip: unit-x rows (manual, running-low staples) never reduce", () => {
  const pantry = { perishables: [{ food: "batteries", qty: "4 x", added: "2026-07-30" }] };
  const { toBuy } = subtractPantryFromTrip(
    [tripItem("batteries-x", "batteries", 1, "x", { manual: true })],
    pantry,
  );
  assert.equal(toBuy.length, 1);
  assert.equal(toBuy[0].qty, 1);
});

test("subtractPantryFromTrip: two rows of one food cannot both claim the same pack", () => {
  const pantry = { perishables: [{ food: "chicken thigh", qty: "500 g", added: "2026-07-30" }] };
  const { toBuy, covered } = subtractPantryFromTrip(
    [
      tripItem("a", "chicken thigh", 400, "g"),
      tripItem("b", "chicken thigh", 300, "g"),
    ],
    pantry,
  );
  assert.equal(covered.length, 1, "the first row eats 400 of the 500");
  assert.equal(toBuy.length, 1);
  assert.ok(toBuy[0].qty >= 200 && toBuy[0].qty < 300, `only 100 g remained for row b, got ${toBuy[0].qty}`);
});

test("subtractPantryFromTrip: stored lists are untouched (render-time contract)", () => {
  const items = [tripItem("chicken-thigh", "chicken thigh", 500, "g")];
  const pantry = { perishables: [{ food: "chicken thigh", qty: "600 g", added: "2026-07-30" }] };
  subtractPantryFromTrip(items, pantry);
  assert.equal(items[0].qty, 500, "input rows are never mutated");
  assert.equal(pantry.perishables[0].qty, "600 g", "the pantry is never mutated");
});

test("applyJustBought banks the pantry-REDUCED qty, never phantom stock", () => {
  // kitchen already held 200 g; the rendered trip said BUY 300 g; ticking and
  // banking must record 300, not the stored row's 500 — or next week's
  // fridge-first pass sees 700 g on record for 500 g of real chicken and
  // under-buys (code-review 2026-08-01, HIGH #1)
  const shopping = {
    generatedFrom: "2026-W32",
    items: [tripItem("chicken-thigh", "chicken thigh", 500, "g", { checked: true })],
  };
  const pantry = {
    staples: [],
    perishables: [{ id: "p1", food: "chicken thigh", qty: "200 g", added: "2026-07-30" }],
  };
  const r = applyJustBought(shopping, pantry, "2026-08-01", { fridgeFirst: true });
  const rows = r.pantry.perishables.filter((p) => p.food === "chicken thigh");
  assert.equal(rows.length, 2, "old pack stays, one new pack lands");
  const banked = rows.find((p) => p.id !== "p1");
  assert.equal(banked.qty, "300 g");
  // and a row the kitchen fully covered banks NOTHING — the tick meant
  // "have enough", not "bought another"
  const covered = applyJustBought(
    { generatedFrom: "2026-W32", items: [tripItem("a", "chicken thigh", 150, "g", { checked: true })] },
    pantry,
    "2026-08-01",
  
    { fridgeFirst: true },
  );
  assert.equal(covered.pantry.perishables.length, 1, "nothing new banked");
  assert.equal(covered.shopping.items.length, 0, "the ticked row still leaves the list");
});

test("clearReceiptRows: the receipt exits matching rows from a housemate's list", () => {
  const list = {
    generatedFrom: "2026-W32",
    items: [
      tripItem("chicken-thigh", "chicken thigh", 500, "g"),
      tripItem("rolled-oats", "rolled oats", 400, "g"),
      tripItem("tuna-can", "tuna", 2, "can", { checked: true }), // aisle-ticked
    ],
  };
  const { list: next, changed } = clearReceiptRows(list, [{ name: "chicken thigh" }]);
  assert.equal(changed, true);
  assert.deepEqual(
    next.items.map((i) => i.id),
    ["rolled-oats"],
    "receipt-matched AND already-ticked rows leave; the rest stay",
  );
  // nothing matched, nothing ticked = no write churn
  const untouched = clearReceiptRows(
    { generatedFrom: "2026-W32", items: [tripItem("a", "farro", 300, "g")] },
    [{ name: "chicken thigh" }],
  );
  assert.equal(untouched.changed, false);
});

test("packHint: store-pack language for shelf quantities", () => {
  assert.equal(packHint("baby spinach", 280, "g"), "≈ 2 bags");
  assert.equal(packHint("cabbage", 900, "g"), "≈ 1 head");
  assert.equal(packHint("garlic", 12, "clove"), "≈ 2 heads");
  assert.equal(packHint("greek yogurt", 1.8, "kg"), "≈ 2 32 oz tubs");
  assert.equal(packHint("milk", 1.9, "L"), "≈ 1 half-gallon");
  assert.equal(packHint("chicken thigh", 900, "g"), "", "meat has no pack language — lb display already covers it");
  assert.equal(packHint("tuna", 2, "can"), "", "counted units need no hint");
  assert.equal(packHint("rice", 20000, "g"), "", "a silly pack count says nothing rather than shouting");
});

test("HOUSEHOLD REGRESSION (Red Team R1): the merged trip banks exactly what was bought", () => {
  // 4 profiles, 500 g chicken each = 2000 g summed; the shelf holds 500 g.
  // The FAMILY tab renders BUY 1500 g; the receipt must bank 1500 g — not 0,
  // not 2000. This is the 4-person topology the app actually ships into.
  const lists = ["david", "laurie", "mom", "dad"].map((profileId) => ({
    profileId,
    list: {
      generatedFrom: "2026-W32",
      items: [tripItem("chicken-thigh", "chicken thigh", 500, "g")],
    },
  }));
  const pantry = {
    staples: [],
    perishables: [{ id: "p1", food: "chicken thigh", qty: "500 g", added: "2026-07-30" }],
  };
  const merged = mergeProfileLists(lists);
  assert.equal(merged[0].qty, 2000, "the FAMILY row is the four portions summed");
  const trip = subtractPantryFromTrip(merged, pantry);
  assert.equal(`${trip.toBuy[0].qty} ${trip.toBuy[0].unit}`, "1.5 kg", "the trip says buy 1.5 kg");
  // receipt time: bank ONCE from the merged trip (main.js handleReceiptApprove shape)
  const mergedList = {
    generatedFrom: "2026-W32",
    items: merged.map((i) => ({ ...i, checked: false, manual: false })),
  };
  const stocked = applyReceiptStock(mergedList, pantry, [{ name: "chicken thigh" }], "2026-08-02");
  const rows = stocked.pantry.perishables.filter((p) => p.food === "chicken thigh");
  const banked = rows.find((p) => p.id !== "p1");
  assert.equal(banked.qty, "1.5 kg", "banked === bought");
  assert.equal(rows.length, 2, "old pack + the one new pack");
  // and each housemate's list clears without banking anything further
  for (const l of lists) {
    const { list: cleared } = clearReceiptRows(l.list, [{ name: "chicken thigh" }]);
    assert.equal(cleared.items.length, 0);
  }
});

test("household manual ADD TO PANTRY banks verbatim (no per-portion re-subtraction)", () => {
  // one member's 500 g portion of the merged trip must not be re-reduced
  // against the shared 500 g shelf on their own device — that banked 0 for
  // all four members while the fridge filled
  const shopping = {
    generatedFrom: "2026-W32",
    items: [tripItem("chicken-thigh", "chicken thigh", 500, "g", { checked: true })],
  };
  const pantry = {
    staples: [],
    perishables: [{ id: "p1", food: "chicken thigh", qty: "500 g", added: "2026-07-30" }],
  };
  const r = applyJustBought(shopping, pantry, "2026-08-02"); // default: verbatim
  const banked = r.pantry.perishables.find((p) => p.id !== "p1");
  assert.equal(banked.qty, "500 g");
});

test("BANKED FOOD ROUND-TRIPS (Tribunal B1): next week's need subtracts from a kg pack", () => {
  // the receipt banks the summed trip as "1.5 kg" of a food FOOD_UNITS never
  // heard of; next week's 500 g need must see it as covered, and cooking
  // must decrement it instead of deleting the pack as unmeasurable
  const pantry = {
    staples: [],
    perishables: [{ id: "k1", food: "zz-mystery-cut", qty: "1.5 kg", added: "2026-08-02" }],
  };
  const { toBuy, covered } = subtractPantryFromTrip(
    [tripItem("zz-mystery-cut", "zz-mystery-cut", 500, "g")],
    pantry,
  );
  assert.equal(toBuy.length, 0);
  assert.equal(covered.length, 1, "1.5 kg on the shelf covers a 500 g need");
  const cooked = consumeForCook(pantry, [{ food: "zz-mystery-cut", qty: 500, unit: "g" }]);
  const left = cooked.pantry.perishables.find((p) => p.id === "k1");
  assert.ok(left, "cooking 500 g must not delete the whole pack");
  assert.equal(left.qty, "1 kg");
});

test("PER-SOURCE BOUGHT (Tribunal B2): a solo-tab tick banks one portion, not four", () => {
  // David ticks his own 500 g row on his personal tab; the receipt reads only
  // eggs. Only HIS portion banks; the other three rows are neither banked nor
  // cleared. (mirrors main.js handleReceiptApprove's boughtOf + merge shape)
  const lists = ["david", "laurie", "mom", "dad"].map((profileId) => ({
    profileId,
    list: {
      items: [
        tripItem("chicken-thigh", "chicken thigh", 500, "g", {
          checked: profileId === "david",
        }),
      ],
    },
  }));
  const bought = lists.map(({ profileId, list }) => ({
    profileId,
    list: { items: list.items.filter((i) => i.checked) },
  }));
  const merged = mergeProfileLists(bought);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].qty, 500, "only the portion whose own list bought it");
  const r = applyJustBought(
    { items: merged.map((i) => ({ ...i, checked: true, manual: false })) },
    { staples: [], perishables: [] },
    "2026-08-02",
    { fridgeFirst: true },
  );
  assert.equal(r.pantry.perishables[0].qty, "500 g");
  // and clearReceiptRows leaves the untouched housemates' rows alone
  const { changed } = clearReceiptRows(lists[1].list, [{ name: "eggs" }]);
  assert.equal(changed, false);
});

test("count units display as ×N — never 'each' (David 2026-08-02)", () => {
  // "banana 7 each" read as per-person/per-serving; it was always the week's
  // total. ×7 leaves nothing to interpret.
  assert.equal(formatStoreQty(7, "each"), "×7");
  assert.equal(formatStoreQty(1, "x"), "×1");
  assert.equal(formatStoreQty(2, "can"), "2 can", "real container words stay");
});

test("normalize preserves -famdinners rows: no merge, no qty corruption, rebuild-proof", () => {
  // code review 2026-08-02 HIGH #1: re-keying stripped the suffix, merged the
  // batch into the plain derived row as "2 g" of chicken, and the next
  // rebuild deleted the dinners silently
  const list = {
    generatedFrom: "2026-W32",
    items: [
      tripItem("chicken-thigh-g", "chicken thigh", 800, "g"),
      tripItem("chicken-thigh-g-famdinners", "chicken thigh", 1200, "g", { manual: true }),
    ],
  };
  const n = normalizeShoppingList(list);
  const ids = (n?.items ?? []).map((i) => i.id).sort();
  assert.equal(ids.length, 2, "two distinct rows survive");
  assert.ok(ids.some((id) => id.endsWith("-famdinners")), "the discriminator survives re-keying");
  const fam = (n?.items ?? []).find((i) => i.id.endsWith("-famdinners"));
  assert.equal(fam.manual, true);
});

test("normalize merge keeps the promoted unit (2000 g is 2 kg, never '2 g')", () => {
  const list = {
    generatedFrom: "2026-W32",
    items: [
      { id: "old-key-a", food: "chicken thigh", qty: 800, unit: "g", section: "meat", checked: false, manual: false },
      { id: "old-key-b", food: "chicken thigh", qty: 1200, unit: "g", section: "meat", checked: false, manual: false },
    ],
  };
  const n = normalizeShoppingList(list);
  const row = (n?.items ?? []).find((i) => i.food === "chicken thigh");
  assert.ok(row, "rows merged");
  assert.equal(`${row.qty} ${row.unit}`, "2 kg");
});

// --- the shared pot is shopped from the BANK, never a personal variant -----
// David, 2026-08-10 (found by the Tribunal). deriveShoppingList resolves an
// entry's recipeId through the MERGED pool, where a profile's own variant wins
// by id. The shared-table pot line carries the bank recipe's id, so when the
// buyer owned a same-id variant the HOUSE was shopped from that one person's
// smaller plate, scaled by a seat total computed from the bank's calories.
// 17 of mom's 27 seated meals were this case.

test("a pot line resolves to the bank recipe even when the shopper owns a variant", () => {
  const bankRecipe = {
    id: "kofta",
    servings: 2,
    ingredients: [{ qty: 800, unit: "g", food: "ground beef" }],
    nutrition: { calories: 842, protein: 46 },
  };
  // the buyer's personal, smaller version of the same dish
  const ownVariant = {
    id: "kofta",
    servings: 2,
    ingredients: [{ qty: 300, unit: "g", food: "ground beef" }],
    nutrition: { calories: 480, protein: 30 },
  };
  const merged = recipesById([ownVariant]); // mergeRecipePool: own wins by id
  const bank = recipesById([bankRecipe]);
  const potPlan = {
    week: "2026-W30",
    entries: [
      /** @type {any} */ ({
        id: "pot",
        date: "2026-07-24",
        slot: "dinner",
        recipeId: "kofta",
        servings: 4,
        potFromBank: true,
      }),
    ],
  };
  const withBank = deriveShoppingList(potPlan, merged, { staples: [], perishables: [] }, null, undefined, undefined, bank);
  const beef = withBank.items.find((i) => /beef/.test(i.food));
  // 4 servings of a 2-serving bank recipe = 2x800 g, canonicalized to kg
  const legacy = deriveShoppingList(potPlan, merged, { staples: [], perishables: [] }, null);
  const legacyBeef = legacy.items.find((i) => /beef/.test(i.food));
  // the list picks kg or g by magnitude, so compare in grams
  const grams = (/** @type {any} */ i) => Number(i?.qty) * (i?.unit === "kg" ? 1000 : 1);
  assert.equal(grams(beef), 1600, "the house pot must be bought at bank quantities");
  assert.equal(grams(legacyBeef), 600, "without the bank map the old behaviour is unchanged");
});

test("a person's OWN plan entry still resolves to their variant", () => {
  // the other half of the contract: only POT lines are bank-resolved. Her own
  // dinner is correctly her 300 g version, which is the entire point of variants.
  const bankRecipe = {
    id: "kofta",
    servings: 2,
    ingredients: [{ qty: 800, unit: "g", food: "ground beef" }],
    nutrition: { calories: 842, protein: 46 },
  };
  const ownVariant = { ...bankRecipe, ingredients: [{ qty: 300, unit: "g", food: "ground beef" }] };
  const list = deriveShoppingList(
    {
      week: "2026-W30",
      entries: [
        /** @type {any} */ ({
          id: "mine",
          date: "2026-07-24",
          slot: "dinner",
          recipeId: "kofta",
          servings: 2,
        }),
      ],
    },
    recipesById([ownVariant]),
    { staples: [], perishables: [] },
    null,
    undefined,
    undefined,
    recipesById([bankRecipe]),
  );
  assert.equal(list.items.find((i) => /beef/.test(i.food))?.qty, 300);
});

// ---- ONE PANTRY (fix list 1.1, council 2026-08-18): the garlic scenario ----

test("THE GARLIC FIX: an OUT item goes on the list the moment a recipe needs it", () => {
  const recipes = new Map([
    [
      "stir-fry",
      {
        id: "stir-fry",
        servings: 1,
        ingredients: [{ qty: 3, unit: "clove", food: "garlic" }],
      },
    ],
  ]);
  const plan = {
    week: "2026-W34",
    entries: [{ id: "e1", date: "2026-08-19", slot: "dinner", recipeId: "stir-fry", servings: 1 }],
  };
  // the old model: garlic was a staple with onHand true, so it NEVER reached
  // the list, even after it ran out. New model: only an explicit "plenty"
  // suppresses; an item with no state buys like anything else.
  const out = { items: [{ id: "garlic", food: "garlic" }] }; // state: none = OUT
  const plenty = { items: [{ id: "garlic", food: "garlic", state: "plenty" }] };
  const low = { items: [{ id: "garlic", food: "garlic", state: "low" }] };

  const bought = deriveShoppingList(plan, recipes, out);
  assert.ok(
    bought.items.some((i) => i.food === "garlic"),
    "OUT garlic must be bought when a recipe needs it",
  );
  const skipped = deriveShoppingList(plan, recipes, plenty);
  assert.ok(
    !skipped.items.some((i) => i.food === "garlic"),
    "PLENTY suppresses, explicitly and per item",
  );
  const forced = deriveShoppingList({ week: "2026-W34", entries: [] }, recipes, low);
  assert.ok(
    forced.items.some((i) => i.food === "garlic" && i.unit === "x"),
    "LOW re-enters the list even when no recipe needs it",
  );
});

test("one-pantry migration: legacy staples become state items, perishables stay tracked", () => {
  const legacy = {
    staples: [
      { id: "garlic", name: "garlic", section: "produce", onHand: true, runningLow: false },
      { id: "soy-sauce", name: "soy sauce", onHand: true, runningLow: true },
      { id: "gone", name: "saffron", onHand: false, runningLow: false },
    ],
    perishables: [{ food: "chicken breast", qty: "500 g", added: "2026-08-17" }],
  };
  const packed = normalizePantry(legacy);
  const byId = new Map(packed.items.map((it) => [it.id, it]));
  assert.equal(byId.get("garlic").state, "plenty");
  assert.equal(byId.get("soy-sauce").state, "low", "runningLow wins over onHand");
  assert.equal(byId.get("gone").state, undefined, "not on hand = OUT, no assertion");
  const chicken = packed.items.find((it) => it.food === "chicken breast");
  assert.ok(chicken.added, "tracked rows keep their date");
  // mirrors for old devices
  assert.equal(packed.staples.length, 3);
  assert.equal(packed.perishables.length, 1);
});

test("state items are never deleted by cooking, tracked rows are consumed", () => {
  const pantry = normalizePantry({
    items: [
      { id: "garlic", food: "garlic", state: "plenty" },
      { id: "c1", food: "chicken breast", qty: "600 g", added: "2026-08-17", location: "fridge" },
    ],
  });
  const { pantry: out } = consumeForCook(pantry, [
    { food: "garlic", qty: 3, unit: "clove" },
    { food: "chicken breast", qty: 250, unit: "g" },
  ]);
  assert.ok(
    out.items.some((it) => it.id === "garlic" && it.state === "plenty"),
    "a plenty assertion has no quantity and must survive cooking",
  );
  const chicken = out.items.find((it) => it.food === "chicken breast");
  assert.equal(chicken.qty, "350 g");
});

test("mirror reconcile: an old device's mirror-only edits are absorbed into items", () => {
  // a packed pantry after a 409 merge where an OLD device (a) toggled soy
  // sauce runningLow via the staples mirror, (b) scanned a new perishable
  // that exists only in the perishables mirror, (c) edited chicken's qty in
  // the mirror. New code must absorb all three, or the merge silently loses
  // the old device's work (diff reviewer, 2026-08-18).
  const merged = {
    items: [
      { id: "soy-sauce", food: "soy sauce", state: "plenty" },
      { id: "c1", food: "chicken breast", qty: "600 g", added: "2026-08-17", location: "fridge", group: "meat" },
    ],
    staples: [
      { id: "soy-sauce", name: "soy sauce", section: "condiments", onHand: true, runningLow: true },
    ],
    perishables: [
      { id: "c1", food: "chicken breast", qty: "250 g", added: "2026-08-17", location: "fridge", group: "meat" },
      { id: "n1", food: "greek yogurt", qty: "500 g", added: "2026-08-18", location: "fridge", group: "dairy" },
    ],
  };
  const out = normalizePantry(merged);
  const byId = new Map(out.items.map((it) => [it.id, it]));
  assert.equal(byId.get("soy-sauce").state, "low", "old device's LOW toggle absorbed");
  assert.equal(byId.get("c1").qty, "250 g", "old device's qty edit wins (edited side wins)");
  assert.ok(byId.get("n1"), "old device's new scan row absorbed");
  // and a CONSISTENT packed pantry still passes through by reference
  assert.equal(normalizePantry(out), out, "settled fast-path survives the reconcile");
});

// ---- stamped expiry (PF.3: make `expires` real, 2026-08-19) -----------------

test("applyJustBought stamps `expires` at buy time from shelf life and location", () => {
  const list = { items: [{ id: "x1", food: "chicken breast", qty: 2, unit: "lb", section: "meat", checked: true, manual: false }] };
  const { pantry } = applyJustBought(list, { items: [] }, "2026-08-19");
  const row = pantry.items.find((i) => i.food === "chicken breast");
  assert.equal(row.expires, expiryFrom("2026-08-19", "chicken breast", row.location));
  assert.equal(row.expires, "2026-08-23", "chicken keeps 4 fridge days");
});

test("expirePerishables prefers the stamped expiry over the regex estimate", () => {
  // regex says cheese keeps 28 days, but the stamped date (hand-corrected or
  // stamped at buy) says it died yesterday — the stamp wins
  const pantry = { items: [
    { id: "a", food: "cheddar cheese", qty: "1 block", added: "2026-08-18", expires: "2026-08-18", location: "fridge" },
    { id: "b", food: "cheddar cheese", qty: "1 block", added: "2026-08-18", location: "fridge" },
  ] };
  const { pantry: next, expired } = expirePerishables(pantry, "2026-08-19");
  assert.deepEqual(expired, ["cheddar cheese"], "only the stamped row expired");
  assert.deepEqual(next.items.map((i) => i.id), ["b"]);
});

test("perishableStatus reads the stamped expiry when present", () => {
  const stamped = { food: "spinach", added: "2026-08-10", expires: "2026-08-21", location: "fridge" };
  assert.deepEqual(perishableStatus(stamped, "2026-08-19"), { goodUntil: "2026-08-21", daysLeft: 2 });
  const legacy = { food: "spinach", added: "2026-08-16", location: "fridge" };
  assert.equal(perishableStatus(legacy, "2026-08-19").goodUntil, "2026-08-22", "regex fallback unchanged");
});

// THE SEVEN BROCCOLIS (David, 2026-08-24: "last time I ended up with like
// seven things of frozen broccoli"). Both halves of that bug get a test.
test("rows sharing ONE product become ONE cart line, not seven", () => {
  const items = [
    { food: "broccoli", qty: 340, unit: "g" },
    { food: "broccoli florets", qty: 340, unit: "g" },
    { food: "frozen broccoli", qty: 340, unit: "g" },
  ];
  const lines = cartLines(items, () => "0001111041700", () => 1);
  assert.equal(lines.length, 1, "three rows on one UPC must send one line");
  assert.equal(lines[0].quantity, 3, "and carry the summed count, not three lines of 1");
});

test("quantity is the REAL pack count, never a hard-coded 1", () => {
  // 900 g of broccoli against a 12 oz bag is three bags, not one
  const lines = cartLines([{ food: "broccoli", qty: 900, unit: "g" }], () => "u1", () => 3);
  assert.equal(lines[0].quantity, 3);
});

test("an unpriced row still orders one package rather than vanishing", () => {
  const lines = cartLines([{ food: "saffron", qty: 2, unit: "g" }], () => "u1", () => null);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 1);
});

test("checked and unpinned rows never reach the cart", () => {
  const lines = cartLines(
    [
      { food: "broccoli", qty: 1, unit: "each", checked: true },
      { food: "unpinned thing", qty: 1, unit: "each" },
    ],
    (f) => (f === "broccoli" ? "u1" : null),
    () => 1,
  );
  assert.deepEqual(lines, []);
});

test("a line is clamped to what Kroger will accept", () => {
  const lines = cartLines([{ food: "x", qty: 1, unit: "each" }], () => "u1", () => 500);
  assert.equal(lines[0].quantity, 99);
});

test("isStapleRow: stock-up shelf rows are staples, this week's food is not", () => {
  const cat = {
    stores: ["pay-less"],
    items: [
      { id: "salt", name: "salt", prices: { "pay-less": { price: 0.89, size: "26 oz" } } },
      {
        id: "crushed-tomatoes",
        name: "crushed tomatoes",
        prices: { "pay-less": { price: 1.0, size: "15 oz" } },
      },
      { id: "milk", name: "milk", prices: { "pay-less": { price: 3.29, size: "1 gal" } } },
    ],
  };
  // a tsp of a 26 oz jar: nearly all of it is stock — staple
  assert.equal(
    isStapleRow({ food: "salt", qty: 2.75, unit: "tsp", section: "spices" }, cat, "pay-less"),
    true,
  );
  // six cans cooked into this week's pots: this week's food, same aisle or not
  assert.equal(
    isStapleRow({ food: "crushed tomatoes", qty: 6, unit: "can", section: "canned" }, cat, "pay-less"),
    false,
  );
  // fresh aisles are never staples, whatever the fraction
  assert.equal(
    isStapleRow({ food: "milk", qty: 1, unit: "cup", section: "dairy" }, cat, "pay-less"),
    false,
  );
  // frozen cannot ride a bulk order either
  assert.equal(
    isStapleRow({ food: "frozen blueberries", qty: 1, unit: "cup", section: "frozen" }, cat, "pay-less"),
    false,
  );
  // an unpriced shelf-stable row (creatine, matcha) is exactly the bulk-order kind
  assert.equal(
    isStapleRow({ food: "creatine monohydrate", qty: 35, unit: "g", section: "pantry" }, cat, "pay-less"),
    true,
  );
});
