// USE WHAT YOU HAVE, OR ARE ALREADY BUYING (swaps.js). David, 2026-11-07:
// "the whole point of the mise app is to make changes to recipies to uswe
// ingridients you already have or already are buying."
import test from "node:test";
import assert from "node:assert/strict";
import { assignSwaps, namedFor, swapNote, withSwaps } from "../app/lib/swaps.js";

const muffin = {
  id: "muffin",
  name: "Double Chocolate Protein Muffins",
  servings: 6,
  nutrition: { calories: 512, protein: 28, carbs: 60, fat: 21 },
  ingredients: [
    { food: "cottage cheese", qty: 300, unit: "g" },
    { food: "greek yogurt", qty: 150, unit: "g" },
    { food: "almond butter", qty: 45, unit: "g", note: "this is the butter of the recipe" },
    { food: "walnuts", qty: 40, unit: "g" },
    { food: "chocolate chips", qty: 60, unit: "g" },
    { food: "cocoa powder", qty: 25, unit: "g" },
  ],
};

const PRICES = /** @type {Record<string, number>} */ ({
  "cottage cheese": 4.99, // a 24 oz tub
  "greek yogurt": 4.39, // a 24 oz tub
  "almond butter": 7.99,
  "chocolate chips": 3.99,
  walnuts: 6.99,
  dates: 5.49,
});
// whole packages: 680 g tubs for the dairy, one jar or bag for the rest
const priceNeed = (/** @type {string} */ food, /** @type {number} */ g) => {
  const p = PRICES[food] ?? 0;
  const pack = /yogurt|cottage/.test(food) ? 680 : 340;
  return g <= 0 ? 0 : p * Math.ceil(g / pack);
};

/** seven daily snack tables of the one muffin batch, two people */
function week(/** @type {Record<string, any>} */ extra = {}) {
  const dates = [
    "2026-11-15",
    "2026-11-16",
    "2026-11-17",
    "2026-11-18",
    "2026-11-19",
    "2026-11-20",
    "2026-11-21",
  ];
  const tables = dates.map((date) => ({
    id: `snack-${date}`,
    date,
    slot: "snack",
    recipeId: "muffin",
    seats: [
      { id: "david", servings: 2 },
      { id: "elliot", servings: 0.75 },
    ],
    ...extra,
  }));
  const report = dates.flatMap((date) => [
    {
      date,
      seatId: "david",
      kcal: 2800,
      protein: 140,
      dayKcal: 3700,
      dayProtein: 210,
      share: 1,
      status: "band",
    },
    {
      date,
      seatId: "elliot",
      kcal: 1900,
      protein: 95,
      dayKcal: 2850,
      dayProtein: 165,
      share: 1,
      status: "band",
    },
  ]);
  return { tables, report, fresh: new Set(tables.map((t) => t.id)) };
}
const targetsById = new Map([
  [
    "david",
    {
      macros: { calories: 3700, caloriesFloor: 3500, protein: 190, proteinCeiling: 215 },
      avoidIngredients: ["salmon", "tempeh"],
    },
  ],
  [
    "elliot",
    { macros: { calories: 2850, protein: 145 }, avoidIngredients: ["peanut", "tempeh", "pesto"] },
  ],
]);
const OWNED = new Set(["walnuts", "dates"]);
const held = (/** @type {string} */ food) => OWNED.has(food);

test("swaps: the muffin uses his walnuts, his dates and the yogurt already bought (David's three yeses)", () => {
  const { tables, report, fresh } = week();
  const { chosen, tables: out } = assignSwaps({
    tables,
    fresh,
    dishOf: () => muffin,
    targetsById,
    report,
    held,
    priceNeed,
  });
  const got = chosen.map((c) => `${c.swap.from}>${c.swap.to}:${c.swap.why}`).sort();
  assert.deepEqual(got, [
    "almond-butter>walnuts:have",
    "chocolate-chips>dates:have",
    "cottage-cheese>greek-yogurt:buying",
  ]);
  // one decision for the batch: every day of the week carries the same swaps
  for (const t of out) assert.equal(t.swaps.length, 3);
  // nothing pushed a day out of band
  for (const r of report) {
    if (r.seatId === "david")
      assert.ok(r.dayProtein >= 190 && r.dayProtein <= 215, `${r.date} ${r.dayProtein}`);
  }
  assert.match(
    String(swapNote(chosen, () => "Muffins")),
    /walnuts for almond butter \(you have it/,
  );
});

test("swaps: withSwaps trades by weight, keeps the dish otherwise, moves the nutrition", () => {
  const swaps = [
    {
      from: "almond-butter",
      to: "walnuts",
      grams: 45,
      why: /** @type {const} */ ("have"),
      saved: 7.99,
    },
  ];
  const dish = /** @type {any} */ (withSwaps(muffin, swaps));
  const row = dish.ingredients.find((/** @type {any} */ i) => i.swappedFrom === "almond butter");
  assert.equal(row.food, "walnuts");
  assert.match(row.note, /in place of almond butter/);
  assert.ok(!/butter of the recipe/.test(row.note), "the old row's note does not ride along");
  // 45 g at 654 vs 614 kcal per 100 g, over 6 servings: +3 kcal a muffin
  assert.ok(
    Math.abs(dish.nutrition.calories - (512 + (0.45 * 40) / 6)) < 0.2,
    String(dish.nutrition.calories),
  );
  assert.equal(dish.ingredients.length, muffin.ingredients.length);
  // no swaps, the very same object (the cheap path every reader takes)
  assert.equal(withSwaps(muffin, undefined), muffin);
});

test("swaps: never when the new food is neither owned nor already bought", () => {
  const { tables, report, fresh } = week();
  const { chosen } = assignSwaps({
    tables,
    fresh,
    dishOf: () => muffin,
    targetsById,
    report,
    held: () => false,
    priceNeed,
  });
  // walnuts are in the dish (bought anyway), the yogurt too; dates are not
  assert.ok(!chosen.some((c) => c.swap.to === "dates"));
});

test("swaps: never a new allergy or avoid conflict, never a nut into a nut-free dish", () => {
  const plain = {
    ...muffin,
    id: "plain",
    name: "Plain Yogurt Bowl",
    ingredients: [
      { food: "plain low-fat yogurt", qty: 600, unit: "g" },
      { food: "raisins", qty: 80, unit: "g" },
    ],
  };
  const { tables, report, fresh } = week();
  const allergic = new Map(targetsById);
  allergic.set("elliot", { ...targetsById.get("elliot"), avoidIngredients: ["peanut", "date"] });
  const { chosen } = assignSwaps({
    tables,
    fresh,
    dishOf: () => plain,
    targetsById: allergic,
    report,
    held: () => true,
    priceNeed,
  });
  assert.ok(
    !chosen.some((c) => c.swap.to === "dates"),
    "dates would be new for Elliot's avoid list",
  );
  // a nut-free dish never gains a nut
  const seedy = { ...plain, ingredients: [{ food: "sunflower seeds", qty: 100, unit: "g" }] };
  const r2 = assignSwaps({
    tables,
    fresh,
    dishOf: () => seedy,
    targetsById,
    report,
    held: () => true,
    priceNeed,
  });
  assert.ok(!r2.chosen.some((c) => /walnut|almond|pecan/.test(c.swap.to)));
});

test("swaps: the dish keeps the food it is named for", () => {
  assert.equal(namedFor("Tuscan White Bean and Vegetable Minestrone", "cannellini-beans"), true);
  assert.equal(namedFor("Almond Butter Cocoa Protein Bars", "almond-butter"), true);
  assert.equal(namedFor("Wayne Double Chocolate Protein Muffins", "almond-butter"), false);
  const bars = { ...muffin, name: "Almond Butter Cocoa Bars" };
  const { tables, report, fresh } = week();
  const { chosen } = assignSwaps({
    tables,
    fresh,
    dishOf: () => bars,
    targetsById,
    report,
    held,
    priceNeed,
  });
  assert.ok(!chosen.some((c) => c.swap.from === "almond-butter"));
});

test("swaps: a table the run did not write (the bought week) is never touched", () => {
  const { tables, report } = week();
  const { chosen, tables: out } = assignSwaps({
    tables,
    fresh: new Set(),
    dishOf: () => muffin,
    targetsById,
    report,
    held,
    priceNeed,
  });
  assert.equal(chosen.length, 0);
  assert.ok(out.every((t) => !t.swaps));
});

test("swaps: a swap that would push a day over the protein ceiling is refused", () => {
  const pot = {
    ...muffin,
    name: "Sheet Pan Pot",
    ingredients: [{ food: "chicken thigh", qty: 2000, unit: "g" }],
  };
  const run = (/** @type {number} */ davidProtein) => {
    const { tables, report, fresh } = week();
    for (const r of report) if (r.seatId === "david") r.dayProtein = davidProtein;
    return assignSwaps({
      tables,
      fresh,
      dishOf: () => pot,
      targetsById,
      report,
      held: (f) => f === "chicken breast",
      priceNeed: (f, g) => (f === "chicken thigh" && g > 0 ? 12 : 0),
    }).chosen;
  };
  // breast carries more protein than thigh: at 215 g it would go over
  assert.equal(run(215).length, 0);
  // with room under the ceiling the same swap is taken
  assert.equal(run(195).length, 1);
});

test("swaps: synced swap rows are validated, never trusted (security review)", async () => {
  const { cleanSwaps } = await import("../app/lib/swaps.js");
  const bad = [
    { from: "__proto__", to: "walnuts", grams: 45, saved: 1 },
    { from: "constructor", to: "toString", grams: 45, saved: 1 },
    { from: "almond-butter", to: "chicken-thigh", grams: 45, saved: 1 },
    { from: "almond-butter", to: "walnuts", grams: "x", saved: 1 },
    null,
    "almond-butter",
  ];
  assert.deepEqual(cleanSwaps(bad), []);
  // a poisoned row does not throw and does not change the dish
  assert.equal(withSwaps(muffin, bad), muffin);
});

test("swaps: never add an animal product (a vegetarian dish stays vegetarian)", async () => {
  const { SWAP_TABLE } = await import("../app/lib/swaps.js");
  assert.ok(!(SWAP_TABLE["vegetable-broth"] ?? []).includes("chicken-broth"));
  assert.ok(!(SWAP_TABLE["unsweetened-soy-milk"] ?? []).includes("milk"));
});
