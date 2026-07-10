import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RECIPES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "seed-data",
  "generated",
  "recipes",
);

const FOOD_GROUP_KEYS = [
  "beans",
  "berries",
  "otherFruit",
  "cruciferousVeg",
  "greens",
  "otherVeg",
  "flaxseed",
  "nuts",
  "spicesHerbs",
  "wholeGrains",
  "beverages",
];
const METHOD_ENUM = ["estimated", "book-verified"];

const files = fs.readdirSync(RECIPES_DIR).filter((f) => f.endsWith(".json"));
const recipes = files.map((f) => ({
  file: f,
  data: JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, f), "utf8")),
}));

test("every recipe file has a foodGroups object with exactly the 11 keys plus method", () => {
  for (const { file, data } of recipes) {
    assert.ok(data.foodGroups, `${file} is missing foodGroups`);
    const keys = Object.keys(data.foodGroups).sort();
    const expected = [...FOOD_GROUP_KEYS, "method"].sort();
    assert.deepEqual(keys, expected, `${file} foodGroups keys mismatch`);
  }
});

test("every foodGroups serving value is numeric", () => {
  for (const { file, data } of recipes) {
    for (const key of FOOD_GROUP_KEYS) {
      assert.equal(
        typeof data.foodGroups[key],
        "number",
        `${file} foodGroups.${key} should be numeric`,
      );
    }
  }
});

test("foodGroups.method is a string enum of estimated|book-verified", () => {
  for (const { file, data } of recipes) {
    assert.equal(typeof data.foodGroups.method, "string", `${file} method should be a string`);
    assert.ok(
      METHOD_ENUM.includes(data.foodGroups.method),
      `${file} method "${data.foodGroups.method}" not in ${METHOD_ENUM}`,
    );
  }
});

test("no recipe tagged plant-forward has zero beans, greens, cruciferousVeg, and otherVeg", () => {
  for (const { file, data } of recipes) {
    if (!(data.tags || []).includes("plant-forward")) continue;
    const fg = data.foodGroups;
    const sum = (fg.beans || 0) + (fg.greens || 0) + (fg.cruciferousVeg || 0) + (fg.otherVeg || 0);
    assert.ok(
      sum > 0,
      `${file} is tagged plant-forward but beans+greens+cruciferousVeg+otherVeg === 0`,
    );
  }
});
