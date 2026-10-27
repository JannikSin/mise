// Mise 2.0 B2: the plate card (plan section 4.1). private.plate_of and its JS
// port app/lib/plate-of.js agree, keep only PLATE_FIELDS, cut currencies,
// strip slot notes and drop water.
import test from "node:test";
import assert from "node:assert/strict";
import { plateOf } from "../app/lib/plate-of.js";
import { PLATE_FIELDS, OWNER_ONLY_FIELDS } from "../app/lib/plate-fields.js";
import { freshDb, SKIP } from "./_pglite.js";
import { targetsFor } from "./_world.js";

const FULL = targetsFor("guest-x", {
  mealSlots: ["breakfast", { slot: "dinner", note: "private note", notes: ["x"], at: "18:30" }],
  currencies: [
    { id: "swipes", name: "Dining swipes", unit: "swipe", perWeek: 7, expires: "weekly", venue: "buffet", toGo: true, preferredSlot: "lunch", estCalories: 900, estProtein: 60 },
    "odd",
  ],
  fixedSlots: { breakfast: "oats" },
  snackStyle: "sweet",
  priorityStack: ["Sleep"],
});

const SAMPLES = [
  FULL,
  {},
  { diet: "vegan" },
  { macros: { waterLiters: 3 } },
  { macros: "not an object", currencies: "nope", mealSlots: {} },
  { body: { weightLb: 200 }, region: { state: "IN" } },
  { allergens: [], avoidRecipes: null, weeklyBudgetUsd: 0 },
];

test("plateOf keeps only plate fields and trims the three nested ones", () => {
  const p = plateOf(FULL);
  for (const k of Object.keys(p)) assert.ok(PLATE_FIELDS.includes(k), k);
  for (const k of OWNER_ONLY_FIELDS) assert.equal(k in p, false, k);
  assert.equal(p.diet, "vegetarian");
  assert.deepEqual(p.macros, { calories: 3000, protein: 160, fat: 90, carbs: 380 });
  assert.deepEqual(p.currencies, [
    { id: "swipes", unit: "swipe", perWeek: 7, expires: "weekly", venue: "buffet", toGo: true, preferredSlot: "lunch", estCalories: 900, estProtein: 60 },
    "odd",
  ]);
  assert.deepEqual(p.mealSlots, ["breakfast", { slot: "dinner", at: "18:30" }]);
  assert.deepEqual(plateOf(null), {});
  assert.deepEqual(plateOf([1, 2]), {});
});

test("SQL plate_of equals the JS port on every sample", { skip: SKIP }, async () => {
  const db = await freshDb();
  for (const s of [...SAMPLES, [1], "text", null]) {
    const r = await db.query("select private.plate_of($1::jsonb) as p", [JSON.stringify(s)]);
    assert.deepEqual(r.rows[0].p, plateOf(s), JSON.stringify(s));
  }
  await db.close();
});
