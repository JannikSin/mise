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

test("a Sunday buy day shops Sun to Sat (David, 2026-10-18: \"It should be building from Sunday to Saturday\")", async () => {
  const { tripFor } = await import("../app/lib/plan.js");
  assert.deepEqual(tripFor("2026-W43", "2026-10-18", "2026-10-18", 0), [
    "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24",
  ]);
  assert.equal(tripFor("2026-W43", "2026-10-18", "2026-10-18", 5)?.[0], "2026-10-16", "Friday (the default) opens on the Friday before");
});

test("Anvil's day keys survive a Mise tap and a concurrent write (polaris, 2026-10-18)", async () => {
  const { upsertDay } = await import("../app/lib/targets.js");
  const { mergeFieldWise } = await import("../app/lib/merge.js");
  const base = { days: [{ date: "2026-10-18", water: 4 }] };
  const anvil = { days: [{ date: "2026-10-18", water: 4, trained: { lift: 55, tennis: 60 } }] };
  const mise = upsertDay(base, "2026-10-18", { water: 5 });
  const merged = mergeFieldWise(base, mise, anvil);
  assert.deepEqual(merged.days, [{ date: "2026-10-18", water: 5, trained: { lift: 55, tennis: 60 } }]);
  assert.deepEqual(upsertDay(anvil, "2026-10-18", { water: 6 }).days[0].trained, { lift: 55, tennis: 60 });
});
