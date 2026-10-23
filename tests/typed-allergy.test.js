// Mise 2.0, I-02 / A-09: a typed avoid word that names a family means the
// family. A guest who typed "cheese" was served the Fri enchilada bake (sharp
// cheddar) and the Sat aglio e olio (parmesan).
import test from "node:test";
import assert from "node:assert/strict";
import { avoidTermsFromAllergens, typedAvoidTerms } from "../app/lib/targets.js";
import { withCurrentAllergenTerms } from "../app/lib/store.js";
import { recipeConflicts } from "../app/lib/plan.js";

const dish = (/** @type {string} */ id, /** @type {string[]} */ foods) => ({
  id,
  ingredients: foods.map((food) => ({ food, qty: 1, unit: "x" })),
});
const enchiladas = dish("enchilada-bake", ["chicken thigh", "sharp cheddar", "corn tortillas"]);
const aglio = dish("aglio-e-olio", ["spaghetti", "garlic", "parmesan"]);
const curry = dish("coconut-curry", ["chicken thigh", "coconut milk", "curry paste"]);

test("typed cheese catches cheddar and parmesan, and leaves a cheese-free dinner alone", () => {
  const avoid = avoidTermsFromAllergens([], "cheese");
  assert.ok(recipeConflicts(enchiladas, undefined, avoid).length > 0, "cheddar refused");
  assert.ok(recipeConflicts(aglio, undefined, avoid).length > 0, "parmesan refused");
  assert.deepEqual(recipeConflicts(curry, undefined, avoid), [], "the curry still passes");
});

test("family words in any case or plural bring the family", () => {
  for (const [word, must] of [
    ["Cheeses", "mozzarella"],
    ["dairy", "whey"],
    ["milk", "butter"],
    ["Tree nuts", "cashew"],
    ["nuts", "pesto"],
    ["eggs", "mayo"],
    ["shellfish", "shrimp"],
    ["seafood", "anchovy"],
    ["gluten", "gnocchi"],
    ["soy", "tamari"],
    ["sesame", "hummus"],
    ["peanuts", "peanut"],
  ]) {
    assert.ok(typedAvoidTerms(word).includes(must), `${word} -> ${must}`);
  }
  assert.deepEqual(typedAvoidTerms(" Cilantro "), ["cilantro"], "a plain word stays itself");
  assert.deepEqual(typedAvoidTerms(""), []);
});

test("a stored profile with only a typed word is widened on read (old guests too)", () => {
  const stored = { avoidIngredients: ["cheese"] };
  const t = withCurrentAllergenTerms(stored);
  assert.ok(t.avoidIngredients.includes("cheddar"));
  assert.ok(t.avoidIngredients.includes("parmesan"));
  assert.equal(t.avoidIngredients[0], "cheese", "the stored word stays first");
  assert.ok(recipeConflicts(enchiladas, undefined, t.avoidIngredients).length > 0);
  // only adds: a profile with nothing to add comes back as the same object
  const plain = { avoidIngredients: ["cilantro"] };
  assert.equal(withCurrentAllergenTerms(plain), plain);
});

test("pensieve's 10/19 gaps are closed", () => {
  const sesame = avoidTermsFromAllergens(["sesame"], "");
  const soy = avoidTermsFromAllergens(["soy"], "");
  const dairy = avoidTermsFromAllergens(["dairy"], "");
  assert.ok(recipeConflicts(dish("a", ["hummus"]), undefined, sesame).length > 0);
  assert.ok(recipeConflicts(dish("b", ["everything bagel seasoning"]), undefined, sesame).length > 0);
  assert.ok(recipeConflicts(dish("c", ["textured vegetable protein"]), undefined, soy).length > 0);
  assert.ok(recipeConflicts(dish("d", ["semisweet chocolate chips"]), undefined, dairy).length > 0);
  assert.ok(recipeConflicts(dish("e", ["semisweet chocolate chips"]), undefined, soy).length > 0);
});

test("a typed word that names an Object property never throws (Tribunal Red Team, 2.0 loop 1)", () => {
  for (const w of ["constructor", "constructors", "__proto__", "toString", "hasOwnProperty"]) {
    assert.deepEqual(typedAvoidTerms(w), [w.toLowerCase()], w);
  }
  assert.ok(withCurrentAllergenTerms({ avoidIngredients: ["constructor"] }));
});
