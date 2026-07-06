import test from "node:test";
import assert from "node:assert/strict";
import { datesOfWeek, setEntry, removeEntry, dayTotals, shiftWeek } from "../app/lib/plan.js";

test("shiftWeek moves across plain and year-boundary weeks", () => {
  assert.equal(shiftWeek("2026-W28", 1), "2026-W29");
  assert.equal(shiftWeek("2026-W28", -1), "2026-W27");
  assert.equal(shiftWeek("2026-W01", -1), "2025-W52");
  assert.equal(shiftWeek("2026-W53", 1), "2027-W01");
});

test("datesOfWeek returns Monday-Sunday ISO dates for an ISO week id", () => {
  assert.deepEqual(datesOfWeek("2026-W28"), [
    "2026-07-06",
    "2026-07-07",
    "2026-07-08",
    "2026-07-09",
    "2026-07-10",
    "2026-07-11",
    "2026-07-12",
  ]);
});

test("datesOfWeek handles year-boundary weeks", () => {
  assert.equal(datesOfWeek("2026-W01")[0], "2025-12-29"); // W01 Monday in prior calendar year
  assert.equal(datesOfWeek("2026-W53")[6], "2027-01-03");
});

test("setEntry adds an entry to an empty plan", () => {
  const plan = { week: "2026-W28", entries: [] };
  const next = setEntry(plan, "2026-07-06", "dinner", { recipeId: "beef", servings: 1 });
  assert.deepEqual(next.entries, [
    { date: "2026-07-06", slot: "dinner", recipeId: "beef", servings: 1 },
  ]);
  assert.deepEqual(plan.entries, [], "original plan is not mutated");
});

test("setEntry replaces the entry occupying the same date+slot", () => {
  const plan = {
    week: "2026-W28",
    entries: [{ date: "2026-07-06", slot: "dinner", recipeId: "beef", servings: 1 }],
  };
  const next = setEntry(plan, "2026-07-06", "dinner", { freeText: "leftovers", servings: 1 });
  assert.deepEqual(next.entries, [
    { date: "2026-07-06", slot: "dinner", freeText: "leftovers", servings: 1 },
  ]);
});

test("setEntry leaves other slots and days alone", () => {
  const plan = {
    week: "2026-W28",
    entries: [{ date: "2026-07-06", slot: "lunch", recipeId: "salad", servings: 1 }],
  };
  const next = setEntry(plan, "2026-07-06", "dinner", { recipeId: "beef", servings: 1 });
  assert.equal(next.entries.length, 2);
});

test("removeEntry drops exactly the date+slot entry", () => {
  const plan = {
    week: "2026-W28",
    entries: [
      { date: "2026-07-06", slot: "dinner", recipeId: "beef", servings: 1 },
      { date: "2026-07-07", slot: "dinner", recipeId: "congee", servings: 1 },
    ],
  };
  const next = removeEntry(plan, "2026-07-06", "dinner");
  assert.deepEqual(next.entries, [
    { date: "2026-07-07", slot: "dinner", recipeId: "congee", servings: 1 },
  ]);
});

test("dayTotals sums calories and protein scaled by servings", () => {
  const recipes = new Map([
    ["beef", { nutrition: { calories: 900, protein: 61 } }],
    ["smoothie", { nutrition: { calories: 780, protein: 58 } }],
  ]);
  const entries = [
    { date: "2026-07-06", slot: "dinner", recipeId: "beef", servings: 1 },
    { date: "2026-07-06", slot: "smoothie", recipeId: "smoothie", servings: 2 },
    { date: "2026-07-07", slot: "dinner", recipeId: "beef", servings: 1 },
  ];
  assert.deepEqual(dayTotals(entries, recipes, "2026-07-06"), { calories: 2460, protein: 177 });
});

test("dayTotals ignores freeText entries and unknown recipe ids", () => {
  const recipes = new Map([["beef", { nutrition: { calories: 900, protein: 61 } }]]);
  const entries = [
    { date: "2026-07-06", slot: "lunch", freeText: "eating out", servings: 1 },
    { date: "2026-07-06", slot: "dinner", recipeId: "gone", servings: 1 },
    { date: "2026-07-06", slot: "smoothie", recipeId: "beef", servings: 1 },
  ];
  assert.deepEqual(dayTotals(entries, recipes, "2026-07-06"), { calories: 900, protein: 61 });
});
