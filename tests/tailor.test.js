// Plate tailoring, the deterministic half (David 2026-09-13: "ai tailoring
// needs to be fixed and better"; the 09-07 bowl told him to add protein powder).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bowlTailor, dishContext, screenTailorToDish, seatSay } from "../app/lib/tailor.js";

const BANK = new URL("../../mise-data/recipes/", import.meta.url);
const load = (id) => JSON.parse(readFileSync(new URL(`${id}.json`, BANK), "utf8"));

const SEATS = [
  { id: "david", servings: 0.75 },
  { id: "elliot", servings: 0.75 },
  { id: "guest", servings: 1, status: "skipped" },
];

test("THE LIVE BOWL is tailored by arithmetic: each seat gets its own portion of that day's list, no powder", () => {
  const bowl = load("berry-walnut-greek-yogurt-bowl");
  const out = bowlTailor(bowl, SEATS, "2026-09-07");
  assert.deepEqual(
    Object.keys(out.seats).sort(),
    ["david", "elliot"],
    "skipped seats get no plate",
  );
  const d = out.seats.david;
  assert.equal(d.plate.length, 1);
  assert.match(d.plate[0], /0\.75 cup greek yogurt/);
  assert.ok(!/powder|whey/i.test(d.plate[0]), d.plate[0]);
  // 7 toppings + the yogurt spine, at the seat's own amounts
  assert.equal(d.plate[0].split(" · ").length, 8);
  assert.ok(d.estProtein > 15 && d.estProtein < 40, `protein ${d.estProtein}`);
  assert.ok(d.estCalories > 350 && d.estCalories < 700, `kcal ${d.estCalories}`);
  assert.match(out.cook[0], /each person builds their own/i);
  // the same day gives the same plate on every device
  assert.deepEqual(bowlTailor(bowl, SEATS, "2026-09-07").seats.david.plate, d.plate);
});

test("a non-rotating per-portion dish tailors from the recipe as written", () => {
  const plate = {
    servings: 1,
    nutrition: { calories: 600, protein: 30 },
    ingredients: [
      { qty: 0.75, unit: "cup", food: "cottage cheese" },
      { qty: 1, unit: "each", food: "banana" },
    ],
  };
  const out = bowlTailor(plate, [{ id: "mom", servings: 0.5 }], "2026-09-13");
  assert.match(out.seats.mom.plate[0], /0\.38 cup cottage cheese/);
  assert.match(out.seats.mom.plate[0], /0\.5 banana/);
  assert.equal(out.seats.mom.estCalories, 300);
  assert.equal(out.seats.mom.estProtein, 15);
});

const PASTA = {
  name: "Chicken Pesto Pasta",
  servings: 2,
  nutrition: { calories: 765, protein: 43, carbs: 66, fat: 34 },
  ingredients: [
    { qty: 300, unit: "g", food: "chicken breast" },
    { qty: 240, unit: "g", food: "whole wheat pasta" },
    { qty: 120, unit: "g", food: "basil pesto" },
    { qty: 300, unit: "g", food: "cherry tomatoes" },
    { qty: 2, unit: "cloves", food: "garlic" },
    { qty: 2, unit: "cups", food: "baby spinach" },
    { qty: 3, unit: "tbsp", food: "parmesan" },
  ],
};

test("dishContext hands the model the WHOLE POT at the table's total, per-serving macros intact", () => {
  const ctx = dishContext(PASTA, SEATS);
  assert.equal(ctx.servings, 1.5, "two 0.75 seats; the skipped seat is not in the pot");
  assert.equal(ctx.calories, 765, "per serving, as the recipe states");
  assert.ok(ctx.ingredients.includes("225 g chicken breast"), ctx.ingredients.join("; "));
  assert.ok(ctx.ingredients.includes("180 g whole wheat pasta"));
});

test("seatSay states the seat's share of the pot and what it comes to", () => {
  const say = seatSay(PASTA, SEATS[0], SEATS);
  assert.match(say, /eats 0\.75 of the pot's 1\.5 servings/);
  assert.match(say, /574 kcal \/ 32 g protein/);
  assert.match(say, /only with foods already in the pot/);
  assert.ok(say.length <= 300, `${say.length} chars`);
});

test("screenTailorToDish drops powders, supplements and foods the pot does not hold; keeps the dish's own", () => {
  const out = screenTailorToDish(
    {
      seats: {
        david: {
          portionGrams: 410,
          plate: [
            "Base plate: 410 g of the pasta",
            "Add 1 scoop (30 g) plain protein powder or 2 tbsp extra greek yogurt mixed in for protein boost",
            "1 fried egg on top",
            "add 60 g extra pasta from the pot",
            "extra 40 g chicken breast on this plate",
            "Drizzle 1 tsp olive oil",
          ],
          estCalories: 800,
          estProtein: 48,
        },
        elliot: {
          portionGrams: 410,
          plate: ["Stir in 1 scoop whey", "Add 2 tbsp collagen peptides"],
          estCalories: 620,
          estProtein: 34,
        },
        mom: {
          portionGrams: 300,
          plate: ["no garlic: this plate is portioned out before the garlic goes in"],
          estCalories: 500,
          estProtein: 30,
        },
      },
      cook: [
        "Portion David's plate first, then add his extra pasta and chicken",
        "Blend a protein shake for David on the side",
      ],
    },
    PASTA,
  );
  assert.deepEqual(out.seats.david.plate, [
    "Base plate: 410 g of the pasta",
    "add 60 g extra pasta from the pot",
    "extra 40 g chicken breast on this plate",
    "Drizzle 1 tsp olive oil",
  ]);
  assert.equal(
    out.seats.elliot,
    undefined,
    "a seat left with nothing is dropped, like the avoid screen",
  );
  assert.deepEqual(out.seats.mom.plate, [
    "no garlic: this plate is portioned out before the garlic goes in",
  ]);
  assert.deepEqual(out.cook, ["Portion David's plate first, then add his extra pasta and chicken"]);
});

test("a dish that genuinely lists a powder may keep it", () => {
  const smoothie = {
    servings: 1,
    ingredients: [
      { qty: 1, unit: "scoop", food: "whey protein powder" },
      { qty: 1, unit: "each", food: "banana" },
    ],
  };
  const out = screenTailorToDish(
    {
      seats: {
        d: {
          portionGrams: 0,
          plate: ["add half a scoop more whey protein powder"],
          estCalories: 1,
          estProtein: 1,
        },
      },
      cook: [],
    },
    smoothie,
  );
  assert.equal(out.seats.d.plate.length, 1);
});
