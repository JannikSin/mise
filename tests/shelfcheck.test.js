import test from "node:test";
import assert from "node:assert/strict";
import {
  shelfCheckRows,
  confirmShelfRow,
  editShelfRow,
  goneShelfRow,
  useWhatsLeft,
  weekNeedsCheck,
  setPantryCount,
  SHELF_CHECK_DAYS,
} from "../app/lib/shelfcheck.js";
import { pantryItems } from "../app/lib/shopping.js";

const PANTRY = {
  items: [
    {
      id: "y1",
      food: "greek yogurt",
      qty: "2721 g",
      said: "3 tubs",
      added: "2026-09-06",
      location: "fridge",
    },
    { id: "k1", food: "kale", qty: "", added: "2026-09-01", location: "fridge" },
    {
      id: "e1",
      food: "eggs",
      qty: "12 each",
      added: "2026-09-06",
      location: "fridge",
      checkedAt: "2026-09-06",
    },
    { id: "rice", food: "rice", section: "grains", state: "plenty" },
  ],
};

test("shelfCheckRows: dated rows only, stale first, and a confirmation ages out after a week", () => {
  const r = shelfCheckRows(PANTRY, "2026-09-07");
  assert.deepEqual(
    r.rows.map((x) => [x.id, x.stale]),
    [
      ["y1", true],
      ["k1", true],
      ["e1", false],
    ],
    "state items are not shelf rows; unconfirmed first",
  );
  assert.equal(r.stale, 2);
  assert.equal(r.lastChecked, "2026-09-06");
  const later = shelfCheckRows(
    PANTRY,
    "2026-09-06".replace("06", String(6 + SHELF_CHECK_DAYS + 1)),
  );
  assert.equal(
    later.rows.find((x) => x.id === "e1")?.stale,
    true,
    "a week-old confirmation is stale again",
  );
});

test("STILL HAVE stamps the row; EDIT normalizes the words and writes off a lower count; GONE removes and writes off", () => {
  const confirmed = confirmShelfRow(PANTRY, "y1", "2026-09-07");
  assert.equal(pantryItems(confirmed).find((i) => i.id === "y1").checkedAt, "2026-09-07");

  const down = editShelfRow(PANTRY, "y1", "1 tub", "2026-09-07");
  const y = pantryItems(down.pantry).find((i) => i.id === "y1");
  assert.equal(y.qty, "907 g");
  assert.equal(y.said, "1 tub");
  assert.equal(y.checkedAt, "2026-09-07");
  assert.equal(down.direction, "down");
  assert.equal(down.waste?.qty, "1814 g", "the difference is the write-off");

  const up = editShelfRow(PANTRY, "e1", "18", "2026-09-07");
  assert.equal(up.direction, "up");
  assert.equal(up.waste, null, "more than believed is not waste");
  assert.equal(pantryItems(up.pantry).find((i) => i.id === "e1").qty, "18 each");

  const words = editShelfRow(PANTRY, "k1", "a handful", "2026-09-07");
  assert.equal(words.direction, "unknown");
  assert.equal(
    pantryItems(words.pantry).find((i) => i.id === "k1").qty,
    "a handful",
    "unreadable words are kept as words",
  );

  const gone = goneShelfRow(PANTRY, "k1");
  assert.ok(!pantryItems(gone.pantry).some((i) => i.id === "k1"));
  assert.equal(gone.waste?.food, "kale");
  assert.equal(goneShelfRow(PANTRY, "rice").waste, null, "a state item is not a shelf row");
});

test("useWhatsLeft ranks dishes the shelf mostly covers, expiring food first, and says what is still missing", () => {
  const bank = [
    {
      id: "kale-eggs",
      name: "Kale and eggs",
      mealType: "dinner",
      ingredients: [
        { food: "kale", qty: 2, unit: "cup" },
        { food: "eggs", qty: 3, unit: "each" },
        { food: "rice", qty: 1, unit: "cup" },
        { food: "olive oil", qty: 1, unit: "tbsp", staple: true },
      ],
    },
    {
      id: "yogurt-bowl",
      name: "Yogurt bowl",
      mealType: "breakfast",
      ingredients: [
        { food: "greek yogurt", qty: 1, unit: "cup" },
        { food: "banana", qty: 1, unit: "each" },
      ],
    },
    {
      id: "steak",
      name: "Steak dinner",
      mealType: "dinner",
      ingredients: [
        { food: "steak", qty: 300, unit: "g" },
        { food: "potato", qty: 2, unit: "each" },
        { food: "rice", qty: 1, unit: "cup" },
      ],
    },
  ];
  const picks = useWhatsLeft(bank, PANTRY, "2026-09-07", { slot: "dinner" });
  assert.deepEqual(
    picks.map((p) => p.recipe.id),
    ["kale-eggs"],
    "the steak is a shopping trip, not what's left; breakfast is not a dinner",
  );
  assert.equal(picks[0].coverage, 1);
  assert.deepEqual(picks[0].expiring, ["kale"], "week-old kale is inside its last days");
  const bf = useWhatsLeft(bank, PANTRY, "2026-09-07", { slot: "breakfast" });
  assert.equal(bf.length, 0, "half a bowl (no banana) is under the 60% line");
});

test("weekNeedsCheck: the week's need against the shelf, in the list's own arithmetic (David, 2026-09-07)", () => {
  const pantry = {
    items: [
      { id: "soy-sauce", food: "soy sauce", section: "condiments", state: "plenty" },
      {
        id: "y1",
        food: "greek yogurt",
        qty: "907 g",
        said: "1 tub",
        added: "2026-09-06",
        location: "fridge",
      },
      {
        id: "e1",
        food: "eggs",
        qty: "12 each",
        said: "1 dozen",
        added: "2026-09-06",
        location: "fridge",
      },
      { id: "l1", food: "lemons", qty: "a few, in bag", added: "2026-09-06", location: "pantry" },
    ],
  };
  const demand = [
    { food: "soy sauce", qty: 8, unit: "tbsp" },
    { food: "greek yogurt", qty: 2000, unit: "g" },
    { food: "egg", qty: 7, unit: "each" },
    { food: "lemon", qty: 3, unit: "each" },
    { food: "chicken breast", qty: 500, unit: "g" },
  ];
  const r = weekNeedsCheck(demand, pantry);
  const by = Object.fromEntries(r.rows.map((x) => [x.food, x]));
  assert.ok(!("chicken breast" in by), "a pure buy is the list's business, not the shelf's");
  assert.equal(by["soy sauce"].status, "plenty-uncounted", "a word is not a number");
  assert.equal(by["greek yogurt"].status, "short");
  const shortG =
    by["greek yogurt"].short?.unit === "kg"
      ? by["greek yogurt"].short.qty * 1000
      : by["greek yogurt"].short?.qty;
  assert.ok(shortG > 1000 && shortG <= 1100, `short by ${shortG} g, rounded to a pack`);
  assert.equal(by["egg"].status, "enough");
  assert.equal(by["lemon"].status, "uncounted");
  assert.equal(r.unverified, 3);
  assert.deepEqual(
    r.rows.map((x) => x.status),
    ["plenty-uncounted", "uncounted", "short", "enough"],
    "the ones that need a number come first",
  );
  // a teaspoon of salt is not a question anyone answers
  const tiny = weekNeedsCheck(
    [
      { food: "salt", qty: 2, unit: "tsp" },
      { food: "onion", qty: 1, unit: "each" },
      { food: "soy sauce", qty: 8, unit: "tbsp" },
    ],
    {
      items: [
        { id: "salt", food: "salt", section: "spices", state: "plenty" },
        { id: "onions", food: "onions", section: "produce", state: "plenty" },
        { id: "soy-sauce", food: "soy sauce", section: "condiments", state: "plenty" },
      ],
    },
  );
  assert.deepEqual(
    tiny.rows.map((x) => [x.food, x.minor]),
    [
      ["soy sauce", false],
      ["onion", true],
      ["salt", true],
    ],
  );
  assert.equal(tiny.unverified, 1, "only the bottle is a real question");
});

test("setPantryCount: a number replaces a word, corrects a counted row, or makes one", () => {
  const pantry = {
    items: [
      { id: "soy-sauce", food: "soy sauce", section: "condiments", state: "plenty" },
      {
        id: "y1",
        food: "greek yogurt",
        qty: "907 g",
        said: "1 tub",
        added: "2026-09-06",
        location: "fridge",
      },
    ],
  };
  const a = setPantryCount(pantry, "soy sauce", "half a bottle", "2026-09-07");
  const rows = pantryItems(a.pantry).filter((i) => i.food === "soy sauce");
  assert.equal(rows.length, 1, "the plenty assertion is retired, one row remains");
  assert.ok(rows[0].added, "and it is a counted row now");
  assert.equal(a.direction, "new");

  const b = setPantryCount(pantry, "greek yogurt", "3 tubs", "2026-09-07");
  assert.equal(pantryItems(b.pantry).find((i) => i.id === "y1").qty, "2721 g");
  assert.equal(b.direction, "up");

  const c = setPantryCount(pantry, "kale", "1 bag", "2026-09-07");
  const kale = pantryItems(c.pantry).find((i) => i.food === "kale");
  assert.equal(kale.location, "fridge", "a perishable lands in the fridge");
  assert.equal(kale.checkedAt, "2026-09-07");
});
