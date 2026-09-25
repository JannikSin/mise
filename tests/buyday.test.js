import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BUY_DAY,
  buyDayOf,
  isoWeekId,
  parseLocalIso,
  tripDates,
} from "../app/lib/dates.js";
import { tripFor } from "../app/lib/plan.js";
import { deriveShoppingList, tripPlan } from "../app/lib/shopping.js";

// THE BUY DAY (David, 2026-09-25): "sunday was not a good day to buy ... lets
// switch the buy day to friday ... buy the ingredients for the next 7 days
// starting this friday"

test("buy day defaults to Friday; a saved day wins; junk falls back to Friday", () => {
  assert.equal(DEFAULT_BUY_DAY, 5);
  assert.equal(buyDayOf(null), 5);
  assert.equal(buyDayOf({}), 5);
  assert.equal(buyDayOf({ buyDay: 0 }), 0);
  assert.equal(buyDayOf({ buyDay: 3 }), 3);
  assert.equal(buyDayOf({ buyDay: 7 }), 5);
  assert.equal(buyDayOf({ buyDay: "2" }), 5);
  assert.equal(buyDayOf({ buyDay: 2.5 }), 5);
});

test("the Friday trip: Fri 9/25 through Thu 10/1, from any day inside it", () => {
  const want = [
    "2026-09-25",
    "2026-09-26",
    "2026-09-27",
    "2026-09-28",
    "2026-09-29",
    "2026-09-30",
    "2026-10-01",
  ];
  assert.deepEqual(tripDates("2026-09-25"), want); // the Friday itself
  assert.deepEqual(tripDates("2026-09-27", 5), want); // Sunday inside it
  assert.deepEqual(tripDates("2026-10-01", 5), want); // the Thursday that closes it
  // the next Friday opens the next trip
  assert.equal(tripDates("2026-10-02", 5)[0], "2026-10-02");
  assert.equal(parseLocalIso(tripDates("2026-10-02", 5)[6] ?? "").getDay(), 4);
  // the old Sunday rule is still one setting away: a Sunday trip is the plan week
  assert.deepEqual(tripDates("2026-09-30", 0), [
    "2026-09-27",
    "2026-09-28",
    "2026-09-29",
    "2026-09-30",
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
  ]);
});

test("the Friday trip spans two Sunday-to-Saturday plan weeks", () => {
  const weeks = new Set(tripDates("2026-09-25").map((d) => isoWeekId(parseLocalIso(d))));
  assert.deepEqual([...weeks], ["2026-W39", "2026-W40"]);
});

test("the trip crosses a month and a DST change without skipping or doubling a day", () => {
  // US DST ends Sun Nov 1 2026: the Fri Oct 30 trip still has 7 distinct days
  const t = tripDates("2026-10-30", 5);
  assert.equal(new Set(t).size, 7);
  assert.equal(t[0], "2026-10-30");
  assert.equal(t[6], "2026-11-05");
});

test("tripFor: current week anchors on the first day still to plan; future on its Sunday; past none", () => {
  // Fri 9/25 afternoon, W39 on screen: this Friday's trip
  assert.equal(tripFor("2026-W39", "2026-09-25", "2026-09-25", 5)?.[0], "2026-09-25");
  // Wednesday 9/23 with W39 on screen: the trip that opened Fri 9/18
  assert.equal(tripFor("2026-W39", "2026-09-23", "2026-09-23", 5)?.[0], "2026-09-18");
  // Thursday 10/1 after 7:30 pm (planning starts Friday): the NEXT trip
  assert.equal(tripFor("2026-W40", "2026-10-01", "2026-10-02", 5)?.[0], "2026-10-02");
  // Saturday 9/26 after 7:30 pm, the ending week still on screen: the trip
  // holding Sunday, never an empty build
  assert.equal(tripFor("2026-W39", "2026-09-26", "2026-09-27", 5)?.[0], "2026-09-25");
  // next week on screen: the trip holding its Sunday (the next shop it needs)
  assert.equal(tripFor("2026-W40", "2026-09-25", "2026-09-25", 5)?.[0], "2026-09-25");
  assert.equal(tripFor("2026-W41", "2026-09-25", "2026-09-25", 5)?.[0], "2026-10-02");
  // browsing back: no trip, BUILD keeps the whole-week derive
  assert.equal(tripFor("2026-W38", "2026-09-25", "2026-09-25", 5), null);
  assert.equal(tripFor("not-a-week", "2026-09-25", "2026-09-25", 5), null);
});

const RECIPES = new Map([
  [
    "bowl",
    { id: "bowl", servings: 1, ingredients: [{ qty: 200, unit: "g", food: "greek yogurt" }] },
  ],
  [
    "chili",
    { id: "chili", servings: 1, ingredients: [{ qty: 1, unit: "can", food: "kidney beans" }] },
  ],
  [
    "curry",
    { id: "curry", servings: 1, ingredients: [{ qty: 300, unit: "g", food: "chicken thigh" }] },
  ],
  ["late", { id: "late", servings: 1, ingredients: [{ qty: 1, unit: "x", food: "mango" }] }],
  ["mix", { id: "mix", servings: 1, ingredients: [{ qty: 40, unit: "g", food: "raisins" }] }],
]);
const PANTRY = { staples: [], perishables: [] };

/** W39 (Sun 9/20 … Sat 9/26) and W40 (Sun 9/27 … Sat 10/3) */
const W39 = {
  week: "2026-W39",
  entries: [
    { id: "a", date: "2026-09-23", slot: "breakfast", recipeId: "bowl", servings: 1 }, // before the trip
    { id: "b", date: "2026-09-25", slot: "breakfast", recipeId: "bowl", servings: 1 }, // Fri, in
    { id: "c", date: "2026-09-26", slot: "dinner", recipeId: "chili", servings: 2 }, // Sat, in
  ],
  buffer: { recipeId: "mix", portions: 2 },
};
const W40 = {
  week: "2026-W40",
  entries: [
    { id: "d", date: "2026-09-27", slot: "dinner", recipeId: "curry", servings: 2 }, // Sun, in
    { id: "e", date: "2026-10-01", slot: "breakfast", recipeId: "bowl", servings: 1 }, // Thu, in
    { id: "f", date: "2026-10-02", slot: "dinner", recipeId: "late", servings: 1 }, // next Fri, out
  ],
  buffer: { recipeId: "mix", portions: 7 },
};

test("tripPlan keeps only trip days from both weeks; the buffer rides the week with most trip days", () => {
  const trip = tripDates("2026-09-25", 5);
  const p = tripPlan([W39, W40], trip);
  assert.deepEqual(p.entries.map((e) => e.id).sort(), ["b", "c", "d", "e"]);
  // W39 holds Fri + Sat (2 days), W40 holds Sun + Thu (2 days): a tie keeps
  // the first plan given; add a W40 day and W40 wins
  const W40more = {
    ...W40,
    entries: [
      ...W40.entries,
      { id: "g", date: "2026-09-28", slot: "breakfast", recipeId: "bowl", servings: 1 },
    ],
  };
  const p2 = tripPlan([W39, W40more], trip);
  assert.equal(p2.week, "2026-W40");
  assert.deepEqual(p2.buffer, { recipeId: "mix", portions: 7 });
  // a plan with no trip days lends no buffer
  const p3 = tripPlan(
    [{ week: "2026-W38", entries: [], buffer: { recipeId: "mix", portions: 9 } }],
    trip,
  );
  assert.equal(p3.buffer, undefined);
  assert.deepEqual(p3.entries, []);
});

test("BUILD on Friday shops Fri through Thu across both plan files, nothing before or after", () => {
  const trip = tripDates("2026-09-25", 5);
  const list = deriveShoppingList(tripPlan([W39, W40], trip), RECIPES, PANTRY, null, "2026-09-25");
  const foods = list.items.map((i) => i.food);
  assert.ok(foods.includes("greek yogurt")); // Fri + Thu breakfasts
  assert.ok(foods.includes("kidney beans")); // Sat, from W39
  assert.ok(foods.includes("chicken thigh")); // Sun, from W40
  assert.ok(!foods.includes("mango")); // next Friday belongs to the next trip
  const yogurt = list.items.find((i) => i.food === "greek yogurt");
  // Fri (W39) + Thu (W40) = 400 g; Wednesday's bowl is not re-bought
  assert.equal(yogurt?.qty, 400);
});

test("BUILD after Friday dinner buys Saturday onward: the day already eaten is skipped", () => {
  const trip = tripDates("2026-09-26", 5);
  const list = deriveShoppingList(tripPlan([W39, W40], trip), RECIPES, PANTRY, null, "2026-09-26");
  const yogurt = list.items.find((i) => i.food === "greek yogurt");
  assert.equal(yogurt?.qty, 200); // only Thursday's bowl is left to buy
});
