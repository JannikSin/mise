import test from "node:test";
import assert from "node:assert/strict";
import { applyScanItems, parsePantryDictation } from "../app/lib/scan.js";

const PANTRY = {
  staples: [
    { id: "rice", name: "Rice", section: "dry-goods", onHand: false, runningLow: true },
    { id: "cayenne", name: "Cayenne", section: "spices", onHand: true, runningLow: false },
  ],
  perishables: [{ food: "half cabbage", qty: "0.5 head", added: "2026-07-04", useSoon: true }],
};

test("staple item refreshes an existing staple instead of duplicating", () => {
  const next = applyScanItems(PANTRY, [{ name: "rice", kind: "staple", qty: "" }], "2026-07-06");
  const rice = next.staples.filter((s) => s.id === "rice");
  assert.equal(rice.length, 1);
  assert.equal(rice[0].onHand, true, "seen in the photo = on hand");
  assert.equal(rice[0].runningLow, false, "seen = not running low");
});

test("new staple is added with a derived id and section", () => {
  const next = applyScanItems(
    PANTRY,
    [{ name: "Olive Oil", kind: "staple", qty: "" }],
    "2026-07-06",
  );
  const oil = next.staples.find((s) => s.id === "olive-oil");
  assert.ok(oil);
  assert.equal(oil.name, "Olive Oil");
  assert.equal(oil.section, "condiments"); // cooking oils shelve with the vinegars
  assert.equal(oil.onHand, true);
  assert.equal(oil.runningLow, false);
});

test("new perishable lands with today's date; existing one is not duplicated", () => {
  const next = applyScanItems(
    PANTRY,
    [
      { name: "Half Cabbage", kind: "perishable", qty: "0.5 head" },
      { name: "milk", kind: "perishable", qty: "1L" },
    ],
    "2026-07-06",
  );
  assert.equal(next.perishables.filter((p) => p.food.toLowerCase() === "half cabbage").length, 1);
  const milk = next.perishables.find((p) => p.food === "milk");
  assert.ok(typeof milk.id === "string" && milk.id.length > 0); // P1: stable id at creation
  const rest = { ...milk };
  delete rest.id;
  // one-pantry: tracked rows are healed at write time — an unplaced scan row
  // lands in "unsorted", the location no sweep ever touches
  assert.deepEqual(rest, {
    food: "milk",
    qty: "1L",
    added: "2026-07-06",
    useSoon: false,
    location: "unsorted",
    group: "dairy",
  });
});

test("does not mutate the input pantry and tolerates missing arrays", () => {
  const before = JSON.stringify(PANTRY);
  applyScanItems(PANTRY, [{ name: "x", kind: "staple", qty: "" }], "2026-07-06");
  assert.equal(JSON.stringify(PANTRY), before);
  const next = applyScanItems({}, [{ name: "milk", kind: "perishable", qty: "" }], "2026-07-06");
  assert.equal(next.perishables.length, 1);
  assert.deepEqual(next.staples, []);
});

test("a scan with a location lands the new perishables on that shelf", () => {
  const next = applyScanItems(
    PANTRY,
    [{ name: "greek yogurt", kind: "perishable", qty: "500 g" }],
    "2026-07-06",
    "fridge",
  );
  const row = next.perishables.find((p) => p.food === "greek yogurt");
  assert.equal(row.location, "fridge");
});

test("a scan without a location lands in unsorted, which no sweep ever touches", () => {
  const next = applyScanItems(
    PANTRY,
    [{ name: "greek yogurt", kind: "perishable", qty: "500 g" }],
    "2026-07-06",
  );
  const row = next.perishables.find((p) => p.food === "greek yogurt");
  // the safety property behind the old "legacy shape" contract survives:
  // an unplaced row is quarantined where a location sweep cannot delete it
  assert.equal(row.location, "unsorted");
});

test("SHELF-AWARE refresh (Tribunal B3): a fridge scan never rewrites the freezer's pack", () => {
  const pantry = {
    staples: [],
    perishables: [
      { id: "z1", food: "chicken thigh", qty: "1 kg", added: "2026-07-10", location: "freezer" },
    ],
  };
  const next = applyScanItems(
    pantry,
    [{ name: "chicken thigh", kind: "perishable", qty: "500 g" }],
    "2026-08-01",
    "fridge",
  );
  const freezer = next.perishables.find((p) => p.id === "z1");
  assert.equal(freezer.qty, "1 kg", "freezer row untouched");
  assert.equal(freezer.added, "2026-07-10", "no expiry laundering");
  const fridge = next.perishables.find((p) => p.location === "fridge");
  assert.equal(fridge.qty, "500 g", "the fridge gets its own new row");
  // and a SECOND fridge photo refreshes the fridge row instead of duplicating
  const again = applyScanItems(
    next,
    [{ name: "chicken thigh", kind: "perishable", qty: "700 g" }],
    "2026-08-01",
    "fridge",
  );
  assert.equal(again.perishables.filter((p) => p.food === "chicken thigh").length, 2);
  assert.equal(again.perishables.find((p) => p.location === "fridge").qty, "700 g");
});

// ---- SAY WHAT YOU HAVE (David, 2026-09-06) ------------------------------------

test("parsePantryDictation reads a spoken run-through into pantry rows", () => {
  const rows = parsePantryDictation(
    "um so I have soy sauce, sesame oil and I've got 2 lbs chicken thighs, a dozen eggs, frozen berries. running low on rice, we're out of milk, also some walnuts",
  );
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(by).sort(), [
    "chicken thighs",
    "eggs",
    "frozen berries",
    "rice",
    "sesame oil",
    "soy sauce",
    "walnuts",
  ]);
  assert.equal(by["soy sauce"].kind, "staple");
  assert.equal(by["soy sauce"].state, undefined, "plenty by default");
  assert.equal(by["chicken thighs"].kind, "fresh");
  assert.equal(by["chicken thighs"].location, "fridge");
  assert.equal(by["chicken thighs"].qty, "2 lbs");
  assert.equal(by["eggs"].qty, "1 dozen");
  assert.equal(by["frozen berries"].location, "freezer");
  assert.equal(by["rice"].state, "low", "'running low on' marks it low");
  assert.ok(!("milk" in by), "'out of' adds nothing");
  assert.equal(by["walnuts"].kind, "staple");
  assert.equal(by["chicken thighs"].kind, "fresh");
  assert.equal(by["eggs"].location, "fridge");
});

test("parsePantryDictation: one item per line works too, duplicates collapse, bare articles are not quantities", () => {
  const rows = parsePantryDictation(
    "Olive oil\nolive oil\na spinach\n3 cans black beans\nhalf a bag of quinoa",
  );
  assert.deepEqual(
    rows.map((r) => [r.name, r.qty, r.kind]),
    [
      ["olive oil", "", "staple"],
      ["spinach", "", "fresh"],
      // a count is inventory since 2026-09-06: counted rows are dated rows
      ["black beans", "3 cans", "fresh"],
      ["quinoa", "0.5 bag", "fresh"],
    ],
  );
});

test("a dictated 'low on' staple lands LOW through applyScanItems, never plenty", () => {
  const next = applyScanItems(
    PANTRY,
    [{ name: "rice", kind: "staple", qty: "", state: "low" }],
    "2026-07-06",
  );
  const rice = next.staples.find((s) => s.id === "rice");
  assert.equal(rice.runningLow, true);
  assert.equal(rice.onHand, false, "the legacy mirror reads LOW as not-on-hand, by design");
});

test("parsePantryDictation splits a run-on at the next quantity (David's 2026-09-06 dictation)", () => {
  const rows = parsePantryDictation(
    "cottage cheese two bricks of sharp cheddar cheese, milk a huge thing of soy sauce about a container of basil pesto, what I think is kale, we, there’s lots of rice, boy Scout popcorn a huge thing of Chia seeds a huge thing of whey protein powder",
  );
  assert.deepEqual(
    rows.map((r) => [r.name, r.qty]),
    [
      ["cottage cheese", ""],
      ["sharp cheddar cheese", "2 bricks"],
      ["milk", ""],
      ["soy sauce", ""],
      ["basil pesto", "1 container"],
      ["kale", ""],
      ["rice", ""],
      ["boy Scout popcorn", ""],
      ["chia seeds", ""],
      ["whey protein powder", ""],
    ],
  );
});

test("a dictated COUNT is inventory: it lands as a countable dated row, cans on the pantry shelf", () => {
  const rows = parsePantryDictation(
    "5 lemons, 6 cans of coconut milk, 3 tubs of greek yogurt, a dozen eggs, soy sauce",
  );
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by["lemons"].kind, "fresh", "a count is never a bare PLENTY");
  assert.equal(by["lemons"].location, "pantry");
  assert.equal(
    by["coconut milk"].location,
    "pantry",
    "cans are not fridge food whatever is inside",
  );
  assert.equal(by["greek yogurt"].location, "fridge");
  assert.equal(by["soy sauce"].kind, "staple");
  const next = applyScanItems({ items: [] }, rows, "2026-09-06", "pantry");
  const row = (/** @type {string} */ f) => next.items.find((it) => it.food === f);
  assert.equal(row("lemons").qty, "5 each");
  assert.equal(row("lemons").said, "5");
  assert.equal(row("greek yogurt").qty, "2721 g");
  assert.equal(row("greek yogurt").said, "3 tubs");
  assert.equal(row("eggs").qty, "12 each");
  assert.equal(row("coconut milk").qty, "6 can");
});

test("a dictated COUNT retires the bare PLENTY assertion for the same food (David, 2026-09-07)", () => {
  const before = { items: [{ id: "eggs", food: "eggs", section: "dairy", state: "plenty" }] };
  const next = applyScanItems(before, parsePantryDictation("a dozen eggs"), "2026-09-07", "fridge");
  const eggs = next.items.filter((i) => i.food === "eggs");
  assert.equal(eggs.length, 1);
  assert.equal(eggs[0].qty, "12 each");
});
