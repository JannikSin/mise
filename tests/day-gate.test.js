// A DAY AT HOME ON BREAK (P1, P5, P10). Found 2026-11-25 by pressing SET MY
// WEEK on the live app as of Fri 11/27, Thanksgiving break at his parents'
// house: the day carried a dining-hall swipe that did not exist, and a day the
// generator had landed at 191 g protein reached the phone at 285 g against a
// 215 g ceiling, because the house ingredient swap trades recipes after the
// day is sized and keeps the servings. These tests exercise the three fixes.
import test from "node:test";
import assert from "node:assert/strict";
import { planSwipes, weekRunSwipes, keepDaysInBand, dayTotals } from "../app/lib/plan.js";
import { diningClosed } from "../app/lib/tables.js";
import { macroTopUp } from "../app/lib/weekbuilder.js";

const W48 = [
  "2026-11-22",
  "2026-11-23",
  "2026-11-24",
  "2026-11-25",
  "2026-11-26",
  "2026-11-27",
  "2026-11-28",
];
const SWIPES = {
  perWeek: 7,
  currencyId: "swipes",
  slot: "lunch",
  estimate: { estCalories: 900, estProtein: 70 },
};

test("the dining hall is shut on a school break, and open the day after", () => {
  assert.equal(diningClosed({}, "2026-11-27"), true, "Thanksgiving break, Purdue by default");
  assert.equal(diningClosed(null, "2026-11-24"), false, "the Tuesday before the break");
  assert.equal(diningClosed({}, "2026-11-30"), false, "the Monday classes resume");
  assert.equal(diningClosed({ breaks: "purdue" }, "2026-12-25"), true, "winter break");
  assert.equal(
    diningClosed({ breaks: "constructor" }, "2026-11-27"),
    false,
    "an unknown key names no calendar",
  );
});

test("no swipe is budgeted onto a break day: Thanksgiving week keeps its three school days", () => {
  const out = planSwipes({ week: "2026-W48", entries: [] }, W48, {
    ...SWIPES,
    skipDate: (d) => diningClosed({}, d),
  });
  const dates = out.entries.filter((e) => e.currency === "swipes").map((e) => e.date);
  assert.deepEqual(dates.sort(), ["2026-11-22", "2026-11-23", "2026-11-24"]);
});

test("Fri 11/27 planned from Friday morning gets no swipe at all", () => {
  const out = planSwipes({ week: "2026-W48", entries: [] }, W48, {
    ...SWIPES,
    today: "2026-11-27",
    skipDate: (d) => diningClosed({}, d),
  });
  assert.equal(out.entries.length, 0);
});

test("without skipDate the budgeting is unchanged: seven swipes, as before", () => {
  const out = planSwipes({ week: "2026-W48", entries: [] }, W48, SWIPES);
  assert.equal(out.entries.filter((e) => e.currency === "swipes").length, 7);
});

test("a week run eats no swipe on a break day either", () => {
  const meals = W48.map((date) => ({ date, slot: "lunch" }));
  const got = weekRunSwipes(
    meals,
    { id: "swipes", perWeek: 7, preferredSlot: "lunch" },
    { week: "2026-W48", entries: [] },
    "2026-11-22",
    (d) => diningClosed({}, d),
  );
  assert.deepEqual(
    got.map((m) => m.date),
    ["2026-11-22", "2026-11-23", "2026-11-24"],
  );
});

// ── the gate ───────────────────────────────────────────────────────────────
const R = (id, calories, protein) => ({
  id,
  name: id,
  servings: 1,
  nutrition: { calories, protein },
});
const BY_ID = new Map(
  [
    R("lean-oats", 600, 20),
    R("lean-bowl", 650, 25),
    R("lean-rice", 640, 24),
    R("dense-soup", 593, 51),
    R("dense-salad", 560, 55),
  ].map((r) => [r.id, r]),
);
const BOUNDS = { calorieFloor: 3500, proteinFloor: 190, proteinCeiling: 215 };
const E = (id, date, slot, recipeId, servings) => ({ id, date, slot, recipeId, servings });
const D = "2026-11-27";
// 3,740 kcal, 200 g as generated... built from lean recipes plus one dense
const GENERATED = {
  week: "2026-W48",
  entries: [
    E("a", D, "breakfast", "lean-oats", 2),
    E("b", D, "lunch", "lean-bowl", 2),
    E("c", D, "dinner", "dense-soup", 2.25),
  ],
};

test("a swap that keeps the servings and pushes the day past 215 g is dropped for that day", () => {
  const before = dayTotals(GENERATED.entries, BY_ID, D);
  assert.ok(
    before.protein <= 215 && before.protein >= 190,
    `the generated day is in band (${before.protein})`,
  );
  // the house swap: lunch traded for a dense recipe, servings kept
  const after = {
    ...GENERATED,
    entries: GENERATED.entries.map((e) => (e.id === "b" ? { ...e, recipeId: "dense-salad" } : e)),
  };
  assert.ok(dayTotals(after.entries, BY_ID, D).protein > 215, "the swap alone breaks the ceiling");
  const gate = keepDaysInBand(GENERATED, after, BY_ID, BOUNDS, [D]);
  assert.deepEqual(gate.kept, [D]);
  assert.equal(dayTotals(gate.plan.entries, BY_ID, D).protein, before.protein);
  assert.equal(gate.plan.entries.find((e) => e.id === "b").recipeId, "lean-bowl");
});

test("a swap that leaves the day inside his numbers is kept", () => {
  const after = {
    ...GENERATED,
    entries: GENERATED.entries.map((e) => (e.id === "a" ? { ...e, recipeId: "lean-rice" } : e)),
  };
  const gate = keepDaysInBand(GENERATED, after, BY_ID, BOUNDS, [D]);
  assert.deepEqual(gate.kept, []);
  assert.equal(gate.plan, after, "untouched, same object");
});

test("a day the generator already left over the ceiling is not blamed on the swap unless the swap made it worse", () => {
  const dense = {
    week: "2026-W48",
    entries: [
      E("a", D, "breakfast", "dense-salad", 2),
      E("b", D, "lunch", "dense-salad", 2),
      E("c", D, "dinner", "dense-soup", 2.5),
    ],
  };
  const same = { ...dense, entries: dense.entries.map((e) => ({ ...e })) };
  assert.deepEqual(keepDaysInBand(dense, same, BY_ID, BOUNDS, [D]).kept, []);
  const worse = {
    ...dense,
    entries: dense.entries.map((e) => (e.id === "c" ? { ...e, servings: 3 } : e)),
  };
  assert.deepEqual(keepDaysInBand(dense, worse, BY_ID, BOUNDS, [D]).kept, [D]);
});

test("a swap that drops the day under the calorie floor is dropped too", () => {
  const after = {
    ...GENERATED,
    entries: GENERATED.entries.map((e) => (e.id === "a" ? { ...e, servings: 1 } : e)),
  };
  assert.ok(dayTotals(after.entries, BY_ID, D).calories < 3500);
  assert.deepEqual(keepDaysInBand(GENERATED, after, BY_ID, BOUNDS, [D]).kept, [D]);
});

test("only the dates handed in are judged: a past day is never rewritten", () => {
  const after = {
    ...GENERATED,
    entries: GENERATED.entries.map((e) => (e.id === "b" ? { ...e, recipeId: "dense-salad" } : e)),
  };
  assert.deepEqual(keepDaysInBand(GENERATED, after, BY_ID, BOUNDS, []).kept, []);
});

// ── the top-up holds the ceiling while something lean can close the floor ──
test("restoring the calorie floor reaches for the lean snack before bumping dense meals past 215 g", () => {
  const byId = new Map(
    [
      R("dense-a", 560, 55),
      R("dense-b", 593, 51),
      R("dense-c", 500, 45),
      R("lean-snack", 440, 8),
    ].map((r) => [r.id, r]),
  );
  // 191 g and 2,144 kcal... far under the 3,500 floor, protein already banked
  const plan = {
    week: "2026-W48",
    entries: [
      E("a", D, "breakfast", "dense-c", 1.5),
      E("b", D, "lunch", "dense-a", 1),
      E("c", D, "dinner", "dense-b", 1.35),
    ],
  };
  const floors = { calories: 2900, protein: 190 };
  const free = macroTopUp(plan, [byId.get("lean-snack")], byId, floors, 3, { proteinTargetG: 190 });
  const held = macroTopUp(plan, [byId.get("lean-snack")], byId, floors, 3, {
    proteinTargetG: 190,
    proteinCeilingG: 215,
  });
  const pFree = dayTotals(free.entries, byId, D).protein;
  const tHeld = dayTotals(held.entries, byId, D);
  assert.ok(pFree > 215, `the old order bumps dense meals first and overshoots (${pFree})`);
  assert.ok(
    tHeld.protein <= 215.5,
    `with the ceiling held the day stays inside it (${tHeld.protein})`,
  );
  assert.ok(
    tHeld.calories >= floors.calories,
    `and still clears the calorie floor (${tHeld.calories})`,
  );
});

test("the floor still wins: with nothing lean to reach for, the day is fed past the ceiling", () => {
  const byId = new Map([R("dense-a", 560, 55), R("dense-b", 593, 51)].map((r) => [r.id, r]));
  // 106 g, 1,153 kcal; the only lever left is a bump that crosses the ceiling
  const plan = {
    week: "2026-W48",
    entries: [E("b", D, "lunch", "dense-a", 1), E("c", D, "dinner", "dense-b", 1)],
  };
  const floors = { calories: 1700, protein: 100 };
  const held = macroTopUp(plan, [], byId, floors, 3, { proteinTargetG: 100, proteinCeilingG: 120 });
  const t = dayTotals(held.entries, byId, D);
  assert.ok(t.calories >= floors.calories, `health before money (${t.calories} kcal)`);
  assert.ok(t.protein > 120, "and the ceiling was knowingly crossed to get there");
  // deferFloor leaves that last run to a later, wider pass
  const deferred = macroTopUp(plan, [], byId, floors, 3, {
    proteinTargetG: 100,
    proteinCeilingG: 120,
    deferFloor: true,
  });
  assert.ok(dayTotals(deferred.entries, byId, D).protein <= 120);
});
