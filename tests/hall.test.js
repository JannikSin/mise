// The network half of P10, and the reason it needed writing: the composer in
// dininghall.js was correct, tested, and had ZERO importers. Choosing a hall
// and getting a tray was not something a person could do. These tests fence
// the wiring, not the composer, which has its own coverage.
import test from "node:test";
import assert from "node:assert/strict";
import { COURTS, MEALS, mealsOn, quotaFor } from "../app/lib/hall.js";
import { menuUrlFor, itemUrlFor } from "../app/lib/dininghall.js";

test("the URLs match Purdue's actual endpoint shape", () => {
  // date goes MM-DD-YYYY, which is not the ISO the rest of the app speaks
  assert.equal(
    menuUrlFor("Earhart", "2026-08-24"),
    "https://api.hfs.purdue.edu/menus/v2/locations/Earhart/08-24-2026",
  );
  assert.equal(itemUrlFor("abc-123"), "https://api.hfs.purdue.edu/menus/v2/items/abc-123");
});

test("court names are encoded, so a space cannot break the URL", () => {
  assert.ok(menuUrlFor("Ford Dining Court", "2026-08-24").includes("Ford%20Dining%20Court"));
});

test("every court offered in the UI is a real Purdue residential court", () => {
  const names = COURTS.map((c) => c.id);
  assert.deepEqual(names, ["Earhart", "Ford", "Hillenbrand", "Wiley", "Windsor"]);
  for (const c of COURTS) assert.ok(c.label, `${c.id} has no label`);
});

test("mealsOn reads what a court ACTUALLY serves, not a fixed list", () => {
  // Windsor has no Late Lunch; offering it would send someone to an empty menu
  const day = {
    Meals: [
      { Name: "Breakfast", Status: "Open" },
      { Name: "Lunch", Status: "Open" },
      { Name: "Dinner", Status: "Open" },
    ],
  };
  assert.deepEqual(mealsOn(day), ["Breakfast", "Lunch", "Dinner"]);
  assert.ok(MEALS.includes("Late Lunch"), "the fallback list still offers it before a menu loads");
});

test("a closed meal is not offered", () => {
  const day = {
    Meals: [
      { Name: "Breakfast", Status: "Closed" },
      { Name: "Dinner", Status: "Open" },
    ],
  };
  assert.deepEqual(mealsOn(day), ["Dinner"]);
});

test("mealsOn survives a missing or malformed payload", () => {
  assert.deepEqual(mealsOn(null), []);
  assert.deepEqual(mealsOn({}), []);
  assert.deepEqual(mealsOn({ Meals: [{}] }), []);
});

test("the quota is what is LEFT of the day, not a third of it", () => {
  // the whole point: a tray picked at 7pm knows breakfast and lunch happened
  assert.deepEqual(
    quotaFor({ calories: 3700, protein: 180 }, { calories: 2600, protein: 130 }, 1),
    { calories: 1100, protein: 50 },
  );
});

test("the quota splits across the slots that remain", () => {
  assert.deepEqual(
    quotaFor({ calories: 3000, protein: 150 }, { calories: 0, protein: 0 }, 3),
    { calories: 1000, protein: 50 },
  );
});

test("an already-met day asks for zero rather than a negative tray", () => {
  const q = quotaFor({ calories: 3700, protein: 180 }, { calories: 4000, protein: 200 }, 1);
  assert.equal(q.calories, 0);
  assert.equal(q.protein, 0);
});

test("a profile with no targets does not produce a NaN quota", () => {
  const q = quotaFor({ calories: 0, protein: 0 }, { calories: 0, protein: 0 }, 0);
  assert.ok(Number.isFinite(q.calories) && Number.isFinite(q.protein));
});
