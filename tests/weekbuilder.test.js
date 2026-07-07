import test from "node:test";
import assert from "node:assert/strict";
import {
  foodSlugsOf,
  overlapReport,
  pickDinnerCommittee,
  buildWeek,
} from "../app/lib/weekbuilder.js";

/** compact recipe factory */
function r(id, mealType, foods, { protein = 40, calories = 700, servings = 1 } = {}) {
  return {
    id,
    name: id,
    mealType,
    totalTime: 20,
    servings,
    purpose: ["everyday"],
    nutrition: { calories, protein, carbs: 0, fat: 0, method: "estimated" },
    ingredients: foods.map((f) =>
      typeof f === "string"
        ? { qty: 1, unit: "x", food: f, staple: false }
        : { qty: 1, unit: "x", food: f.food, staple: f.staple },
    ),
  };
}

const CHICKEN_A = r("shawarma", "dinner", [
  "chicken thigh",
  "yogurt",
  "tomato",
  { food: "rice", staple: true },
]);
const CHICKEN_B = r("gyros", "dinner", ["chicken thigh", "yogurt", "cucumber"]);
const CHICKEN_C = r("harissa", "dinner", ["chicken thigh", "couscous", "peppers"]);
const BEEF_LONER = r("weird-beef", "dinner", ["ostrich", "dragonfruit", "juniper"]);
const BEEF_D = r("kofta", "dinner", ["ground beef", "tomato", "yogurt"]);
const BREAKFAST = r("eggs", "breakfast", ["eggs", "bread"], { protein: 50, calories: 800 });
const SMOOTHIE = r("shake", "smoothie", ["whey", "banana"], { protein: 55, calories: 700 });
const LUNCH = r("lunchbox", "lunch", ["chicken thigh", "broccoli"], { protein: 60, calories: 800 });
const SNACK = r("cheese", "snack", ["cottage cheese"], { protein: 25, calories: 205 });

const ALL = [
  CHICKEN_A,
  CHICKEN_B,
  CHICKEN_C,
  BEEF_LONER,
  BEEF_D,
  BREAKFAST,
  SMOOTHIE,
  LUNCH,
  SNACK,
];
const TARGETS = { macros: { calories: 3400, protein: 210 } };

test("foodSlugsOf excludes staples", () => {
  assert.deepEqual([...foodSlugsOf(CHICKEN_A)].sort(), ["chicken-thigh", "tomato", "yogurt"]);
});

test("overlapReport finds shared foods and distinct item count", () => {
  const rep = overlapReport([CHICKEN_A, CHICKEN_B]);
  const shared = rep.shared.map((s) => s.food);
  assert.ok(shared.includes("chicken thigh"));
  assert.ok(shared.includes("yogurt"));
  assert.equal(rep.distinctItems, 4); // chicken thigh, yogurt, tomato, cucumber
});

test("committee maximizes overlap: the loner never beats the chicken cluster", () => {
  const committee = pickDinnerCommittee([CHICKEN_A, CHICKEN_B, CHICKEN_C, BEEF_LONER], {
    size: 3,
    salt: 0,
  });
  assert.deepEqual(committee.map((c) => c.id).sort(), ["gyros", "harissa", "shawarma"]);
});

test("project-effort recipes never auto-fill weeknights", () => {
  const project = {
    ...r("weekend-braise", "dinner", ["chicken thigh", "yogurt", "tomato"]),
    effort: "project",
  };
  const committee = pickDinnerCommittee([project, CHICKEN_A, CHICKEN_B, CHICKEN_C], {
    size: 3,
    salt: 0,
  });
  assert.ok(!committee.some((c) => c.id === "weekend-braise"));
});

test("useSoon pantry foods boost a recipe into the committee", () => {
  const cabbage = r("cabbage-stirfry", "dinner", ["cabbage", "carrot", "egg"]);
  const committee = pickDinnerCommittee([CHICKEN_A, CHICKEN_B, BEEF_D, cabbage], {
    size: 3,
    salt: 0,
    useSoonFoods: ["half cabbage"],
  });
  assert.ok(committee.some((c) => c.id === "cabbage-stirfry"));
});

test("buildWeek fills every empty slot, respects existing, caps dinner repeats at 2", () => {
  const existing = {
    week: "2026-W29",
    entries: [{ id: "keep", date: "2026-07-13", slot: "dinner", recipeId: "kofta", servings: 1 }],
  };
  const { plan, report } = buildWeek({
    recipes: ALL,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: existing,
    salt: 0,
  });
  // existing entry untouched
  assert.ok(plan.entries.some((e) => e.id === "keep"));
  // 7 breakfasts, 7 smoothies, 7 lunches, 7 dinners filled
  for (const slot of ["breakfast", "smoothie", "lunch", "dinner"]) {
    const count = plan.entries.filter((e) => e.slot === slot).length;
    assert.equal(count, 7, `${slot} filled`);
  }
  // dinner repeat cap: no recipe more than 2 of the 6 GENERATED dinners
  const dinnerIds = plan.entries
    .filter((e) => e.slot === "dinner" && e.id !== "keep")
    .map((e) => e.recipeId);
  const freq = {};
  for (const id of dinnerIds) freq[id] = (freq[id] ?? 0) + 1;
  for (const [id, n] of Object.entries(freq)) assert.ok(n <= 2, `${id} appears ${n}`);
  // every generated entry has an id and servings
  for (const e of plan.entries) {
    assert.equal(typeof e.id, "string");
    assert.equal(typeof e.servings, "number");
  }
  assert.ok(report.distinctItems > 0);
});

test("repeat cap holds even with a tiny committee: leftover dinners stay empty", () => {
  const tiny = [CHICKEN_A, CHICKEN_B, CHICKEN_C, BREAKFAST, SMOOTHIE, LUNCH, SNACK]; // 3 dinners
  const { plan } = buildWeek({
    recipes: tiny,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  const dinners = plan.entries.filter((e) => e.slot === "dinner").map((e) => e.recipeId);
  assert.equal(dinners.length, 6, "3 recipes x cap 2 = 6 filled, 1 left for manual pick");
  const freq = {};
  for (const id of dinners) freq[id] = (freq[id] ?? 0) + 1;
  for (const [id, n] of Object.entries(freq)) assert.ok(n <= 2, `${id} appears ${n}`);
});

test("buildWeek is deterministic for the same salt, differs for another", () => {
  const args = {
    recipes: ALL,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
  };
  const a1 = buildWeek({ ...args, salt: 0 }).plan.entries.map(
    (e) => `${e.date}|${e.slot}|${e.recipeId}`,
  );
  const a2 = buildWeek({ ...args, salt: 0 }).plan.entries.map(
    (e) => `${e.date}|${e.slot}|${e.recipeId}`,
  );
  assert.deepEqual(a1, a2);
});

test("report red-flags days that miss the protein floor even after the snack", () => {
  // 5P dinners: 50+55+60+5 = 170, +25 snack = 195 < 199.5 (95% of 210)
  const weak = [
    r("tiny-dinner", "dinner", ["chicken thigh"], { protein: 5, calories: 400 }),
    BREAKFAST,
    SMOOTHIE,
    LUNCH,
    SNACK,
  ];
  const { report } = buildWeek({
    recipes: weak,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  assert.equal(report.proteinShortDays.length, 7, "every generated day falls short");
  for (const d of report.proteinShortDays) {
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(d.protein < 210 * 0.95, `${d.date} protein ${d.protein}`);
  }
});

test("report has no protein flags when the week hits the floor", () => {
  const { report } = buildWeek({
    recipes: ALL,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  assert.deepEqual(report.proteinShortDays, []);
});

test("buildWeek adds a protein snack on short days", () => {
  // tiny recipe pool with low protein → every day falls short → snack added
  const lowProtein = [
    r("small-dinner", "dinner", ["chicken thigh"], { protein: 30, calories: 500 }),
    BREAKFAST,
    SMOOTHIE,
    LUNCH,
    SNACK,
  ];
  const { plan } = buildWeek({
    recipes: lowProtein,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  const snacks = plan.entries.filter((e) => e.slot === "snack");
  assert.ok(snacks.length >= 5, `expected snacks on short days, got ${snacks.length}`);
});
