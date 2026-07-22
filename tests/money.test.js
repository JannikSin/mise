import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLedger,
  recipeServingCost,
  ledgerEntryFor,
  recordEntries,
  balancesFor,
  settleBetween,
} from "../app/lib/money.js";

const CATALOGUE = {
  items: [
    { id: "chicken-thigh", name: "chicken thigh", prices: { tj: { price: 6, size: "per lb" } } },
    { id: "rice", name: "rice", prices: { tj: { price: 3, size: "2 lb bag", estimate: true } } },
  ],
};
const RECIPE = {
  id: "kebab",
  name: "Kebab",
  servings: 2,
  ingredients: [
    { qty: 1, unit: "lb", food: "chicken thigh" },
    { qty: 1, unit: "x", food: "rice" },
    { qty: 1, unit: "x", food: "mystery herb" }, // unpriceable: floor + estimate
  ],
};
const PROFILES = new Map([
  ["david", { id: "david" }],
  ["mom", { id: "mom" }],
]);
const TABLE = {
  id: "t1",
  name: "Family dinner",
  date: "2026-07-20",
  slot: "dinner",
  recipeId: "kebab",
  seats: [
    { id: "david", servings: 2 },
    { id: "mom", servings: 1 },
  ],
};

test("recipeServingCost: floor-priced per serving, estimate-flagged when anything is unpriceable", () => {
  const { perServing, estimate } = recipeServingCost(RECIPE, CATALOGUE, "tj");
  assert.equal(perServing, 4.5); // (6 + 3) / 2 servings
  assert.equal(estimate, true);
});

test("ledgerEntryFor: shares scale with servings — 2 servings owes twice 1", () => {
  const e = ledgerEntryFor(TABLE, "david", RECIPE, CATALOGUE, "tj", PROFILES);
  assert.equal(e.payerId, "david");
  assert.equal(e.shares.david, 9); // 4.5 x 2
  assert.equal(e.shares.mom, 4.5); // 4.5 x 1
  assert.equal(e.total, 13.5);
  assert.equal(e.settled, false);
});

test("ledgerEntryFor: skipped and unknown seats owe nothing; unpriceable recipe records nothing", () => {
  const t = {
    ...TABLE,
    seats: [
      { id: "david", servings: 1 },
      { id: "mom", servings: 1, status: "skipped" },
      { id: "ghost", servings: 5 },
    ],
  };
  const e = ledgerEntryFor(t, "david", RECIPE, CATALOGUE, "tj", PROFILES);
  assert.deepEqual(Object.keys(e.shares), ["david"]);
  assert.equal(ledgerEntryFor(TABLE, "david", RECIPE, null, "tj", PROFILES), null);
});

test("recordEntries is idempotent by table id", () => {
  const e = ledgerEntryFor(TABLE, "david", RECIPE, CATALOGUE, "tj", PROFILES);
  const once = recordEntries(normalizeLedger(null), [e]);
  assert.equal(once.added, 1);
  const twice = recordEntries(once.ledger, [e]);
  assert.equal(twice.added, 0);
  assert.equal(twice.ledger.entries.length, 1);
});

test("balancesFor nets both directions and settleBetween clears the pair", () => {
  // david cooked t1 (mom owes 4.5); mom cooked t2 (david owes 3)
  const ledger = {
    entries: [
      {
        id: "t1",
        date: "2026-07-20",
        payerId: "david",
        total: 13.5,
        estimate: false,
        shares: { david: 9, mom: 4.5 },
      },
      {
        id: "t2",
        date: "2026-07-21",
        payerId: "mom",
        total: 6,
        estimate: false,
        shares: { mom: 3, david: 3 },
      },
    ],
  };
  const mine = balancesFor(ledger, "david");
  assert.deepEqual(mine, [{ profileId: "mom", net: 1.5, entries: 2, estimate: false }]);
  const hers = balancesFor(ledger, "mom");
  assert.equal(hers[0].net, -1.5); // mirror image
  const settled = settleBetween(ledger, "david", "mom");
  assert.deepEqual(balancesFor(settled, "david"), []);
  assert.ok(settled.entries.every((e) => e.settled));
});
