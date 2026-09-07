import test from "node:test";
import assert from "node:assert/strict";
import {
  shelfCheckRows,
  confirmShelfRow,
  editShelfRow,
  goneShelfRow,
  useWhatsLeft,
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
