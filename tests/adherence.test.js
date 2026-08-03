import test from "node:test";
import assert from "node:assert/strict";
import { weekAdherence, rankScoreboard } from "../app/lib/adherence.js";

// 2026-W30 = Mon Jul 20 .. Sun Jul 26; "today" Thu Jul 23 -> 3 elapsed days
const WEEK = "2026-W30";
const TODAY = "2026-07-23";
const entry = (date, over = {}) => ({
  id: date + (over.slot ?? "dinner"),
  date,
  slot: "dinner",
  recipeId: "lentil-bolognese",
  servings: 1,
  ...over,
});

test("adherence counts only finished days; today never counts against you", () => {
  const plan = {
    week: WEEK,
    shoppedAt: "2026-07-20",
    entries: [
      entry("2026-07-20", { cookedAt: "2026-07-20" }),
      entry("2026-07-21"), // uncooked, past: counts against
      entry("2026-07-23"), // TODAY: not counted yet
      entry("2026-07-25"), // future: not counted
    ],
  };
  const a = weekAdherence({ plan, daily: { days: [] }, weekId: WEEK, today: TODAY });
  assert.deepEqual(a.cooked, { done: 1, total: 2 });
  assert.equal(a.logged.total, 12, "3 elapsed days x 4 tracks");
  assert.equal(a.shopped, true);
  // 50*(1/2) + 30*0 + 20*1 = 45
  assert.equal(a.score, 45);
});

test("out and table entries never count as cookable", () => {
  const plan = {
    week: WEEK,
    entries: [
      entry("2026-07-20", { out: true, recipeId: undefined, freeText: "eating out" }),
      entry("2026-07-21", { table: "t1" }),
    ],
  };
  const a = weekAdherence({ plan, daily: null, weekId: WEEK, today: TODAY });
  assert.deepEqual(a.cooked, { done: 0, total: 0 });
});

test("logs count per track per day; supplements is the tick map", () => {
  const daily = {
    days: [
      { date: "2026-07-20", weight: 181, water: 3, pushups: 200, supplements: { creatine: true } },
      { date: "2026-07-21", weight: 181 },
    ],
  };
  const a = weekAdherence({ plan: null, daily, weekId: WEEK, today: TODAY });
  assert.deepEqual(a.logged, { done: 5, total: 12 });
});

test("components with nothing to measure drop out and weights renormalize", () => {
  // Monday: no elapsed days, no cookable, no log cells -> only the receipt
  const monday = weekAdherence({
    plan: { week: WEEK, shoppedAt: "2026-07-19", entries: [] },
    daily: null,
    weekId: WEEK,
    today: "2026-07-20",
  });
  assert.equal(monday.score, 100, "receipt scanned = the only measurable thing, fully done");
  const noReceipt = weekAdherence({ plan: null, daily: null, weekId: WEEK, today: "2026-07-20" });
  assert.equal(noReceipt.score, 0);
});

test("rankScoreboard sorts by score desc, name as stable tiebreak", () => {
  const rows = [
    { name: "Mom", score: 80 },
    { name: "David", score: 95 },
    { name: "Laurie", score: 80 },
  ];
  assert.deepEqual(
    rankScoreboard(rows).map((r) => r.name),
    ["David", "Laurie", "Mom"],
  );
});

test("a profile is scored ONLY on its own tracks — a no-pushups profile can reach 100", () => {
  // council 2026-08-02: LOG_TRACKS was hard-coded to David's four, so a
  // loss-phase profile (tracks: sleep/weight/waist/water/dailyDozen) was
  // scored on pushups and supplements its check-in never renders — ceiling
  // 85 in a "fair" household competition. This pins the fix.
  const tracks = ["sleep", "weight", "waist", "water", "dailyDozen"];
  const days = ["2026-07-20", "2026-07-21"].map((date) => ({
    date,
    sleepHours: 7.5,
    weight: 180,
    waist: 33,
    water: 2.5,
    dozen: { greens: 2 },
  }));
  const plan = {
    week: WEEK,
    shoppedAt: "2026-07-20",
    entries: [
      { id: "a", date: "2026-07-20", slot: "dinner", recipeId: "x", servings: 1, cookedAt: "2026-07-20" },
      { id: "b", date: "2026-07-21", slot: "dinner", recipeId: "x", servings: 1, cookedAt: "2026-07-21" },
    ],
  };
  const a = weekAdherence({ plan, daily: { days }, weekId: WEEK, today: "2026-07-22", tracks });
  assert.equal(a.score, 100, "every declared track logged, all cooked, receipt in = 100");
  // and absent tracks keeps the legacy four (David/back-compat)
  const legacy = weekAdherence({ plan, daily: { days }, weekId: WEEK, today: "2026-07-22" });
  assert.ok(legacy.score < 100, "legacy default still counts pushups+supplements");
});
