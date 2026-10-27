// Mise 2.0 B3: every reader of ANOTHER person's targets gives the same answer
// from the plate card as from the full targets (plan section 4.1, N1 BLOCK).
// The diner is vegetarian, allergic to peanut, with a never-again recipe: if
// the plate lost `diet` the screen would fail OPEN (dinerFacts defaults to
// omnivore), which is exactly what this test exists to catch.
import test from "node:test";
import assert from "node:assert/strict";
import { plateOf } from "../app/lib/plate-of.js";
import { seatScreen, plateRefusal, ruleRecipeCheck, seatServingsRaw, slotShareFor, brigadePool } from "../app/lib/tables.js";
import { dinerFacts, screenTextForDiners } from "../app/lib/annotate.js";
import { synthesize, solveSeat } from "../app/lib/synth.js";
import { memberCoverage, planBrigadeWeek } from "../app/lib/compose.js";
import { buildServe } from "../app/lib/serve.js";
import { freshDb, SKIP } from "./_pglite.js";

const FULL = {
  diet: "vegetarian",
  allergens: ["peanut"],
  allergensFreeText: "",
  avoidIngredients: ["peanut", "groundnut"],
  avoidRecipes: ["never-again"],
  dislikeIngredients: ["okra"],
  cuisinePrefs: { loved: ["thai"], avoided: ["british"] },
  fixedSlots: { breakfast: "oats" },
  skipSlots: ["snack"],
  mealSlots: ["breakfast", "lunch", "dinner"],
  slotAvoid: { breakfast: ["egg"] },
  breakfastStyle: "grab-and-go",
  snackPortable: true,
  dinnerAnchor: true,
  phase: "gain",
  weeklyBudgetUsd: 90,
  macros: { calories: 3200, protein: 170, fat: 100, carbs: 400, caloriesFloor: 3000, caloriesCeiling: 3400, proteinAim: 180, plateCaloriesCap: 1400, plateProteinCapG: 80, waterLiters: 3.5 },
  currencies: [{ id: "swipes", name: "Dining swipes", unit: "swipe", perWeek: 10, expires: "weekly", venue: "buffet", toGo: true, preferredSlot: "lunch", estProtein: 60 }],
  // owner-only, and must not matter to any reader below
  body: { sex: "f", age: 33, heightIn: 66, weightLb: 150 },
  goalWeightLb: 155,
  targetReason: "a private reason",
  supplementPlan: [{ id: "fishOil" }],
  region: { country: "USA", state: "IN" },
  maxWeeknightMinutes: 20,
  equipment: ["blender"],
  snackAppetite: "meals",
};
const PLATE = plateOf(FULL);

const dish = (/** @type {string} */ id, /** @type {string[]} */ foods, extra = {}) => ({
  id,
  name: id,
  mealType: "dinner",
  servings: 2,
  nutrition: { calories: 700, protein: 40 },
  ingredients: foods.map((food) => ({ food, qty: 200, unit: "g" })),
  ...extra,
});
const CHICKEN = dish("chicken-rice", ["chicken breast", "rice"]);
const PEANUT = dish("peanut-noodles", ["noodles", "peanut butter"]);
const NEVER = dish("never-again", ["lentils"]);
const CLEAN = dish("lentil-curry", ["lentils", "rice", "spinach"], { assembly: "plated" });
const DISHES = [CHICKEN, PEANUT, NEVER, CLEAN];

test("the plate keeps what the screen needs and drops the private keys", () => {
  assert.equal(PLATE.diet, "vegetarian");
  assert.equal("body" in PLATE, false);
  assert.equal("targetReason" in PLATE, false);
});

test("seatScreen and plateRefusal refuse identically, with the same reasons", () => {
  for (const r of DISHES) {
    assert.deepEqual(seatScreen(r, PLATE), seatScreen(r, FULL), r.id);
    assert.deepEqual(plateRefusal(r, PLATE), plateRefusal(r, FULL), r.id);
  }
  // and they really refuse: chicken (vegetarian), peanut, never-again
  assert.ok(seatScreen(CHICKEN, PLATE).length > 0);
  assert.ok(seatScreen(PEANUT, PLATE).length > 0);
  assert.ok(seatScreen(NEVER, PLATE).length > 0);
  assert.deepEqual(seatScreen(CLEAN, PLATE), []);
});

test("ruleRecipeCheck reads the same from the plate", () => {
  for (const r of DISHES) {
    assert.deepEqual(
      ruleRecipeCheck(r, [{ id: "d", name: "Diner", targets: PLATE }]),
      ruleRecipeCheck(r, [{ id: "d", name: "Diner", targets: FULL }]),
      r.id,
    );
  }
});

test("dinerFacts: diet is vegetarian, not the omnivore default", () => {
  const a = dinerFacts("d", "Diner", PLATE);
  assert.deepEqual(a, dinerFacts("d", "Diner", FULL));
  assert.equal(a.diet, "vegetarian");
  const text = "Peanut satay chicken with rice";
  assert.deepEqual(screenTextForDiners(text, [a]), screenTextForDiners(text, [dinerFacts("d", "Diner", FULL)]));
});

test("seat servings and slot shares match on every slot", () => {
  for (const slot of ["breakfast", "lunch", "dinner", "snack", "smoothie"]) {
    assert.equal(slotShareFor(PLATE, slot), slotShareFor(FULL, slot), slot);
    for (const r of DISHES) assert.equal(seatServingsRaw(PLATE, slot, r), seatServingsRaw(FULL, slot, r), `${slot} ${r.id}`);
  }
});

test("solveSeat and synthesize give the same plates and pot", () => {
  const seat = { id: "d", servings: 1.5, rawServings: 1.5 };
  const share = slotShareFor(FULL, "dinner");
  assert.deepEqual(
    solveSeat({ recipe: CLEAN, assembly: "plated", seat, targets: PLATE, slotShare: share }),
    solveSeat({ recipe: CLEAN, assembly: "plated", seat, targets: FULL, slotShare: share }),
  );
  const run = (/** @type {any} */ t) =>
    synthesize({
      recipe: CLEAN,
      seats: [seat, { id: "e", servings: 1 }],
      targetsById: new Map([["d", t], ["e", { macros: { calories: 2000, protein: 100 }, mealSlots: ["lunch", "dinner"] }]]),
      slotShares: { d: share, e: 0.5 },
    });
  assert.deepEqual(run(PLATE), run(FULL));
});

test("serve instructions match", () => {
  const t = { id: "t1", date: "2026-10-28", slot: "dinner", recipeId: CLEAN.id, seats: [{ id: "d", servings: 1.5 }, { id: "e", servings: 1 }] };
  const order = [{ id: "d", name: "Diner" }, { id: "e", name: "Eater" }];
  const rules = (/** @type {any} */ x) => ({ d: { diet: x.diet, avoidIngredients: x.avoidIngredients, avoidRecipes: x.avoidRecipes }, e: null });
  assert.deepEqual(buildServe(/** @type {any} */ (t), CLEAN, order, rules(PLATE)), buildServe(/** @type {any} */ (t), CLEAN, order, rules(FULL)));
});

test("brigade members, pool, coverage and the generated week match", () => {
  const BANK = new Map(DISHES.map((r) => [r.id, r]));
  const memberOf = (/** @type {any} */ t) => ({
    id: "d",
    diet: t.diet,
    avoid: t.avoidIngredients,
    avoidRecipes: t.avoidRecipes,
    slotAvoid: t.slotAvoid,
    breakfastStyle: t.breakfastStyle,
    snackPortable: t.snackPortable === true,
    dinnerAnchor: t.dinnerAnchor === true,
  });
  for (const slot of ["breakfast", "lunch", "dinner"]) {
    assert.deepEqual(brigadePool(BANK, [memberOf(PLATE)], slot), brigadePool(BANK, [memberOf(FULL)], slot), slot);
  }
  const dates = ["2026-10-25", "2026-10-26", "2026-10-27"];
  const plan = { week: "2026-W44", entries: [{ id: "x", date: "2026-10-26", slot: "lunch", recipeId: "lentil-curry", pinned: true }] };
  const cov = (/** @type {any} */ t) => memberCoverage(t, plan, dates, new Set(["dinner"]), BANK, "2026-10-25");
  assert.deepEqual(cov(PLATE), cov(FULL));

  const profilesById = new Map([["d", { id: "d", household: "house-a" }], ["e", { id: "e", household: "house-a" }]]);
  const brigade = { id: "b1", name: "Two", memberIds: ["d", "e"], slots: ["dinner", "lunch"], cookId: "e", from: "2026-10-25", until: "2026-10-31" };
  const ctx = (/** @type {any} */ t) => ({
    dates: ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"],
    today: "2026-10-25",
    house: "house-a",
    profilesById,
    targetsById: new Map([["d", t], ["e", { macros: { calories: 2200, protein: 120 }, mealSlots: ["breakfast", "lunch", "dinner"] }]]),
    plansById: new Map([["d", plan]]),
    bankById: BANK,
  });
  const a = planBrigadeWeek({ tables: [] }, /** @type {any} */ (brigade), /** @type {any} */ (ctx(PLATE)));
  const b = planBrigadeWeek({ tables: [] }, /** @type {any} */ (brigade), /** @type {any} */ (ctx(FULL)));
  assert.deepEqual(a, b);
  assert.ok(a.made > 0, "the week really generated");
  for (const t of a.events.tables) assert.notEqual(t.recipeId, "chicken-rice", "the vegetarian screen held");
});

test("the kitchen budget and the housemates' swipes read the same", () => {
  // app/main.js 4192 to 4196 and 4263 to 4270 at 6ea52d8, the same expressions
  const budget = (/** @type {any} */ t) => Number(t?.weeklyBudgetUsd);
  const swipe = (/** @type {any} */ t) => {
    const b = (t?.currencies ?? []).find((/** @type {any} */ c) => c.venue === "buffet" && Number(c.perWeek) > 0);
    return b ? String(b.preferredSlot || "lunch") : null;
  };
  assert.equal(budget(PLATE), budget(FULL));
  assert.equal(swipe(PLATE), swipe(FULL));
  assert.equal(swipe(PLATE), "lunch");
});

test("the SQL plate gives the same screens as the full targets", { skip: SKIP }, async () => {
  const db = await freshDb();
  const sqlPlate = (await db.query("select private.plate_of($1::jsonb) as p", [JSON.stringify(FULL)])).rows[0].p;
  assert.deepEqual(sqlPlate, PLATE);
  for (const r of DISHES) assert.deepEqual(seatScreen(r, sqlPlate), seatScreen(r, FULL), r.id);
  await db.close();
});
