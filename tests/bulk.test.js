// BUY FOR THE MONTH (bulk.js). David, 2026-11-07: "if there are certain foods
// that for example keep for a month it is ok to then buy in bulk for better
// price at start of month and then pay less later ... so can buy 20 onions
// cause they dont go bad quick and then eat them throughout week".
import test from "node:test";
import assert from "node:assert/strict";
import { boughtQty, keepsDays, monthCover, weeksLeftInMonth } from "../app/lib/bulk.js";
import { applyJustBought, subtractPantryFromTrip } from "../app/lib/shopping.js";
import { weekBudget, recordTripEstimate } from "../app/lib/budget.js";

const CAT = {
  items: [
    { id: "yellow-onions", name: "onion", prices: { "pay-less": { price: 2.59, size: "3 lb" } } },
    {
      id: "olive-oil",
      name: "olive oil",
      prices: { "pay-less": { price: 7.99, size: "16.9 fl oz" } },
    },
    {
      id: "baby-spinach",
      name: "baby spinach",
      prices: { "pay-less": { price: 3.99, size: "10 oz" } },
    },
    {
      id: "brown-rice",
      name: "brown rice",
      prices: { "pay-less": { price: 0.99, size: "16 oz" } },
    },
  ],
};
const STORE = "pay-less";

test("bulk: weeks left in the month, this week included", () => {
  assert.equal(weeksLeftInMonth("2026-11-06"), 4);
  assert.equal(weeksLeftInMonth("2026-11-13"), 3);
  assert.equal(weeksLeftInMonth("2026-11-27"), 1);
});

test("bulk: onions keep a month in the cupboard; spinach never counts as a month buy", () => {
  assert.ok(keepsDays({ food: "onion" }) >= 28);
  assert.ok(keepsDays({ food: "yellow onions" }) >= 28);
  assert.ok(keepsDays({ food: "baby spinach" }) < 28);
  const items = [
    { id: "onion", food: "onion", qty: 2, unit: "each", section: "produce" },
    { id: "spinach", food: "baby spinach", qty: 150, unit: "g", section: "produce" },
  ];
  const m = monthCover(items, CAT, STORE, "2026-11-06");
  assert.deepEqual(
    m.covers.map((c) => c.food),
    ["onion"],
    "spinach would spoil before the month is out",
  );
  // a 3 lb bag (about 6.8 onions) holds 3 weeks of 2 a week
  assert.equal(m.covers[0].weeks, 3);
  assert.ok(m.later > 0 && m.later < 2.59);
  // the old way bought a bag every week: two more bags this month
  assert.equal(m.avoided, 5.18);
});

test("bulk: never past the month or the shelf life", () => {
  const items = [{ id: "rice", food: "brown rice", qty: 50, unit: "g", section: "grains" }];
  // a 16 oz bag is 9 weeks of 50 g, but only 2 weeks are left in November
  const m = monthCover(items, CAT, STORE, "2026-11-20");
  assert.equal(m.covers[0]?.weeks, 2);
  // one week left: nothing to cover
  assert.equal(monthCover(items, CAT, STORE, "2026-11-28").covers.length, 0);
});

test("bulk: the shelf gets the whole package, so next week's list uses the rest", () => {
  const today = "2026-11-06";
  const row = {
    id: "onion",
    food: "onion",
    qty: 2,
    unit: "each",
    section: "produce",
    checked: true,
  };
  assert.equal(boughtQty(row, CAT, STORE), "3 lb");
  // spinach: this week's need, as before
  assert.equal(
    boughtQty({ food: "baby spinach", qty: 150, unit: "g", section: "produce" }, CAT, STORE),
    null,
  );
  const { pantry } = applyJustBought({ items: [row] }, { items: [] }, today, {
    packOf: (r) => boughtQty(/** @type {any} */ (r), CAT, STORE),
  });
  const onion = pantry.items.find((/** @type {any} */ i) => i.food === "onion");
  assert.equal(onion.qty, "3 lb");
  assert.equal(onion.location, "pantry", "onions go in the cupboard, not the fridge");
  // after this week's 2 onions are cooked, next week's 2 come off the shelf
  const { toBuy, covered } = subtractPantryFromTrip(
    [{ food: "onion", qty: 4, unit: "each" }],
    pantry,
  );
  assert.equal(toBuy.length, 0, JSON.stringify(toBuy));
  assert.equal(covered.length, 1);
});

test("bulk: the budget is amortized: week one is not punished, later weeks carry their share", () => {
  // week 1: trip $110 with $9 of later weeks' food in it ($3 a week for 3)
  const wk1 = weekBudget(100, null);
  const plan1 = /** @type {any} */ (
    recordTripEstimate(
      { week: "2026-W45", entries: [] },
      {
        store: STORE,
        date: "2026-11-06",
        total: 110,
        cap: /** @type {number} */ (wk1?.cap) + 9,
        bulk: [{ perWeek: 3, weeksLeft: 3 }],
      },
    )
  );
  // $110 against $109 is $1 over, carried; the $9 bought ahead is not
  const wk2 = weekBudget(100, plan1);
  assert.equal(wk2?.carried, 1);
  assert.equal(wk2?.bulkCharge, 3);
  assert.equal(wk2?.cap, 96);
  assert.deepEqual(wk2?.bulkCarry, [{ perWeek: 3, weeksLeft: 2 }]);
  // the charge runs out after the weeks it covers
  const plan3 = /** @type {any} */ (
    recordTripEstimate(
      { week: "2026-W47", entries: [] },
      {
        store: STORE,
        date: "2026-11-20",
        total: 90,
        cap: 97,
        bulk: [{ perWeek: 3, weeksLeft: 1 }],
      },
    )
  );
  const wk4 = weekBudget(100, plan3);
  assert.equal(wk4?.bulkCharge, 3);
  assert.deepEqual(wk4?.bulkCarry, []);
});
