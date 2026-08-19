// P11 read side (7.1, 2026-08-19): the review composes only from recorded data
import test from "node:test";
import assert from "node:assert/strict";
import { composeWeekReview } from "../app/lib/review.js";

const WEEK = ["2026-08-10","2026-08-11","2026-08-12","2026-08-13","2026-08-14","2026-08-15","2026-08-16"];

test("composeWeekReview reads every axis from recorded data, honest about dark ones", () => {
  const plan = { week: "2026-W33", entries: [
    { id: "a", date: "2026-08-10", slot: "dinner", recipeId: "r1", servings: 1, cookedAt: "2026-08-10", cookSeconds: 2100 },
    { id: "b", date: "2026-08-11", slot: "dinner", recipeId: "r1", servings: 1 },
    { id: "c", date: "2026-08-12", slot: "lunch", freeText: "eating out", servings: 1, out: true },
  ], spend: [{ store: "pay-less", date: "2026-08-10", total: 73.81 }] };
  const waste = { events: [{ id: "w1", date: "2026-08-15", food: "spinach" }] };
  const daily = { days: [{ date: "2026-08-10", weight: 196 }, { date: "2026-08-12", weight: 195.6 }] };
  const byId = new Map([["r1", { id: "r1", totalTime: 30 }]]);
  const r = composeWeekReview({ plan, waste, daily, targets: { weeklyBudgetUsd: 100 }, weekDates: WEEK, recipesById: byId });
  assert.equal(r.hasData, true);
  assert.deepEqual(r.cooked, { done: 1, planned: 2 }, "the OUT placeholder is not a cooking commitment");
  assert.deepEqual(r.spend, { total: 73.81, receipts: 1, budget: 100 });
  assert.deepEqual(r.tossed, { count: 1, foods: ["spinach"] });
  assert.deepEqual(r.time, { timed: 1, statedMin: 30, recordedMin: 35 });
  assert.deepEqual(r.weighIns, { count: 2, days: 7 });
});

test("composeWeekReview with nothing recorded says so instead of inventing", () => {
  const r = composeWeekReview({ plan: null, waste: null, daily: null, targets: null, weekDates: WEEK });
  assert.equal(r.hasData, false);
  assert.equal(r.spend, null);
  assert.equal(r.time, null);
});
