// RECIPE FROM A LINK, "USE IT THIS WEEK" (David, 2026-10-18: "give you the
// link to the recipe online and you generate a recipe that complies with
// everything and you add it into the system"). P12, P3: a scanned recipe
// goes on a shared dinner only when every seated person's screen passes.
import test from "node:test";
import assert from "node:assert/strict";
import { useRecipeOnTable } from "../app/lib/tables.js";

const table = (over = {}) => ({
  id: "b-k-2026-10-20-dinner",
  name: "Kitchen",
  date: "2026-10-20",
  slot: "dinner",
  recipeId: "chili",
  seats: [
    { id: "david", servings: 1 },
    { id: "elliot", servings: 0.75 },
  ],

  tailor: { seats: {}, cook: [] },
  ...over,
});
const satay = {
  id: "hbp-chicken-satay-2026-10-18",
  name: "Chicken Satay",
  ingredients: [{ qty: 3, unit: "tbsp", food: "peanut butter" }],
};
const curry = {
  id: "hbp-coconut-curry-2026-10-18",
  name: "Coconut Curry",
  ingredients: [{ qty: 400, unit: "ml", food: "coconut milk" }],
};
const targets = new Map([
  ["david", { diet: "omnivore", avoidIngredients: [] }],
  ["elliot", { diet: "omnivore", avoidIngredients: ["peanut"] }],
]);
const name = (/** @type {string} */ id) => id;

test("a linked recipe goes on the shared dinner only when everyone at the table can eat it", () => {
  const ok = useRecipeOnTable({ tables: [table()] }, table().id, curry, targets, name);
  assert.ok("events" in ok);
  const t = ok.events.tables[0];
  assert.equal(t?.recipeId, curry.id);
  assert.equal(/** @type {any} */ (t).pinned, true, "pinned, so SET MY WEEK keeps it");
  assert.equal(/** @type {any} */ (t).pot, undefined, "the old dish's pot does not carry over");
  assert.equal(/** @type {any} */ (t).tailor, undefined);

  const no = useRecipeOnTable({ tables: [table()] }, table().id, satay, targets, name);
  assert.ok("refused" in no);
  assert.match(no.refused.join(" "), /elliot/, "says who it is unsafe for");
});

test("an unreadable profile refuses (fail closed), a cooked dinner is never swapped, a missing one says so", () => {
  const blind = new Map([...targets, ["elliot", null]]);
  assert.ok("refused" in useRecipeOnTable({ tables: [table()] }, table().id, curry, blind, name));
  assert.ok(
    "refused" in
      useRecipeOnTable({ tables: [table({ cookedAt: "2026-10-20" })] }, table().id, curry, targets, name),
  );
  assert.ok("refused" in useRecipeOnTable({ tables: [] }, "nope", curry, targets, name));
});

test("a seat skipped at that dinner is not screened against the dish", () => {
  const skipped = table({
    seats: [
      { id: "david", servings: 1 },
      { id: "elliot", servings: 0.75, status: "skipped" },
    ],
  });
  assert.ok("events" in useRecipeOnTable({ tables: [skipped] }, skipped.id, satay, targets, name));
});

test("Tribunal v1.7b: the leftover nights that eat the pot are screened and rewritten with it", () => {
  const cook = table({ seats: [{ id: "david", servings: 1 }, { id: "elliot", servings: 0.75, status: "skipped" }] });
  const left = table({
    id: "b-k-2026-10-22-dinner",
    date: "2026-10-22",
    leftoverOf: cook.id,
    seats: [{ id: "david", servings: 1 }, { id: "elliot", servings: 0.75 }],
  });
  const peanut = useRecipeOnTable({ tables: [cook, left] }, cook.id, satay, targets, name);
  assert.ok("refused" in peanut, "elliot eats the pot on the leftover night, so a peanut pot is refused");
  const ok = useRecipeOnTable({ tables: [cook, left] }, cook.id, curry, targets, name);
  assert.ok(!("refused" in ok));
  const out = /** @type {any} */ (ok).events.tables;
  assert.deepEqual(out.map((x) => x.recipeId), [curry.id, curry.id], "the leftover night eats the new pot");
  assert.equal(out[1].pinned, undefined, "only the cook night is pinned");
});

test("Tribunal v1.7b: a leftover night or an already-bought pot is never swapped", () => {
  const left = table({ leftoverOf: "b-k-2026-10-19-dinner" });
  assert.ok("refused" in useRecipeOnTable({ tables: [left] }, left.id, curry, targets, name));
  const bought = table({ pot: "solved-for-chili" });
  assert.ok("refused" in useRecipeOnTable({ tables: [bought] }, bought.id, curry, targets, name));
});

test("a plural avoid word catches its singular: 'peanuts' refuses peanut butter (2026-10-18)", async () => {
  const { recipeConflicts } = await import("../app/lib/plan.js");
  const satayish = { id: "s", ingredients: [{ food: "peanut butter" }] };
  assert.deepEqual(recipeConflicts(satayish, "omnivore", ["peanuts"]), ["contains peanut"]);
  assert.deepEqual(recipeConflicts({ id: "t", ingredients: [{ food: "cashew" }] }, "omnivore", ["cashews"]), ["contains cashew"]);
  assert.deepEqual(recipeConflicts({ id: "u", ingredients: [{ food: "rice" }] }, "omnivore", ["peanuts"]), []);
});
