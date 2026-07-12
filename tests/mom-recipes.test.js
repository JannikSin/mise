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
  "profiles",
  "mom",
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

// Mom's pool is Mediterranean/European only, no East Asian dishes (David's hard
// constraint). This is the closed list of cuisine strings this check rejects.
const ASIAN_CUISINES = [
  "korean",
  "japanese",
  "chinese",
  "thai",
  "vietnamese",
  "indonesian",
  "asian",
  "east-asian",
];

const CALORIE_CEILING = 650; // her pool is a loss pool, not a gain-phase bowl

const files = fs.readdirSync(RECIPES_DIR).filter((f) => f.endsWith(".json"));
assert.ok(files.length > 0, "mom recipes directory should not be empty");

const recipes = files.map((f) => ({
  file: f,
  data: JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, f), "utf8")),
}));

test("every mom recipe file has a foodGroups object with exactly the 11 keys plus method", () => {
  for (const { file, data } of recipes) {
    assert.ok(data.foodGroups, `${file} is missing foodGroups`);
    const keys = Object.keys(data.foodGroups).sort();
    const expected = [...FOOD_GROUP_KEYS, "method"].sort();
    assert.deepEqual(keys, expected, `${file} foodGroups keys mismatch`);
  }
});

test("every mom recipe foodGroups serving value is numeric", () => {
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

test("mom foodGroups.method is a string enum of estimated|book-verified", () => {
  for (const { file, data } of recipes) {
    assert.equal(typeof data.foodGroups.method, "string", `${file} method should be a string`);
    assert.ok(
      METHOD_ENUM.includes(data.foodGroups.method),
      `${file} method "${data.foodGroups.method}" not in ${METHOD_ENUM}`,
    );
  }
});

test("no mom recipe exceeds the ~650 kcal/serving loss-pool ceiling", () => {
  for (const { file, data } of recipes) {
    assert.ok(data.nutrition && typeof data.nutrition.calories === "number", `${file} is missing nutrition.calories`);
    assert.ok(
      data.nutrition.calories <= CALORIE_CEILING,
      `${file} is ${data.nutrition.calories} kcal/serving, over the ${CALORIE_CEILING} kcal loss-pool ceiling`,
    );
  }
});

test("no mom recipe is tagged with an Asian cuisine", () => {
  for (const { file, data } of recipes) {
    const cuisine = (data.cuisine || "").toLowerCase();
    assert.ok(
      !ASIAN_CUISINES.includes(cuisine),
      `${file} has cuisine "${data.cuisine}", which violates the Mediterranean/European-only, no-East-Asian constraint`,
    );
  }
});
