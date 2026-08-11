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

// PAY FOR WHAT YOU EAT (David 2026-08-10, spec §11.1): a valid frozen pot
// with perSeat rows bills each seat their exact share of each row's cost.
test("ledgerEntryFor: frozen pot perSeat shares beat servings-proportional; top-ups bill the eater", () => {
  const pot = JSON.stringify({
    synthV: 1,
    synthMode: "solved",
    rows: [
      { food: "chicken thigh", unit: "lb", qty: 1, perSeat: { david: 0.75, mom: 0.25 } },
      { food: "rice", unit: "x", qty: 1, perSeat: { david: 0.4, mom: 0.6 } },
      { food: "mystery herb", unit: "x", qty: 1, perSeat: { david: 0.5, mom: 0.5 } },
    ],
    topUps: [{ food: "chicken thigh", unit: "g", qty: 100, perSeat: { david: 100 } }],
  });
  const t2 = { ...TABLE, pot };
  const e = ledgerEntryFor(t2, "david", RECIPE, CATALOGUE, "tj", PROFILES);
  assert.ok(e);
  // chicken $6/lb: david 4.50, mom 1.50; rice $3 x1 (unit x = whole bag):
  // david 1.20, mom 1.80; herb unpriceable -> estimate, costs nothing.
  // The TOP-UP IS NOT BILLED (Red Team: gram rows price at the whole
  // package) - it floors at 0 and flags the entry estimate instead.
  assert.equal(e.shares.david, 4.5 + 1.2, "top-up grams never bill at package price");
  assert.equal(e.estimate, true, "unpriceable herb + unbilled top-up flag the entry");
  assert.ok(e.shares.david > e.shares.mom, "the bigger protein plate owes more");
  const evenSplit = Math.abs(e.shares.david - e.shares.mom) < 0.01;
  assert.ok(!evenSplit, "never an even split when plates differ");
  const sum = Math.round((e.shares.david + e.shares.mom) * 100) / 100;
  assert.ok(Math.abs(sum - e.total) <= 0.02, "shares sum to the total");
});

test("ledgerEntryFor: a table with NO pot falls back to servings-proportional (today's path)", () => {
  const e = ledgerEntryFor(TABLE, "david", RECIPE, CATALOGUE, "tj", PROFILES);
  assert.ok(e);
  assert.ok(Math.abs(e.shares.david - 2 * e.shares.mom) < 0.02, "2 servings owes twice 1");
});

test("ledgerEntryFor: a perSeat naming someone NOT at the table never bills them", () => {
  const pot = JSON.stringify({
    synthV: 1,
    synthMode: "solved",
    rows: [
      { food: "chicken thigh", unit: "lb", qty: 1, perSeat: { sister: 1 } },
      { food: "rice", unit: "x", qty: 1, perSeat: { david: 0.5, mom: 0.5 } },
      { food: "mystery herb", unit: "x", qty: 1, perSeat: { david: 0.5, mom: 0.5 } },
    ],
  });
  const profiles = new Map([...PROFILES, ["sister", { id: "sister" }]]);
  const e = ledgerEntryFor({ ...TABLE, pot }, "david", RECIPE, CATALOGUE, "tj", profiles);
  assert.ok(e);
  assert.equal(e.shares.sister, undefined, "not at the table = never billed");
  assert.equal(e.estimate, true, "the dropped share makes the total a flagged floor");
});

test("parsePot: a perSeat that does not sum to the row qty dies (money conservation)", () => {
  const pot = JSON.stringify({
    synthV: 1,
    synthMode: "solved",
    rows: [
      { food: "chicken thigh", unit: "lb", qty: 1, perSeat: { david: 0.001, mom: 1000 } },
      { food: "rice", unit: "x", qty: 1 },
      { food: "mystery herb", unit: "x", qty: 1 },
    ],
  });
  const e = ledgerEntryFor({ ...TABLE, pot }, "david", RECIPE, CATALOGUE, "tj", PROFILES);
  assert.ok(e, "falls back to servings-proportional");
  assert.ok(Math.abs(e.shares.david - 2 * e.shares.mom) < 0.02, "hand-edited pot cannot move the bill");
});
