import test from "node:test";
import assert from "node:assert/strict";
import {
  upsertDay,
  targetsFromQuestionnaire,
  avoidTermsFromAllergens,
} from "../app/lib/targets.js";

const BASE_Q = {
  sex: "f",
  age: 30,
  heightFt: 5,
  heightIn: 6,
  weightLb: 140,
  activity: 3,
  goal: "maintain",
};

test("upsertDay patches an existing day without touching others", () => {
  const daily = { days: [{ date: "2026-07-05", sleepHours: 8 }] };
  const next = upsertDay(daily, "2026-07-05", { weight: 180.5 });
  assert.deepEqual(next.days, [{ date: "2026-07-05", sleepHours: 8, weight: 180.5 }]);
  assert.deepEqual(daily.days, [{ date: "2026-07-05", sleepHours: 8 }], "no mutation");
});
test("upsertDay creates the day when absent", () => {
  const next = upsertDay({ days: [] }, "2026-07-06", { pushups: 40 });
  assert.deepEqual(next.days, [{ date: "2026-07-06", pushups: 40 }]);
});
test("targetsFromQuestionnaire: loss profile gets Mifflin-St Jeor minus 500, 3 meal slots", () => {
  // 60-year-old woman, 5'4", 160 lb, lightly active, losing:
  // kg=72.57, cm=162.56, BMR = 10*72.57 + 6.25*162.56 - 5*60 - 161 = 1280.7
  // TDEE = 1280.7*1.375 = 1761 ; -500 = 1261 ; rounded to 50 -> 1250
  const t = targetsFromQuestionnaire(
    { sex: "f", age: 60, heightFt: 5, heightIn: 4, weightLb: 160, activity: 2, goal: "loss" },
    "2026-07-12",
  );
  assert.equal(t.macros.calories, 1250);
  assert.equal(t.macros.protein, 144); // 0.9 g/lb
  assert.equal(t.phase, "loss");
  assert.equal(t.phaseSince, "2026-07-12");
  assert.deepEqual(t.mealSlots, ["breakfast", "lunch", "dinner"]);
  assert.ok(t.tracks.includes("waist"));
  assert.equal(t.macros.caloriesFloor, 1200); // floor clamps at 1200
  assert.equal(t.dailyDozen.greens, 2); // Daily Dozen identical for everyone
});
test("targetsFromQuestionnaire: gain profile gets +300, smoothie slot, 1 g/lb protein", () => {
  const t = targetsFromQuestionnaire({
    sex: "m",
    age: 20,
    heightFt: 6,
    heightIn: 0,
    weightLb: 180,
    activity: 4,
    goal: "gain",
  });
  assert.equal(t.phase, "gain");
  assert.equal("phaseSince" in t, false);
  assert.equal(t.macros.protein, 180);
  assert.deepEqual(t.mealSlots, ["breakfast", "lunch", "dinner", "smoothie"]);
  // sanity: a 6-foot active 20-year-old bulking eats a lot
  assert.ok(t.macros.calories > 3000, `calories ${t.macros.calories}`);
  // macros account for roughly all calories (rounding slack < 100 kcal)
  const kcalFromMacros = t.macros.protein * 4 + t.macros.fat * 9 + t.macros.carbs * 4;
  assert.ok(Math.abs(kcalFromMacros - t.macros.calories) < 100);
});
test("targetsFromQuestionnaire: maintain maps to recomp phase, no delta", () => {
  const t = targetsFromQuestionnaire({
    sex: "f",
    age: 30,
    heightFt: 5,
    heightIn: 6,
    weightLb: 140,
    activity: 3,
    goal: "maintain",
  });
  assert.equal(t.phase, "recomp");
  assert.deepEqual(t.mealSlots, ["breakfast", "lunch", "dinner"]);
});
test("targetsFromQuestionnaire: carbs never go negative for a heavy loss profile", () => {
  const t = targetsFromQuestionnaire({
    sex: "f",
    age: 60,
    heightFt: 5,
    heightIn: 0,
    weightLb: 320,
    activity: 1,
    goal: "loss",
  });
  assert.ok(t.macros.carbs >= 0, `carbs ${t.macros.carbs}`);
  assert.ok(t.macros.fat >= 20, `fat floor ${t.macros.fat}`);
  const kcal = t.macros.protein * 4 + t.macros.fat * 9 + t.macros.carbs * 4;
  assert.ok(kcal <= t.macros.calories + 100, `macros ${kcal} vs calories ${t.macros.calories}`);
});
test("avoidTermsFromAllergens: presets expand and dedupe, free-text appends verbatim", () => {
  const terms = avoidTermsFromAllergens(["dairy", "nuts"], "Cilantro, mushrooms");
  assert.ok(terms.includes("cheese")); // from dairy
  assert.ok(terms.includes("almond")); // from nuts
  assert.ok(terms.includes("cilantro")); // free-text, lowercased/trimmed
  assert.ok(terms.includes("mushrooms"));
  // "butter" is in the dairy list once, no dupes even if two presets share it
  assert.equal(terms.filter((t) => t === "butter").length, 1);
  assert.deepEqual(avoidTermsFromAllergens(), []); // absent = empty
});
test("targetsFromQuestionnaire: empty prefs reproduce the pre-survey shape (no new keys)", () => {
  const t = targetsFromQuestionnaire(BASE_Q, "2026-07-17", {});
  for (const k of [
    "diet",
    "allergens",
    "avoidIngredients",
    "snackAppetite",
    "maxWeeknightMinutes",
    "dislikeIngredients",
    "cuisinePrefs",
    "maxDifficulty",
    "equipment",
    "breakfastStyle",
    "budget",
    "stores",
    "shopsPerWeek",
    "tiredOf",
    "region",
    "leftoverTolerance",
    "packsLunch",
    "lunchMicrowave",
  ]) {
    assert.equal(k in t, false, `unexpected key ${k} at default`);
  }
});
test("targetsFromQuestionnaire: richer-survey fields map through, defaults omitted", () => {
  const t = targetsFromQuestionnaire(BASE_Q, "2026-07-17", {
    tiredOf: ["pasta", "stir-fry"],
    state: "IL",
    leftoverTolerance: "lots",
    packsLunch: true,
    lunchMicrowave: true,
  });
  assert.deepEqual(t.tiredOf, ["pasta", "stir-fry"]);
  assert.deepEqual(t.region, { country: "USA", state: "IL" });
  assert.equal(t.leftoverTolerance, "lots");
  assert.equal(t.packsLunch, true);
  assert.equal(t.lunchMicrowave, true);
  // "some" is the default leftover tolerance -> omitted; no state -> no region
  const d = targetsFromQuestionnaire(BASE_Q, "2026-07-17", {
    leftoverTolerance: "some",
    packsLunch: false,
  });
  assert.equal("leftoverTolerance" in d, false);
  assert.equal("region" in d, false);
  assert.equal("packsLunch" in d, false);
  // microwave only recorded when packsLunch is true
  const nolunch = targetsFromQuestionnaire(BASE_Q, "2026-07-17", {
    packsLunch: false,
    lunchMicrowave: true,
  });
  assert.equal("lunchMicrowave" in nolunch, false);
});
test("targetsFromQuestionnaire: survey prefs map to targets fields, defaults omitted", () => {
  const t = targetsFromQuestionnaire(BASE_Q, "2026-07-17", {
    diet: "vegan",
    allergens: ["gluten"],
    allergensFreeText: "mushrooms",
    skipBreakfast: true,
    smoothie: true,
    snackAppetite: "meals",
    maxWeeknightMinutes: 30,
    dislikeIngredients: ["olives"],
    cuisinePrefs: { loved: ["italian"], avoided: ["korean"] },
    maxDifficulty: 2,
    equipment: ["oven", "rice cooker"], // no blender
    breakfastStyle: "savory",
    budget: "tight",
    stores: ["Aldi"],
    shopsPerWeek: 2,
  });
  assert.equal(t.diet, "vegan");
  assert.deepEqual(t.allergens, ["gluten"]);
  assert.ok(t.avoidIngredients.includes("wheat")); // gluten preset
  assert.ok(t.avoidIngredients.includes("mushrooms")); // free-text
  assert.equal(t.snackAppetite, "meals");
  assert.equal(t.maxWeeknightMinutes, 30);
  assert.deepEqual(t.dislikeIngredients, ["olives"]);
  assert.deepEqual(t.cuisinePrefs, { loved: ["italian"], avoided: ["korean"] });
  assert.equal(t.maxDifficulty, 2);
  assert.deepEqual(t.equipment, ["oven", "rice cooker"]);
  assert.equal(t.breakfastStyle, "savory");
  assert.equal(t.budget, "tight");
  assert.deepEqual(t.stores, ["Aldi"]);
  assert.equal(t.shopsPerWeek, 2);
  // breakfast skipped and no blender -> no breakfast, no smoothie slot
  assert.deepEqual(t.mealSlots, ["lunch", "dinner"]);
});
test("targetsFromQuestionnaire: default-valued prefs stay omitted (lean file)", () => {
  const t = targetsFromQuestionnaire(BASE_Q, "2026-07-17", {
    diet: "omnivore",
    allergens: [],
    snackAppetite: "grazer",
    maxDifficulty: 3,
    budget: "normal",
    shopsPerWeek: 1,
    cuisinePrefs: { loved: [], avoided: [] },
  });
  for (const k of [
    "diet",
    "allergens",
    "snackAppetite",
    "maxDifficulty",
    "budget",
    "shopsPerWeek",
    "cuisinePrefs",
  ]) {
    assert.equal(k in t, false, `default ${k} should be omitted`);
  }
});
test("protein anchors to GOAL weight on a loss phase, not the weight being carried", () => {
  // David's dad: 6'4", 300 lb, heading for 200, age 56. Keying 0.9 g/lb to
  // 300 lb asks for 270 g of protein, which is neither achievable nor useful,
  // and at a deficit it swallows the whole calorie budget.
  const base = {
    sex: /** @type {"m"} */ ("m"),
    age: 56,
    heightFt: 6,
    heightIn: 4,
    weightLb: 300,
    activity: /** @type {1} */ (1),
    goal: /** @type {"loss"} */ ("loss"),
  };
  const without = targetsFromQuestionnaire(base);
  const withGoal = targetsFromQuestionnaire({ ...base, goalWeightLb: 200 });

  assert.equal(without.macros.protein, 270, "the old behaviour, for contrast");
  assert.equal(withGoal.macros.protein, 180, "0.9 g per lb of goal weight");
  assert.equal(withGoal.goalWeightLb, 200, "and the number that set it stays visible");

  // calories still come from the body doing the burning
  assert.equal(withGoal.macros.calories, without.macros.calories);

  // carbs must not be squeezed to nothing to make room for the protein
  assert.ok(withGoal.macros.carbs > without.macros.carbs);
});
test("goal weight is ignored when it would not help", () => {
  const base = {
    sex: /** @type {"m"} */ ("m"),
    age: 56,
    heightFt: 6,
    heightIn: 4,
    weightLb: 300,
    activity: /** @type {1} */ (1),
    goal: /** @type {"loss"} */ ("loss"),
  };
  // a goal ABOVE current weight on a loss phase is a typo, not an instruction
  assert.equal(targetsFromQuestionnaire({ ...base, goalWeightLb: 400 }).macros.protein, 270);
  assert.equal(targetsFromQuestionnaire({ ...base, goalWeightLb: 0 }).macros.protein, 270);
  // and a gain phase keeps anchoring to the body you actually have
  const gain = targetsFromQuestionnaire({
    ...base,
    goal: /** @type {"gain"} */ ("gain"),
    weightLb: 170,
    goalWeightLb: 150,
  });
  assert.equal(gain.macros.protein, 170);
});
