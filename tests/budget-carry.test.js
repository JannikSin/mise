// P5: the week's number with last week's overage carried, and the eaten aim.
// David, 2026-11-06: "100 total. and i mean it is not a hard hard cap but
// still.... it is best ot keep the actual eaten bit at 50 or less. and if
// necessary can go above but that means next weeks should be less."
import test from "node:test";
import assert from "node:assert/strict";
import { EATEN_SHARE, recordTripEstimate, tripSpent, weekBudget } from "../app/lib/budget.js";
import { normalizePlan } from "../app/lib/plan.js";

test("budget carry: no shopped week before means the full $100, eaten aim $50", () => {
  const wb = weekBudget(100, null);
  assert.deepEqual(
    { cap: wb?.cap, carried: wb?.carried, eatenCap: wb?.eatenCap },
    { cap: 100, carried: 0, eatenCap: 50 },
  );
  assert.equal(EATEN_SHARE, 0.5);
});

test("budget carry: a $130 trip last week makes this week $70", () => {
  const prev = {
    week: "2026-W45",
    entries: [],
    spend: [{ store: "pay-less", date: "2026-11-06", total: 130, estimate: true, cap: 100 }],
  };
  const wb = weekBudget(100, prev);
  assert.equal(wb?.carried, 30);
  assert.equal(wb?.cap, 70);
  assert.equal(
    wb?.eatenCap,
    50,
    "the eaten aim is about what meals cost, not reduced by the carry",
  );
});

test("budget carry: under budget last week carries nothing (no credit either)", () => {
  const prev = {
    spend: [{ store: "pay-less", date: "2026-11-06", total: 82.4, estimate: true, cap: 100 }],
  };
  assert.equal(weekBudget(100, prev)?.cap, 100);
});

test("budget carry: a run of over weeks keeps carrying against the cap it was shopped at", () => {
  // week 1: $130 against $100, week 2 cap $70; week 2 spends $100 against
  // that $70, so week 3 is $70 again, not forgiven back to $100
  const wk2 = {
    spend: [{ store: "pay-less", date: "2026-11-13", total: 100, estimate: true, cap: 70 }],
  };
  assert.equal(weekBudget(100, wk2)?.cap, 70);
});

test("budget carry: an approved receipt beats the List's estimate", () => {
  const prev = {
    spend: [
      { store: "pay-less", date: "2026-11-06", total: 120, estimate: true, cap: 100 },
      { store: "pay-less", date: "2026-11-06", total: 104.5 },
    ],
  };
  const t = tripSpent(prev);
  assert.deepEqual(t, { total: 104.5, cap: 100, estimate: false });
  assert.equal(weekBudget(100, prev)?.cap, 95.5);
});

test("budget carry: the cap never goes below zero", () => {
  const prev = {
    spend: [{ store: "pay-less", date: "2026-11-06", total: 271, estimate: true, cap: 100 }],
  };
  assert.equal(weekBudget(100, prev)?.cap, 0);
});

test("budget carry: no weekly budget set means no budget line", () => {
  assert.equal(weekBudget(undefined, null), null);
  assert.equal(weekBudget(0, null), null);
});

test("GOING TO THE STORE records the trip estimate with its cap; a re-save replaces it, receipts stay", () => {
  let plan = {
    week: "2026-W46",
    entries: [],
    spend: [{ store: "pay-less", date: "2026-11-05", total: 12 }],
  };
  plan = /** @type {any} */ (
    recordTripEstimate(plan, { store: "pay-less", date: "2026-11-06", total: 118.234, cap: 100 })
  );
  plan = /** @type {any} */ (
    recordTripEstimate(plan, { store: "pay-less", date: "2026-11-06", total: 96.1, cap: 100 })
  );
  assert.deepEqual(plan.spend, [
    { store: "pay-less", date: "2026-11-05", total: 12 },
    { store: "pay-less", date: "2026-11-06", total: 96.1, estimate: true, cap: 100 },
  ]);
  // and it survives a load: normalizePlan keeps spend rows as written
  assert.deepEqual(normalizePlan(plan, "2026-W46").spend, plan.spend);
});
