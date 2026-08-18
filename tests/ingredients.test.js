import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalFood,
  canonicalUnit,
  dimensionOf,
  toGrams,
  toPreferred,
  mergeIdentity,
  aisleOf,
  knownFoods,
  AISLES,
} from "../app/lib/ingredients.js";

test("canonicalUnit collapses the count spellings the bank actually uses", () => {
  // onion alone ships as each/unit/whole/medium/large; all mean one onion
  for (const u of ["each", "unit", "whole", "medium", "large", "small", "piece"]) {
    assert.equal(canonicalUnit(u), "each", `${u} should be a count`);
  }
  assert.equal(canonicalUnit("cups"), "cup");
  assert.equal(canonicalUnit("Tablespoons"), "tbsp");
  assert.equal(canonicalUnit("  G "), "g");
});

test("canonicalFood strips prep suffixes and applies the alias table", () => {
  assert.equal(canonicalFood("silken tofu, cubed"), "silken-tofu");
  assert.equal(canonicalFood("green beans, trimmed"), "green-beans");
  assert.equal(canonicalFood("broccoli florets"), "broccoli");
  assert.equal(canonicalFood("Mushrooms"), "mushroom");
  assert.equal(canonicalFood("butter"), "unsalted-butter");
  assert.equal(canonicalFood("chili flakes"), "red-pepper-flakes");
});

test("canonicalFood NEVER merges things that are different products", () => {
  // each of these would be a real cooking error, and two of them a nutrition one
  assert.notEqual(canonicalFood("fresh ginger"), canonicalFood("ground ginger"));
  assert.notEqual(canonicalFood("brown rice"), canonicalFood("cooked brown rice"));
  assert.notEqual(canonicalFood("lemon"), canonicalFood("lemon juice"));
  assert.notEqual(canonicalFood("silken tofu"), canonicalFood("extra-firm tofu"));
  assert.notEqual(canonicalFood("mixed berries"), canonicalFood("frozen mixed berries"));
});

test("an unknown food keeps its unit in the id, so nothing mis-merges", () => {
  const a = mergeIdentity("dragon fruit", "each");
  const b = mergeIdentity("dragon fruit", "g");
  assert.notEqual(a.id, b.id, "an unknown food must behave exactly as it did before");
  assert.equal(a.qty(3), null, "and must never invent a conversion");
});

test("same-dimension conversion needs no per-food data", () => {
  assert.equal(dimensionOf("tbsp"), "volume");
  assert.equal(dimensionOf("lb"), "mass");
  assert.equal(dimensionOf("each"), "count");
  // 3 tsp is 1 tbsp
  const r = toPreferred(3, "tsp", "olive-oil");
  assert.equal(r?.unit, "tbsp");
  assert.ok(Math.abs(r.qty - 1) < 1e-6, `expected 1 tbsp, got ${r?.qty}`);
});

test("broccoli, David's actual complaint, merges to ONE row across three units", () => {
  // the bank writes broccoli as cup x7, g x2 and head x1
  const ident = mergeIdentity("broccoli", "cup");
  assert.equal(mergeIdentity("broccoli", "g").id, ident.id);
  assert.equal(mergeIdentity("broccoli", "head").id, ident.id);
  assert.equal(mergeIdentity("broccoli florets", "cup").id, ident.id);
  // and the quantities land in one comparable unit
  assert.equal(toPreferred(1, "cup", "broccoli")?.unit, "g");
  assert.ok(Math.abs(toPreferred(1, "cup", "broccoli").qty - 91) < 1e-6);
  assert.ok(Math.abs(toPreferred(1, "head", "broccoli").qty - 600) < 1e-6);
});

test("toGrams crosses dimensions only when the food's weight is known", () => {
  assert.ok(Math.abs(toGrams(2, "cup", "rolled-oats") - 180) < 1e-6);
  assert.ok(Math.abs(toGrams(1, "can", "chickpeas") - 425) < 1e-6);
  assert.ok(Math.abs(toGrams(1, "lb", "chicken-breast") - 453.59237) < 1e-4);
  assert.equal(toGrams(1, "cup", "unknown-food"), null);
  assert.equal(toGrams(1, "flagon", "broccoli"), null);
});

test("spices stay readable: a pinch merges into tsp, never into fluid ounces", () => {
  // the failure this prevents: normalizing to a raw base rendered
  // "2 tsp paprika" as "0.3 fl oz (10 ml)"
  assert.equal(toPreferred(8, "pinch", "cayenne")?.unit, "tsp");
  assert.ok(Math.abs(toPreferred(16, "pinch", "cayenne").qty - 1) < 1e-3);
  assert.equal(toPreferred(1, "tbsp", "black-pepper")?.unit, "tsp");
});

test("aisleOf covers the taxonomy and falls back honestly", () => {
  assert.equal(aisleOf("frozen mixed vegetables"), "frozen", "frozen must beat produce");
  assert.equal(aisleOf("salmon fillet"), "seafood");
  assert.equal(aisleOf("chicken breast"), "meat");
  assert.equal(aisleOf("greek yogurt"), "dairy");
  assert.equal(aisleOf("baby spinach"), "produce");
  assert.equal(aisleOf("whole wheat pita"), "bakery");
  assert.equal(aisleOf("smoked paprika"), "spices");
  assert.equal(aisleOf("something nobody has ever cooked"), "other");
  for (const food of ["broccoli", "olive oil", "rolled oats", "soy sauce"]) {
    assert.ok(AISLES.includes(aisleOf(food)), `${food} landed outside the aisle list`);
  }
});

// DRIFT GUARD. The real bank lives in the private mise-data repo; this repo
// only carries the seed sample. A new recipe with a novel spelling must show
// up here as a named diff, not as a silent duplicate row on the list.
test("drift guard: every multi-unit food in the seed bank is known to the table", () => {
  const dir = path.join(import.meta.dirname, "..", "seed-data", "generated", "recipes");
  if (!fs.existsSync(dir)) return; // seed data is optional in a bare checkout

  /** @type {Map<string, Set<string>>} */
  const unitsByFood = new Map();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const recipe = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const ing of recipe.ingredients ?? []) {
      const key = canonicalFood(ing.food);
      if (!unitsByFood.has(key)) unitsByFood.set(key, new Set());
      unitsByFood.get(key).add(canonicalUnit(ing.unit));
    }
  }

  const known = new Set(knownFoods());
  const splitAndUnknown = [...unitsByFood]
    .filter(([key, units]) => units.size > 1 && !known.has(key))
    .map(([key, units]) => `${key} (${[...units].join(", ")})`);

  assert.deepEqual(
    splitAndUnknown,
    [],
    `these foods appear in more than one unit but the table does not know them, so they will\n` +
      `each show up as several rows on the shopping list. Add them to FOOD_UNITS:\n  ` +
      splitAndUnknown.join("\n  "),
  );
});

test("canonicalFood strips parentheticals: packaging is not identity (fix 0.3)", () => {
  // the live bug: onHand "Oats (large container)" never matched list "rolled oats"
  assert.equal(canonicalFood("Oats (large container)"), canonicalFood("rolled oats"));
  assert.equal(canonicalFood("black beans (15 oz can)"), canonicalFood("black beans"));
  assert.equal(canonicalFood("baby spinach (5 oz clamshell)"), "baby-spinach");
});
