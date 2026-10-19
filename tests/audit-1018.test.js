// The 2026-10-18 phone audit (monolith): the fixes that protect safety and
// David's one list, pinned so they cannot quietly come undone.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEvents, effectiveBuyerOf } from "../app/lib/tables.js";
import { avoidTermsFromAllergens } from "../app/lib/targets.js";
import { recipeConflicts } from "../app/lib/plan.js";

test("take turns: a rule table with no buyer is bought by the rule's shopper, never that night's cook", () => {
  const ev = normalizeEvents({
    brigades: [{ id: "r1", name: "Wayne", memberIds: ["david", "elliot"], slots: ["dinner"], cookId: "david", rotateCooks: true, from: "2026-10-13", until: "2026-11-09" }],
    tables: [
      { id: "a", date: "2026-10-19", slot: "dinner", recipeId: "x", seats: [{ id: "elliot", servings: 1 }, { id: "david", servings: 2 }], cookId: "elliot", fromBrigade: "r1" },
      { id: "b", date: "2026-10-20", slot: "dinner", recipeId: "x", seats: [{ id: "elliot", servings: 1 }], cookId: "elliot", fromBrigade: "r1", buyerId: "elliot" },
    ],
  });
  const profiles = new Map([["david", { id: "david", household: "wayne" }], ["elliot", { id: "elliot", household: "wayne" }]]);
  assert.equal(effectiveBuyerOf(ev.tables[0], "wayne", profiles), "david", "the shopper buys Elliot's night");
  assert.equal(effectiveBuyerOf(ev.tables[1], "wayne", profiles), "elliot", "a buyer claimed by hand still wins");
});

test("allergy chips catch what the audit found passing (dairy, fish, egg, gluten, nuts)", () => {
  const rec = (food) => ({ id: food, ingredients: [{ food, qty: 1, unit: "x" }] });
  const cases = {
    dairy: ["mozzarella", "sharp cheddar", "queso para freir", "basil pesto"],
    fish: ["worcestershire sauce"],
    eggs: ["mayonnaise"],
    gluten: ["potato gnocchi"],
    nuts: ["pine nuts", "basil pesto"],
    soy: ["low-sodium tamari"],
  };
  for (const [chip, foods] of Object.entries(cases)) {
    const avoid = avoidTermsFromAllergens([chip], "");
    for (const f of foods) assert.ok(recipeConflicts(rec(f), "omnivore", avoid).length > 0, `${chip} must refuse ${f}`);
  }
});
