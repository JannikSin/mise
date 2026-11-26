// A DAY HE PICKS HIMSELF (P1, P2, P10). David, 2026-11-25: "i haven't been
// following a plan at all now that ... I'm back home. I've just been making
// egg recipes and eating random things for dinner ... maybe we'll just fix it
// for a day". His go for "he taps what he is making, Mise sizes the portions"
// was relayed by the head on 2026-11-26. These exercise the two pure steps.
import test from "node:test";
import assert from "node:assert/strict";
import { pickMeal, sizeDay, dayTotals } from "../app/lib/plan.js";

const D = "2026-11-27";
const R = new Map(
  [
    { id: "eggs", mealType: "breakfast", nutrition: { calories: 620, protein: 38 } },
    { id: "oats", mealType: "breakfast", nutrition: { calories: 700, protein: 30 } },
    { id: "soup", mealType: "lunch", nutrition: { calories: 780, protein: 46 } },
    { id: "chili", mealType: "dinner", nutrition: { calories: 900, protein: 55 } },
    { id: "muffin", mealType: "snack", nutrition: { calories: 420, protein: 18 } },
    { id: "lettuce", mealType: "lunch", nutrition: { calories: 60, protein: 2 } },
  ].map((r) => [r.id, r]),
);
const BOUNDS = { calories: 3700, calorieFloor: 3500, proteinFloor: 190, proteinCeiling: 215 };
/** @param {any[]} entries */
const plan = (entries) => /** @type {any} */ ({ week: "2026-W48", entries });
const e = (/** @type {string} */ id, /** @type {string} */ slot, /** @type {any} */ more = {}) => ({
  id: `e-${id}`,
  date: D,
  slot,
  recipeId: id,
  servings: 1,
  ...more,
});

test("picking a meal fills an empty slot at one serving", () => {
  const out = pickMeal(plan([]), D, "breakfast", "eggs");
  assert.equal(out.entries.length, 1);
  assert.deepEqual(
    { ...out.entries[0], id: "" },
    { id: "", date: D, slot: "breakfast", recipeId: "eggs", servings: 1 },
  );
});

test("picking a meal replaces his own uneaten meal in that slot, and nothing else", () => {
  const p = plan([e("oats", "breakfast", { servings: 1.5 }), e("chili", "dinner")]);
  const out = pickMeal(p, D, "breakfast", "eggs");
  assert.equal(out.entries.length, 2);
  assert.equal(out.entries[0]?.id, "e-oats", "the entry keeps its id");
  assert.equal(out.entries[0]?.recipeId, "eggs");
  assert.deepEqual(out.entries[1], p.entries[1]);
});

test("picking never replaces an eaten meal or a shared table meal: it adds beside it", () => {
  const eaten = plan([e("oats", "breakfast", { cookedAt: "2026-11-27" })]);
  const a = pickMeal(eaten, D, "breakfast", "eggs");
  assert.equal(a.entries.length, 2);
  assert.equal(a.entries[0]?.recipeId, "oats");
  const table = plan([
    { id: "t1", date: D, slot: "dinner", table: "tbl", viewRecipeId: "chili", servings: 1, estCalories: 900, estProtein: 55 },
  ]);
  const b = pickMeal(table, D, "dinner", "chili");
  assert.equal(b.entries.length, 2);
  assert.equal(b.entries[0]?.table, "tbl");
});

test("picking real food into an eating-out slot takes the mark away", () => {
  const p = plan([{ id: "o1", date: D, slot: "lunch", out: true, servings: 1, estCalories: 700, estProtein: 30 }]);
  const out = pickMeal(p, D, "lunch", "soup");
  assert.deepEqual(
    out.entries.map((x) => x.recipeId),
    ["soup"],
  );
});

test("SIZE THIS DAY: four picked meals land on 3,500+ kcal and 190 to 215 g, in quarter steps", () => {
  const p = plan([e("eggs", "breakfast"), e("soup", "lunch"), e("chili", "dinner"), e("muffin", "snack")]);
  const before = dayTotals(p.entries, R, D);
  assert.ok(before.calories < 3500 && before.protein < 190, "one serving each is short");
  const out = sizeDay(p, D, R, BOUNDS);
  const after = dayTotals(out.plan.entries, R, D);
  assert.equal(out.inBand, true);
  assert.ok(after.calories >= 3500, `calories ${after.calories}`);
  assert.ok(after.protein >= 190 && after.protein <= 215, `protein ${after.protein}`);
  assert.ok(Math.abs(after.calories - 3700) <= 150, `near the target: ${after.calories}`);
  assert.equal(out.calories, Math.round(after.calories));
  assert.equal(out.protein, Math.round(after.protein));
  for (const x of out.plan.entries) {
    assert.equal((x.servings * 4) % 1, 0, "quarter steps only");
    assert.ok(x.servings >= 0.5 && x.servings <= 3);
  }
  assert.deepEqual(
    out.plan.entries.map((x) => x.recipeId),
    p.entries.map((x) => x.recipeId),
    "the meals are the ones he picked",
  );
});

test("SIZE THIS DAY leaves an eaten meal, a table plate and every other day alone, and counts them", () => {
  const p = plan([
    e("eggs", "breakfast", { cookedAt: "2026-11-27", servings: 2 }),
    { id: "t1", date: D, slot: "dinner", table: "tbl", viewRecipeId: "chili", servings: 1, estCalories: 1100, estProtein: 60 },
    e("soup", "lunch"),
    e("muffin", "snack"),
    { ...e("chili", "dinner"), id: "other", date: "2026-11-28" },
  ]);
  const out = sizeDay(p, D, R, BOUNDS);
  const by = new Map(out.plan.entries.map((x) => [x.id, x]));
  assert.equal(by.get("e-eggs")?.servings, 2);
  assert.deepEqual(by.get("t1"), p.entries[1]);
  assert.deepEqual(by.get("other"), p.entries[4]);
  const after = dayTotals(out.plan.entries, R, D);
  assert.equal(out.calories, Math.round(after.calories), "the eaten meal and the table plate are in the total");
  assert.ok(after.protein <= 215.5, `never past the ceiling: ${after.protein}`);
});

test("SIZE THIS DAY says so when the picked meals cannot reach his numbers", () => {
  const p = plan([e("lettuce", "lunch")]);
  const out = sizeDay(p, D, R, BOUNDS);
  assert.equal(out.inBand, false);
  assert.ok(out.shortCalories > 3000 && out.shortProtein > 180);
  assert.equal(out.plan.entries[0]?.servings, 3, "as close as these meals get");
});

test("SIZE THIS DAY on a day already in band changes nothing it does not need to", () => {
  const p = plan([e("eggs", "breakfast"), e("soup", "lunch"), e("chili", "dinner"), e("muffin", "snack")]);
  const once = sizeDay(p, D, R, BOUNDS);
  const twice = sizeDay(once.plan, D, R, BOUNDS);
  assert.equal(twice.sized, 0);
  assert.equal(twice.plan, once.plan);
});

test("a day with nothing of his own to size is returned as it is", () => {
  const p = plan([{ id: "o1", date: D, slot: "lunch", out: true, servings: 1, estCalories: 700, estProtein: 30 }]);
  const out = sizeDay(p, D, R, BOUNDS);
  assert.equal(out.plan, p);
  assert.equal(out.inBand, false);
});
