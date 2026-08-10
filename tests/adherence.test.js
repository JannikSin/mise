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

// The daily-log component retired 2026-08-09 with the in-app check-in
// (personal tracking lives in Crystal). Score = cooking 70 + receipt 30.

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
  const a = weekAdherence({ plan, weekId: WEEK, today: TODAY });
  assert.deepEqual(a.cooked, { done: 1, total: 2 });
  assert.equal(a.shopped, true);
  // 70*(1/2) + 30*1 = 65
  assert.equal(a.score, 65);
});

test("out and table entries never count as cookable", () => {
  const plan = {
    week: WEEK,
    entries: [
      entry("2026-07-20", { out: true, recipeId: undefined, freeText: "eating out" }),
      entry("2026-07-21", { table: "t1" }),
    ],
  };
  const a = weekAdherence({ plan, weekId: WEEK, today: TODAY });
  assert.deepEqual(a.cooked, { done: 0, total: 0 });
});

test("components with nothing to measure drop out and weights renormalize", () => {
  // Monday: no elapsed days, no cookable -> only the receipt
  const monday = weekAdherence({
    plan: { week: WEEK, shoppedAt: "2026-07-19", entries: [] },
    weekId: WEEK,
    today: "2026-07-20",
  });
  assert.equal(monday.score, 100, "receipt scanned = the only measurable thing, fully done");
  const noReceipt = weekAdherence({ plan: null, weekId: WEEK, today: "2026-07-20" });
  assert.equal(noReceipt.score, 0);
});

test("all cooked + receipt = 100, no phantom log component", () => {
  const plan = {
    week: WEEK,
    shoppedAt: "2026-07-20",
    entries: [
      entry("2026-07-20", { cookedAt: "2026-07-20" }),
      entry("2026-07-21", { cookedAt: "2026-07-21" }),
    ],
  };
  const a = weekAdherence({ plan, weekId: WEEK, today: "2026-07-22" });
  assert.equal(a.score, 100);
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

test("an occasion day never counts against the score", () => {
  // a medical-prep week: she ate exactly what the app told her to. If those
  // meals counted as uncooked she would be punished for complying.
  const week = "2026-W33";
  const base = {
    weekId: week,
    today: "2026-08-14",
    plan: {
      week,
      shoppedAt: "2026-08-10",
      entries: [
        { id: "a", date: "2026-08-10", slot: "dinner", recipeId: "x", cookedAt: "2026-08-10" },
        { id: "b", date: "2026-08-11", slot: "dinner", recipeId: "clear-broth-mug", occasion: "colo" },
        { id: "c", date: "2026-08-11", slot: "lunch", recipeId: "clear-broth-mug", occasion: "colo" },
      ],
    },
  };
  const r = weekAdherence(base);
  assert.equal(r.cooked.total, 1, "only the real cookable meal is counted");
  assert.equal(r.score, 100, "complying with a prep week is not a miss");
});
