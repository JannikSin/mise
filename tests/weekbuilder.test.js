import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  foodSlugsOf,
  overlapReport,
  pickCommittee,
  foodGroupCoverage,
  foodGroupGapBonus,
  poolInsufficiency,
  foodGroupFloorPass,
  calorieTrimPass,
  ENFORCED_DAILY_GROUPS,
  generateWeek,
} from "../app/lib/weekbuilder.js";
import { recipesById } from "../app/lib/plan.js";

const EMPTY_FOOD_GROUPS = {
  beans: 0,
  berries: 0,
  otherFruit: 0,
  cruciferousVeg: 0,
  greens: 0,
  otherVeg: 0,
  flaxseed: 0,
  nuts: 0,
  spicesHerbs: 0,
  wholeGrains: 0,
  beverages: 0,
  method: "estimated",
};

/** compact recipe factory */
function r(
  id,
  mealType,
  foods,
  { protein = 40, calories = 700, servings = 1, foodGroups = {} } = {},
) {
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
    foodGroups: { ...EMPTY_FOOD_GROUPS, ...foodGroups },
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
const MONDAY_W29 = "2026-07-13";

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

test("pickCommittee maximizes overlap: the loner never beats the chicken cluster", () => {
  const committee = pickCommittee([CHICKEN_A, CHICKEN_B, CHICKEN_C, BEEF_LONER], {
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
  const committee = pickCommittee([project, CHICKEN_A, CHICKEN_B, CHICKEN_C], {
    size: 3,
    salt: 0,
  });
  assert.ok(!committee.some((c) => c.id === "weekend-braise"));
});

test("useSoon pantry foods boost a recipe into the committee", () => {
  const cabbage = r("cabbage-stirfry", "dinner", ["cabbage", "carrot", "egg"]);
  const committee = pickCommittee([CHICKEN_A, CHICKEN_B, BEEF_D, cabbage], {
    size: 3,
    salt: 0,
    useSoonFoods: ["half cabbage"],
  });
  assert.ok(committee.some((c) => c.id === "cabbage-stirfry"));
});

test("foodGroupCoverage sums contributions and foodGroupGapBonus rewards under-target categories", () => {
  const beany = r("bean-bowl", "lunch", ["black beans"], { foodGroups: { beans: 2 } });
  const noBeans = r("plain-bowl", "lunch", ["rice"], { foodGroups: { beans: 0 } });
  const coverage = foodGroupCoverage([{ recipe: beany, count: 2 }]);
  assert.equal(coverage.beans, 4);
  // a target that's already met contributes nothing further
  assert.equal(foodGroupGapBonus(beany, { beans: 21 }, { beans: 21 }), 0);
  // a recipe that doesn't touch the gapped category scores zero on it
  assert.equal(foodGroupGapBonus(noBeans, { beans: 0 }, { beans: 21 }), 0);
  // a recipe that does touch a wide-open gap scores above zero
  assert.ok(foodGroupGapBonus(beany, { beans: 0 }, { beans: 21 }) > 0);
});

test("poolInsufficient fires when no recipe in the pool contributes a targeted food group", () => {
  const pool = [CHICKEN_A, BREAKFAST, LUNCH]; // none carry flaxseed
  const gaps = poolInsufficiency(pool, { flaxseed: 1, beans: 3 });
  assert.ok(gaps.some((g) => g.reason.includes("flaxseed")));
  assert.ok(gaps.find((g) => g.reason.includes("flaxseed"))?.suggestion.includes("flaxseed"));
});

test("generateWeek clears unpinned entries and preserves pinned ones", () => {
  const existing = {
    week: "2026-W29",
    entries: [
      { id: "pinned-keep", date: MONDAY_W29, slot: "dinner", recipeId: "kofta", servings: 1, pinned: true },
      { id: "unpinned-gone", date: MONDAY_W29, slot: "lunch", recipeId: "lunchbox", servings: 1 },
    ],
  };
  const { plan } = generateWeek({
    recipes: ALL,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: existing,
    salt: 0,
  });
  assert.ok(plan.entries.some((e) => e.id === "pinned-keep"));
  assert.ok(!plan.entries.some((e) => e.id === "unpinned-gone"));
  // the pinned slot itself is never overwritten
  const mondayDinners = plan.entries.filter((e) => e.date === MONDAY_W29 && e.slot === "dinner");
  assert.equal(mondayDinners.length, 1);
  assert.equal(mondayDinners[0].id, "pinned-keep");
});

test("generateWeek fills every slot and caps dinner repeats at 2", () => {
  const existing = {
    week: "2026-W29",
    entries: [{ id: "keep", date: MONDAY_W29, slot: "dinner", recipeId: "kofta", servings: 1, pinned: true }],
  };
  const { plan, report } = generateWeek({
    recipes: ALL,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: existing,
    salt: 0,
  });
  assert.ok(plan.entries.some((e) => e.id === "keep"));
  for (const slot of ["breakfast", "smoothie", "lunch", "dinner"]) {
    const count = plan.entries.filter((e) => e.slot === slot).length;
    assert.equal(count, 7, `${slot} filled`);
  }
  const dinnerIds = plan.entries
    .filter((e) => e.slot === "dinner" && e.id !== "keep")
    .map((e) => e.recipeId);
  const freq = {};
  for (const id of dinnerIds) freq[id] = (freq[id] ?? 0) + 1;
  for (const [id, n] of Object.entries(freq)) assert.ok(n <= 2, `${id} appears ${n}`);
  for (const e of plan.entries) {
    assert.equal(typeof e.id, "string");
    assert.equal(typeof e.servings, "number");
  }
  assert.ok(report.distinctItems > 0);
});

test("repeat cap holds even with a tiny committee: leftover dinners stay empty", () => {
  const tiny = [CHICKEN_A, CHICKEN_B, CHICKEN_C, BREAKFAST, SMOOTHIE, LUNCH, SNACK]; // 3 dinners
  const { plan } = generateWeek({
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

test("generateWeek is deterministic for the same salt, differs for another", () => {
  const args = {
    recipes: ALL,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
  };
  const a1 = generateWeek({ ...args, salt: 0 }).plan.entries.map(
    (e) => `${e.date}|${e.slot}|${e.recipeId}`,
  );
  const a2 = generateWeek({ ...args, salt: 0 }).plan.entries.map(
    (e) => `${e.date}|${e.slot}|${e.recipeId}`,
  );
  assert.deepEqual(a1, a2);
});

test("re-roll (salt+1) preserves pins and produces a different unpinned assignment", () => {
  const base = {
    week: "2026-W29",
    entries: [
      { id: "pin1", date: MONDAY_W29, slot: "dinner", recipeId: "shawarma", servings: 1, pinned: true },
    ],
  };
  const args = {
    recipes: ALL,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
  };
  const r1 = generateWeek({ ...args, plan: base, salt: 1 });
  assert.ok(r1.plan.entries.some((e) => e.id === "pin1"));
  const r2 = generateWeek({ ...args, plan: r1.plan, salt: 2 });
  assert.ok(r2.plan.entries.some((e) => e.id === "pin1"));

  const unpinnedKey = (e) => `${e.date}|${e.slot}|${e.recipeId}`;
  const unpinned1 = r1.plan.entries.filter((e) => !e.pinned).map(unpinnedKey).sort();
  const unpinned2 = r2.plan.entries.filter((e) => !e.pinned).map(unpinnedKey).sort();
  assert.notDeepEqual(unpinned1, unpinned2);
});

// uniform-macro fixtures so which specific recipe the committee lands on
// never changes the day totals — isolates the floor/top-up math from the
// greedy selection
function uniformPool(mealType, count, protein, calories) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(r(`${mealType}-${i}`, mealType, [`${mealType}-food-${i}`], { protein, calories }));
  }
  return out;
}

test("generateWeek hits calorie and protein floor on every day when the pool allows it", () => {
  const generousPool = [
    ...uniformPool("dinner", 4, 60, 900),
    ...uniformPool("lunch", 3, 55, 700),
    ...uniformPool("breakfast", 2, 40, 600),
    ...uniformPool("smoothie", 1, 50, 500),
    ...uniformPool("snack", 2, 30, 300),
  ];
  const { report } = generateWeek({
    recipes: generousPool,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  assert.deepEqual(report.proteinShortDays, []);
  assert.deepEqual(report.calorieShortDays, []);
});

test("portion lever clears a mildly short day before any snack is stacked", () => {
  // base day: 900 + 700 + 600 + 500 = 2700 kcal, floor 3230 — a +1.0 dinner
  // bump (+900) covers it alone, so no snack should appear
  const pool = [
    ...uniformPool("dinner", 4, 60, 900),
    ...uniformPool("lunch", 3, 55, 700),
    ...uniformPool("breakfast", 2, 40, 600),
    ...uniformPool("smoothie", 1, 50, 500),
    ...uniformPool("snack", 2, 30, 300),
  ];
  const { plan } = generateWeek({
    recipes: pool,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  assert.equal(plan.entries.filter((e) => e.slot === "snack").length, 0, "no snacks needed");
  for (const e of plan.entries.filter((x) => x.slot === "dinner")) {
    assert.ok(e.servings <= 2, `dinner servings ${e.servings} within 2x cap`);
    assert.ok(e.servings > 1, "dinner portion was bumped to cover the calorie floor");
  }
});

test("generateWeek reports proteinShortDays and calorieShortDays when the pool cannot", () => {
  const starvedPool = [
    ...uniformPool("dinner", 1, 5, 200),
    ...uniformPool("lunch", 1, 10, 200),
    ...uniformPool("breakfast", 1, 10, 200),
    ...uniformPool("smoothie", 1, 10, 150),
    ...uniformPool("snack", 1, 5, 100),
  ];
  const { plan, report } = generateWeek({
    recipes: starvedPool,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  assert.equal(report.proteinShortDays.length, 7, "every day falls short on protein");
  assert.equal(report.calorieShortDays.length, 7, "every day falls short on calories");
  for (const d of report.proteinShortDays) {
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
    // the report carries the real goal, not the discounted 0.95 floor
    assert.equal(d.target, 210);
  }
  for (const d of report.calorieShortDays) assert.equal(d.target, 3400);
  // both levers fire fully before the day is reported short: portions maxed
  // (dinner 2.0, lunch 1.5) AND 2 servings-worth of snack — never gives up
  // silently. A repeated snack pick bumps servings on ONE row, no duplicates.
  // (the 1-recipe dinner pool only fills 2 days under the ≤2-repeat cap;
  // days with no dinner entry have nothing to bump)
  for (const date of new Set(plan.entries.map((e) => e.date))) {
    const dinner = plan.entries.find((e) => e.date === date && e.slot === "dinner");
    const lunch = plan.entries.find((e) => e.date === date && e.slot === "lunch");
    if (dinner) assert.equal(dinner.servings, 2, `${date} dinner maxed at 2x`);
    assert.equal(lunch?.servings, 1.5, `${date} lunch maxed at +0.5`);
    const snacks = plan.entries.filter((e) => e.date === date && e.slot === "snack");
    assert.equal(snacks.length, 1, `${date} same snack twice = one row, not duplicates`);
    assert.equal(snacks[0]?.servings, 2, `${date} stacks the max 2 servings-worth`);
  }
});

test("a pinned dinner's recipe is never re-picked: it appears only as the pin", () => {
  // shawarma shares chicken+yogurt with the cluster — before the fix, its
  // pinned foods seeding weekFoodPool made it the LIKELIEST re-pick
  const pinned = {
    week: "2026-W29",
    entries: [
      { id: "pin1", date: MONDAY_W29, slot: "dinner", recipeId: "shawarma", servings: 1, pinned: true },
    ],
  };
  const { plan } = generateWeek({
    recipes: ALL,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: pinned,
    salt: 0,
  });
  const shawarmas = plan.entries.filter((e) => e.recipeId === "shawarma");
  assert.equal(shawarmas.length, 1, "pinned recipe appears exactly once");
  assert.equal(shawarmas[0]?.id, "pin1");
});

test("generateWeek reports foodGroupGaps for categories under the weekly dailyDozen target", () => {
  const generousPool = [
    ...uniformPool("dinner", 4, 60, 900),
    ...uniformPool("lunch", 3, 55, 700),
    ...uniformPool("breakfast", 2, 40, 600),
    ...uniformPool("smoothie", 1, 50, 500),
    ...uniformPool("snack", 2, 30, 300),
  ]; // none carry any food group servings — every category is a gap
  const targetsWithDailyDozen = { ...TARGETS, dailyDozen: { flaxseed: 1 } };
  const { report } = generateWeek({
    recipes: generousPool,
    targets: targetsWithDailyDozen,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  assert.equal(report.foodGroupGaps.length, 7, "one flaxseed gap per day");
  for (const g of report.foodGroupGaps) {
    assert.equal(g.group, "flaxseed");
    assert.equal(g.have, 0);
    assert.equal(g.target, 1);
  }
  assert.deepEqual(report.foodGroupGapsWeekly, [{ group: "flaxseed", have: 0, target: 7 }]);
  assert.ok(report.poolInsufficient.some((p) => p.reason.includes("flaxseed")));
});

const MON = MONDAY_W29;

test("foodGroupFloorPass raises servings on an existing greens item before adding a new one", () => {
  const halfGreensDinner = r("greens-dinner", "dinner", ["kale"], { foodGroups: { greens: 1 } });
  const otherGreensSnack = r("greens-snack", "snack", ["parsley"], { foodGroups: { greens: 2 } });
  const plan = {
    week: "2026-W29",
    entries: [{ id: "e1", date: MON, slot: "dinner", recipeId: "greens-dinner", servings: 1 }],
  };
  const byId = recipesById([halfGreensDinner, otherGreensSnack]);
  const result = foodGroupFloorPass(plan, [otherGreensSnack], byId, { greens: 2 });
  assert.equal(result.entries.length, 1, "no new entry added, portion bump alone closes it");
  assert.equal(result.entries[0].servings, 2, "1 greens/serving x 2 servings = floor of 2");
});

test("foodGroupFloorPass adds a greens item only when portion bumps cannot close the gap", () => {
  const lowGreensDinner = r("low-greens-dinner", "dinner", ["lettuce"], {
    foodGroups: { greens: 0.5 },
  });
  const greensSnack = r("greens-snack", "snack", ["parsley"], { foodGroups: { greens: 2 } });
  const plan = {
    week: "2026-W29",
    entries: [{ id: "e1", date: MON, slot: "dinner", recipeId: "low-greens-dinner", servings: 1 }],
  };
  const byId = recipesById([lowGreensDinner, greensSnack]);
  const result = foodGroupFloorPass(plan, [greensSnack], byId, { greens: 2 });
  const dinner = result.entries.find((e) => e.id === "e1");
  assert.equal(dinner.servings, 2, "portion lever maxes out at the 2x cap: 0.5 x 2 = 1.0, still short");
  const added = result.entries.filter((e) => e.id !== "e1");
  assert.equal(added.length, 1, "exactly one new entry added");
  assert.equal(added[0].recipeId, "greens-snack");
  assert.equal(added[0].slot, "snack");
  assert.ok(!added[0].pinned);
});

test("foodGroupFloorPass never touches pinned entries", () => {
  const pinnedGreensDinner = r("pinned-greens-dinner", "dinner", ["kale"], {
    foodGroups: { greens: 1 },
  });
  const greensSnack = r("greens-snack", "snack", ["parsley"], { foodGroups: { greens: 2 } });
  const plan = {
    week: "2026-W29",
    entries: [
      {
        id: "pin1",
        date: MON,
        slot: "dinner",
        recipeId: "pinned-greens-dinner",
        servings: 1,
        pinned: true,
      },
    ],
  };
  const byId = recipesById([pinnedGreensDinner, greensSnack]);
  const result = foodGroupFloorPass(plan, [greensSnack], byId, { greens: 2 });
  const pin = result.entries.find((e) => e.id === "pin1");
  assert.equal(pin.servings, 1, "pinned entry's servings never change");
  const added = result.entries.filter((e) => e.id !== "pin1");
  assert.equal(added.length, 1, "the gap is closed by adding instead of resizing the pin");
  assert.equal(added[0].recipeId, "greens-snack");
});

test("foodGroupFloorPass leaves the day alone and reports honestly when the pool has no greens at all", () => {
  const noGreensDinner = r("no-greens-dinner", "dinner", ["rice"], { foodGroups: { greens: 0 } });
  const noGreensSnack = r("no-greens-snack", "snack", ["crackers"], { foodGroups: { greens: 0 } });
  const plan = {
    week: "2026-W29",
    entries: [{ id: "e1", date: MON, slot: "dinner", recipeId: "no-greens-dinner", servings: 1 }],
  };
  const byId = recipesById([noGreensDinner, noGreensSnack]);
  const result = foodGroupFloorPass(plan, [noGreensSnack], byId, { greens: 2 });
  assert.deepEqual(result.entries, plan.entries, "nothing changes when the pool can't help");
});

test("calorieTrimPass brings a day under the ceiling by shaving a snack first", () => {
  const dinnerRecipe = r("trim-dinner", "dinner", ["beef"], { protein: 60, calories: 900 });
  const snackRecipe = r("trim-snack", "snack", ["chips"], { protein: 10, calories: 300 });
  const plan = {
    week: "2026-W29",
    entries: [
      { id: "d1", date: MON, slot: "dinner", recipeId: "trim-dinner", servings: 1 },
      { id: "s1", date: MON, slot: "snack", recipeId: "trim-snack", servings: 2 },
    ],
  };
  const byId = recipesById([dinnerRecipe, snackRecipe]);
  const result = calorieTrimPass(plan, byId, {
    calorieCeiling: 1200,
    calorieFloor: 800,
    proteinFloor: 20,
    groupFloors: {},
  });
  const dinner = result.entries.find((e) => e.id === "d1");
  const snack = result.entries.find((e) => e.id === "s1");
  assert.equal(dinner.servings, 1, "dinner untouched: the snack absorbs the trim first");
  assert.equal(snack.servings, 1, "snack trimmed 2 -> 1.5 -> 1 to land exactly on the ceiling");
});

test("calorieTrimPass refuses a trim that would break the protein floor", () => {
  const dinnerRecipe = r("protein-dinner", "dinner", ["beef"], { protein: 42, calories: 1000 });
  const plan = {
    week: "2026-W29",
    entries: [{ id: "d1", date: MON, slot: "dinner", recipeId: "protein-dinner", servings: 1 }],
  };
  const byId = recipesById([dinnerRecipe]);
  const result = calorieTrimPass(plan, byId, {
    calorieCeiling: 900,
    calorieFloor: 400,
    proteinFloor: 40,
    groupFloors: {},
  });
  assert.deepEqual(
    result.entries,
    plan.entries,
    "the only candidate step (1 -> 0.5) would drop protein from 42 to 21, under the floor of 40",
  );
});

test("calorieTrimPass refuses a trim that would break the greens floor", () => {
  const dinnerRecipe = r("greens-dinner-trim", "dinner", ["kale"], {
    protein: 100,
    calories: 1000,
    foodGroups: { greens: 2 },
  });
  const plan = {
    week: "2026-W29",
    entries: [{ id: "d1", date: MON, slot: "dinner", recipeId: "greens-dinner-trim", servings: 1 }],
  };
  const byId = recipesById([dinnerRecipe]);
  const result = calorieTrimPass(plan, byId, {
    calorieCeiling: 900,
    calorieFloor: 400,
    proteinFloor: 10,
    groupFloors: { greens: 2 },
  });
  assert.deepEqual(
    result.entries,
    plan.entries,
    "the only candidate step (1 -> 0.5) would drop greens from 2 to 1, under the floor of 2",
  );
});

test("calorieTrimPass never touches pinned entries", () => {
  const pinnedDinner = r("pinned-trim-dinner", "dinner", ["beef"], { protein: 60, calories: 1000 });
  const snackRecipe = r("trim-snack-2", "snack", ["chips"], { protein: 10, calories: 200 });
  const plan = {
    week: "2026-W29",
    entries: [
      { id: "p1", date: MON, slot: "dinner", recipeId: "pinned-trim-dinner", servings: 1, pinned: true },
      { id: "s1", date: MON, slot: "snack", recipeId: "trim-snack-2", servings: 2 },
    ],
  };
  const byId = recipesById([pinnedDinner, snackRecipe]);
  const result = calorieTrimPass(plan, byId, {
    calorieCeiling: 1300,
    calorieFloor: 900,
    proteinFloor: 20,
    groupFloors: {},
  });
  const pin = result.entries.find((e) => e.id === "p1");
  const snack = result.entries.find((e) => e.id === "s1");
  assert.equal(pin.servings, 1, "pinned dinner is never resized, even though it's the biggest contributor");
  assert.equal(snack.servings, 1.5, "unpinned snack absorbs the trim instead");
});

test("calorieTrimPass reports calorieOverDays when no legal trim exists", () => {
  // 4 identical, protein-dense dinner recipes and nothing else in the pool:
  // every day is dinner-only, comfortably clears both floors, but the single
  // 0.5 step available would cut calories in half, straight through the
  // calorie floor, so every day is left over the ceiling, honestly.
  const denseDinners = uniformPool("dinner", 4, 180, 1200);
  const targets = { macros: { calories: 1000, protein: 189 } };
  const { report } = generateWeek({
    recipes: denseDinners,
    targets,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  assert.equal(report.calorieOverDays.length, 7, "all 7 dinner-only days sit over the ceiling");
  for (const d of report.calorieOverDays) {
    assert.equal(d.calories, 1200);
    assert.equal(d.ceiling, 1050, "1000 x CEILING_RATIO(1.05)");
  }
  assert.deepEqual(report.proteinShortDays, [], "protein floor (179.55) is comfortably cleared at 180");
  assert.deepEqual(report.calorieShortDays, [], "calorie floor (950) is comfortably cleared at 1200");
});

test("generateWeek fills only the mealSlots listed in targets", () => {
  const targets = { ...TARGETS, mealSlots: ["breakfast", "lunch", "dinner"] };
  const { plan } = generateWeek({
    recipes: ALL,
    targets,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  assert.equal(plan.entries.filter((e) => e.slot === "smoothie").length, 0, "no smoothie entries");
  for (const slot of ["breakfast", "lunch", "dinner"]) {
    const count = plan.entries.filter((e) => e.slot === slot).length;
    assert.equal(count, 7, `${slot} filled`);
  }
});

test("generateWeek defaults to breakfast/lunch/dinner/smoothie when targets.mealSlots is absent", () => {
  const { plan } = generateWeek({
    recipes: ALL,
    targets: TARGETS, // no mealSlots key
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  for (const slot of ["breakfast", "lunch", "dinner", "smoothie"]) {
    const count = plan.entries.filter((e) => e.slot === slot).length;
    assert.equal(count, 7, `${slot} filled`);
  }
});

test("REAL pool integration: generated week meets calorie and protein floors every day", () => {
  // David's directive is "meet the calorie goal and protein goal every day":
  // against the actual seed recipes and actual targets.json, the portion
  // lever plus snack top-up must clear both floors on all 7 days
  const recipesDir = fileURLToPath(new URL("../seed-data/generated/recipes/", import.meta.url));
  const recipes = readdirSync(recipesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(recipesDir + f, "utf8")));
  const targets = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../seed-data/generated/fitness/targets.json", import.meta.url)),
      "utf8",
    ),
  );
  const { plan, report } = generateWeek({
    recipes,
    targets,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  assert.deepEqual(report.proteinShortDays, [], "no protein-short days on the real pool");
  assert.deepEqual(report.calorieShortDays, [], "no calorie-short days on the real pool");
  for (const e of plan.entries) assert.ok(e.servings <= 2, `${e.recipeId} servings ${e.servings}`);
});

test("generateWeek: every day clears greens 2 and cruciferous 1 against the real seed pool", () => {
  // Opus nutrition audit verdict: "the weekly generator should force at
  // least one greens-2 item per day" — this asserts the floor pass actually
  // delivers that against the real recipe pool, not just a synthetic one.
  const recipesDir = fileURLToPath(new URL("../seed-data/generated/recipes/", import.meta.url));
  const recipes = readdirSync(recipesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(recipesDir + f, "utf8")));
  const targets = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../seed-data/generated/fitness/targets.json", import.meta.url)),
      "utf8",
    ),
  );
  const { plan } = generateWeek({
    recipes,
    targets,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  const byId = recipesById(recipes);
  const dates = [...new Set(plan.entries.map((e) => e.date))];
  for (const date of dates) {
    const chosen = plan.entries
      .filter((e) => e.date === date && e.recipeId)
      .map((e) => ({ recipe: byId.get(e.recipeId), count: e.servings }))
      .filter((c) => c.recipe);
    const coverage = foodGroupCoverage(chosen);
    for (const group of ENFORCED_DAILY_GROUPS) {
      const floor = targets.dailyDozen[group];
      assert.ok(
        (coverage[group] ?? 0) >= floor,
        `${date} ${group} = ${coverage[group] ?? 0}, floor ${floor}`,
      );
    }
  }
});

test("generateWeek: every day lands within the calorie floor and ceiling against the real seed pool", () => {
  // 2026-07-09 smoke-run defect: days were landing 3990/3990/4030 against a
  // 3700 kcal gain-phase target, 8-9% over. The trim pass must bring every
  // day back into [floor, ceiling] without breaking protein or the enforced
  // Daily Dozen floors it just secured.
  const recipesDir = fileURLToPath(new URL("../seed-data/generated/recipes/", import.meta.url));
  const recipes = readdirSync(recipesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(recipesDir + f, "utf8")));
  const targets = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../seed-data/generated/fitness/targets.json", import.meta.url)),
      "utf8",
    ),
  );
  const { plan, report } = generateWeek({
    recipes,
    targets,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W29",
    plan: { week: "2026-W29", entries: [] },
    salt: 0,
  });
  assert.deepEqual(report.calorieShortDays, [], "no calorie-short days on the real pool");
  assert.deepEqual(report.calorieOverDays, [], "no calorie-over days on the real pool");
  assert.deepEqual(report.proteinShortDays, [], "protein floor still met after the trim pass");

  const byId = recipesById(recipes);
  const dates = [...new Set(plan.entries.map((e) => e.date))];
  for (const date of dates) {
    const chosen = plan.entries
      .filter((e) => e.date === date && e.recipeId)
      .map((e) => ({ recipe: byId.get(e.recipeId), count: e.servings }))
      .filter((c) => c.recipe);
    const coverage = foodGroupCoverage(chosen);
    for (const group of ENFORCED_DAILY_GROUPS) {
      const floor = targets.dailyDozen[group];
      assert.ok(
        (coverage[group] ?? 0) >= floor,
        `${date} ${group} = ${coverage[group] ?? 0}, floor ${floor} still met after the trim pass`,
      );
    }
  }
});
