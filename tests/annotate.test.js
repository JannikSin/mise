import test from "node:test";
import assert from "node:assert/strict";
import { dinerFacts } from "../app/lib/annotate.js";

// The failure this pins (P2 gate2 C1): a failed targets read used to collapse
// into avoid:[] — indistinguishable from a clean profile — so an offline or
// corrupt profile looked allergy-free to every AI surface.

test("a FAILED read is unconfirmed, never a clean empty avoid list", () => {
  const failed = dinerFacts("mom", "Mom", null);
  assert.equal(failed.unconfirmed, true, "null (read/parse failure) must be distinguishable");
  assert.deepEqual(failed.avoid, []);

  const clean = dinerFacts("mom", "Mom", {});
  assert.equal(clean.unconfirmed, false, "a read that succeeded with no restrictions is clean");
  assert.deepEqual(clean.avoid, []);
});

test("a real targets file maps through unchanged", () => {
  const t = {
    phase: "gain",
    macros: { calories: 3700, protein: 210 },
    diet: "omnivore",
    avoidIngredients: ["peanut", "shrimp"],
    avoidRecipes: ["office-lunch-box"],
  };
  assert.deepEqual(dinerFacts("david", "David", t), {
    id: "david",
    name: "David",
    goal: "gain",
    calories: 3700,
    protein: 210,
    diet: "omnivore",
    avoid: ["peanut", "shrimp"],
    avoidRecipes: ["office-lunch-box"],
    unconfirmed: false,
  });
});
