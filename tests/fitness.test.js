import test from "node:test";
import assert from "node:assert/strict";
import {
  lastSetsFor,
  personalRecords,
  seriesFor,
  upsertDay,
  setTopSet,
  formatSets,
  templateForDate,
  targetsFromQuestionnaire,
  avoidTermsFromAllergens,
} from "../app/lib/fitness.js";

const SESSIONS = [
  {
    date: "2026-06-29",
    templateId: "chest-triceps",
    exercises: [{ name: "Bench Press", sets: [{ weight: 150, reps: 5 }] }],
  },
  {
    date: "2026-07-03",
    templateId: "chest-triceps",
    exercises: [
      {
        name: "Bench Press",
        sets: [
          { weight: 155, reps: 5 },
          { weight: 155, reps: 4 },
        ],
      },
      { name: "Dips", sets: [{ weight: 0, reps: 12 }] },
    ],
  },
];

test("lastSetsFor returns the most recent session's sets for a lift", () => {
  assert.deepEqual(lastSetsFor(SESSIONS, "Bench Press"), [
    { weight: 155, reps: 5 },
    { weight: 155, reps: 4 },
  ]);
  assert.equal(lastSetsFor(SESSIONS, "Squat"), null);
});

test("formatSets renders console-style last-time numbers", () => {
  assert.equal(
    formatSets([
      { weight: 155, reps: 5 },
      { weight: 155, reps: 4 },
    ]),
    "155×5 · 155×4",
  );
  assert.equal(formatSets([{ weight: 0, reps: 12 }]), "bw×12");
});

test("personalRecords finds the heaviest set per lift", () => {
  const prs = personalRecords(SESSIONS);
  assert.deepEqual(prs.get("Bench Press"), { weight: 155, reps: 5, date: "2026-07-03" });
  assert.deepEqual(prs.get("Dips"), { weight: 0, reps: 12, date: "2026-07-03" });
});

test("seriesFor returns date-sorted top weight per session for charting", () => {
  assert.deepEqual(seriesFor(SESSIONS, "Bench Press"), [
    { date: "2026-06-29", top: 150 },
    { date: "2026-07-03", top: 155 },
  ]);
  assert.deepEqual(seriesFor(SESSIONS, "Squat"), []);
});

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

test("setTopSet replaces rather than appends", () => {
  let s = { date: "2026-07-06", templateId: "legs", exercises: [] };
  s = setTopSet(s, "Squat", { weight: 185, reps: 5 });
  s = setTopSet(s, "Squat", { weight: 195, reps: 3 });
  s = setTopSet(s, "Leg Press", { weight: 300, reps: 10 });
  assert.equal(s.exercises.length, 2);
  assert.equal(s.exercises[0].sets.length, 1);
  assert.deepEqual(s.exercises[0], { name: "Squat", sets: [{ weight: 195, reps: 3 }] });
  assert.deepEqual(s.exercises[1], { name: "Leg Press", sets: [{ weight: 300, reps: 10 }] });
});

const SCHEDULE = {
  mon: "lower-a",
  tue: "pull-a",
  wed: "push-a",
  thu: "pull-b",
  fri: "lower-b",
  sat: "push-b",
  sun: null,
};
const TEMPLATES = [
  { id: "lower-a", name: "Mon: Lower A" },
  { id: "pull-a", name: "Tue: Pull A" },
  { id: "push-a", name: "Wed: Push A" },
  { id: "pull-b", name: "Thu: Pull B" },
  { id: "lower-b", name: "Fri: Lower B" },
  { id: "push-b", name: "Sat: Push B" },
];

test("templateForDate returns the scheduled template for each weekday", () => {
  assert.equal(templateForDate(SCHEDULE, TEMPLATES, "2026-07-06").id, "lower-a"); // mon
  assert.equal(templateForDate(SCHEDULE, TEMPLATES, "2026-07-07").id, "pull-a"); // tue
  assert.equal(templateForDate(SCHEDULE, TEMPLATES, "2026-07-08").id, "push-a"); // wed
  assert.equal(templateForDate(SCHEDULE, TEMPLATES, "2026-07-09").id, "pull-b"); // thu
  assert.equal(templateForDate(SCHEDULE, TEMPLATES, "2026-07-10").id, "lower-b"); // fri
  assert.equal(templateForDate(SCHEDULE, TEMPLATES, "2026-07-11").id, "push-b"); // sat
});

test("templateForDate returns null on the rest day", () => {
  assert.equal(templateForDate(SCHEDULE, TEMPLATES, "2026-07-12"), null); // sun
});

test("templateForDate returns null when schedule is undefined", () => {
  assert.equal(templateForDate(undefined, TEMPLATES, "2026-07-06"), null);
});

test("templateForDate returns null when the schedule names an id absent from templates", () => {
  const badSchedule = { ...SCHEDULE, mon: "not-a-real-id" };
  assert.equal(templateForDate(badSchedule, TEMPLATES, "2026-07-06"), null);
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

const BASE_Q = { sex: "f", age: 30, heightFt: 5, heightIn: 6, weightLb: 140, activity: 3, goal: "maintain" };

test("targetsFromQuestionnaire: empty prefs reproduce the pre-survey shape (no new keys)", () => {
  const t = targetsFromQuestionnaire(BASE_Q, "2026-07-17", {});
  for (const k of ["diet", "allergens", "avoidIngredients", "snackAppetite", "maxWeeknightMinutes", "dislikeIngredients", "cuisinePrefs", "maxDifficulty", "equipment", "breakfastStyle", "budget", "stores", "shopsPerWeek"]) {
    assert.equal(k in t, false, `unexpected key ${k} at default`);
  }
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
  for (const k of ["diet", "allergens", "snackAppetite", "maxDifficulty", "budget", "shopsPerWeek", "cuisinePrefs"]) {
    assert.equal(k in t, false, `default ${k} should be omitted`);
  }
});
