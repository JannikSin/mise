// THE COSTCO PANTRY (P6; David, 2026-11-06: "i have huge bags of walnuts and
// almonds and pecans and flaxseen and chia seeds and oats and honey and
// baking poweder ... and dates and so we bought all of this in costco a while
// ago... that is suposed to be used and offset the cost also granola").
// Said in his words, it lands as his foods with nothing else to sort, and a
// counted bag stays on the shelf for months, not two weeks.
import test from "node:test";
import assert from "node:assert/strict";
import { applyScanItems, readPantryNote } from "../app/lib/scan.js";
import { expirePerishables, shelfLifeDays } from "../app/lib/shopping.js";

const HIS_WORDS =
  "i have huge bags of walnuts and almonds and pecans and flaxseen and chia seeds and oats and honey and baking poweder and all of that sorts of things and dates and so we bought all of this in costco a while ago... that is suposed to be used and offset the cost also granola";
const KNOWN = [
  "walnuts",
  "almonds",
  "pecans",
  "ground flaxseed",
  "flaxseed",
  "chia seeds",
  "rolled oats",
  "honey",
  "baking powder",
  "dates",
  "granola",
];

test("Costco pantry: his own sentence reads as his foods, the two typos as one-tap guesses, no narration rows", () => {
  const note = readPantryNote(HIS_WORDS, KNOWN);
  const names = note.items.map((i) => i.name);
  for (const f of ["walnuts", "almonds", "pecans", "chia seeds", "honey", "dates", "granola"]) {
    assert.ok(names.includes(f), `${f} missing from ${JSON.stringify(names)}`);
  }
  assert.ok(
    names.some((n) => /oats/.test(n)),
    "oats",
  );
  assert.deepEqual(
    note.unsure.map((u) => [u.name, u.guess]),
    [
      ["flaxseen", "flaxseed"],
      ["baking poweder", "baking powder"],
    ],
  );
});

test("Costco pantry: a counted bag of nuts or dates keeps half a year on the shelf", () => {
  for (const f of ["walnuts", "almonds", "pecans", "dates"]) {
    assert.equal(shelfLifeDays(f, "pantry"), 180, f);
  }
  // meat and greens are untouched by the new line
  assert.equal(shelfLifeDays("ground turkey", "fridge"), 4);
  assert.equal(shelfLifeDays("baby spinach", "fridge"), 6);
  const note = readPantryNote("3 lb walnuts, 2 lb dates", KNOWN);
  // the ADD button groups the read-back by the shelf the parser chose and
  // lands each group there (shopping.js, onScanApprove(items, loc, "add"))
  assert.deepEqual(
    note.items.map((i) => i.location),
    ["pantry", "pantry"],
  );
  const pantry = applyScanItems({ items: [] }, note.items, "2026-11-07", "pantry");
  // three weeks later both bags are still there (the old 14-day default
  // would have expired them and put them back on the List)
  const later = expirePerishables(pantry, "2026-11-28");
  const left = (later.pantry?.items ?? later.items ?? []).map((/** @type {any} */ i) => i.food);
  assert.ok(left.includes("walnuts") && left.includes("dates"), JSON.stringify(later));
});

test("Costco pantry: once the pantry says PLENTY, the List as it stands stops buying it (no rebuild needed)", async () => {
  const { skipPlentyHeld } = await import("../app/lib/shopping.js");
  const items = [
    { food: "rolled oats", qty: 1600, unit: "g" },
    { food: "honey", qty: 11, unit: "tbsp" },
    { food: "baking powder", qty: 5.5, unit: "tsp", manual: true },
    { food: "eggs", qty: 9, unit: "each" },
    { food: "blueberries", qty: 550, unit: "g" },
  ];
  const pantry = {
    items: [
      { id: "rolled-oats", food: "oats", state: "plenty", since: "2026-11-07" },
      { id: "honey", food: "honey", state: "plenty" },
      { id: "baking-powder", food: "baking powder", state: "plenty" },
      // months-old plenty eggs: perishable, so they do not cover (11/6 fix)
      { id: "eggs", food: "eggs", state: "plenty" },
      { id: "blueberries", food: "blueberries", state: "low" },
    ],
  };
  const { toBuy, covered } = skipPlentyHeld(items, pantry, "2026-11-07");
  assert.deepEqual(
    covered.map((i) => i.food),
    ["rolled oats", "honey"],
  );
  // a row he typed himself stays his word on this trip
  assert.deepEqual(
    toBuy.map((i) => i.food),
    ["baking powder", "eggs", "blueberries"],
  );
});
