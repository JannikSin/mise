import test from "node:test";
import assert from "node:assert/strict";
import { weightTrend } from "../app/lib/weight.js";

test("no data returns no-data with everything null", () => {
  assert.deepEqual(weightTrend([], "2026-07-10"), {
    current: null,
    avg7: null,
    prevAvg7: null,
    lbPerWeek: null,
    verdict: "no-data",
  });
});

test("fewer than 7 weigh-ins returns building (needs a baseline)", () => {
  const days = [
    { date: "2026-07-01", weight: 200 },
    { date: "2026-07-02", weight: 200.2 },
    { date: "2026-07-03", weight: 200.1 },
  ];
  const trend = weightTrend(days, "2026-07-03");
  assert.equal(trend.verdict, "building");
  assert.equal(trend.current, 200.1);
  assert.equal(trend.avg7, null);
  assert.equal(trend.prevAvg7, null);
  assert.equal(trend.lbPerWeek, null);
});

test("exactly 7 weigh-ins with no prior window is still building", () => {
  const days = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-07-0${i + 1}`,
    weight: 200,
  }));
  const trend = weightTrend(days, "2026-07-07");
  assert.equal(trend.verdict, "building");
  assert.equal(trend.avg7, 200);
  assert.equal(trend.prevAvg7, null);
});

test("on-target: 0.25-0.75 lb/wk trend between the two windows", () => {
  const prior = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-06-2${i}`,
    weight: 200,
  }));
  const recent = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-07-0${i + 1}`,
    weight: 200.5,
  }));
  const trend = weightTrend([...prior, ...recent], "2026-07-07");
  assert.equal(trend.avg7, 200.5);
  assert.equal(trend.prevAvg7, 200);
  assert.equal(trend.lbPerWeek, 0.5);
  assert.equal(trend.verdict, "on-target");
});

test("too-slow: trend under 0.25 lb/wk", () => {
  const prior = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-06-2${i}`,
    weight: 200,
  }));
  const recent = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-07-0${i + 1}`,
    weight: 200.125,
  }));
  const trend = weightTrend([...prior, ...recent], "2026-07-07");
  assert.ok(trend.lbPerWeek !== null && trend.lbPerWeek > 0 && trend.lbPerWeek < 0.25);
  assert.equal(trend.verdict, "too-slow");
});

test("too-fast: trend over 0.75 lb/wk", () => {
  const prior = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-06-2${i}`,
    weight: 200,
  }));
  const recent = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-07-0${i + 1}`,
    weight: 210,
  }));
  const trend = weightTrend([...prior, ...recent], "2026-07-07");
  assert.equal(trend.lbPerWeek, 10);
  assert.equal(trend.verdict, "too-fast");
});

test("gaps in weigh-in days do not corrupt the window (counted by weigh-in, not calendar day)", () => {
  // 16 calendar days, weight missing on 06-05 and 06-12 (skipped mornings):
  // 14 actual weigh-ins, first 7 at 200 (prior window), last 7 at 200.5
  const days = [
    { date: "2026-06-01", weight: 200 },
    { date: "2026-06-02", weight: 200 },
    { date: "2026-06-03", weight: 200 },
    { date: "2026-06-04", weight: 200 },
    { date: "2026-06-05" }, // gap, no weight logged
    { date: "2026-06-06", weight: 200 },
    { date: "2026-06-07", weight: 200 },
    { date: "2026-06-08", weight: 200 },
    { date: "2026-06-09", weight: 200.5 },
    { date: "2026-06-10", weight: 200.5 },
    { date: "2026-06-11", weight: 200.5 },
    { date: "2026-06-12" }, // gap, no weight logged
    { date: "2026-06-13", weight: 200.5 },
    { date: "2026-06-14", weight: 200.5 },
    { date: "2026-06-15", weight: 200.5 },
    { date: "2026-06-16", weight: 200.5 },
  ];
  const trend = weightTrend(days, "2026-06-16");
  assert.equal(trend.avg7, 200.5);
  assert.equal(trend.prevAvg7, 200);
  assert.equal(trend.lbPerWeek, 0.5);
  assert.equal(trend.verdict, "on-target");
  assert.equal(trend.current, 200.5);
});

// --- loss phase (phase = "loss") ---

test("loss phase, on-target: losing 0.5-1.25 lb/wk", () => {
  const prior = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-06-2${i}`,
    weight: 200,
  }));
  const recent = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-07-0${i + 1}`,
    weight: 199,
  }));
  const trend = weightTrend([...prior, ...recent], "2026-07-07", "loss");
  assert.equal(trend.lbPerWeek, -1);
  assert.equal(trend.verdict, "on-target");
});

test("loss phase, too-slow: losing less than 0.5 lb/wk", () => {
  const prior = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-06-2${i}`,
    weight: 200,
  }));
  const recent = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-07-0${i + 1}`,
    weight: 199.9,
  }));
  const trend = weightTrend([...prior, ...recent], "2026-07-07", "loss");
  assert.ok(trend.lbPerWeek !== null && trend.lbPerWeek < 0 && trend.lbPerWeek > -0.5);
  assert.equal(trend.verdict, "too-slow");
});

test("loss phase, too-slow: flat or gaining also reads too-slow, not too-fast", () => {
  const prior = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-06-2${i}`,
    weight: 200,
  }));
  const recent = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-07-0${i + 1}`,
    weight: 200.5,
  }));
  const trend = weightTrend([...prior, ...recent], "2026-07-07", "loss");
  assert.equal(trend.lbPerWeek, 0.5);
  assert.equal(trend.verdict, "too-slow");
});

test("loss phase, too-fast: losing more than 1.25 lb/wk", () => {
  const prior = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-06-2${i}`,
    weight: 200,
  }));
  const recent = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-07-0${i + 1}`,
    weight: 197,
  }));
  const trend = weightTrend([...prior, ...recent], "2026-07-07", "loss");
  assert.equal(trend.lbPerWeek, -3);
  assert.equal(trend.verdict, "too-fast");
});

test("loss phase, building: fewer than 7 weigh-ins, same as gain", () => {
  const days = [
    { date: "2026-07-01", weight: 150 },
    { date: "2026-07-02", weight: 149.8 },
  ];
  const trend = weightTrend(days, "2026-07-02", "loss");
  assert.equal(trend.verdict, "building");
});

test("gain phase is unaffected by the phase param (default and explicit agree)", () => {
  const prior = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-06-2${i}`,
    weight: 200,
  }));
  const recent = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-07-0${i + 1}`,
    weight: 200.5,
  }));
  const days = [...prior, ...recent];
  const withDefault = weightTrend(days, "2026-07-07");
  const withExplicit = weightTrend(days, "2026-07-07", "gain");
  assert.deepEqual(withDefault, withExplicit);
  assert.equal(withDefault.verdict, "on-target");
});

test("weigh-ins dated after todayIso are ignored (no extrapolation)", () => {
  const days = [
    { date: "2026-07-01", weight: 200 },
    { date: "2026-07-02", weight: 200 },
    { date: "2026-07-03", weight: 200 },
    { date: "2026-07-04", weight: 200 },
    { date: "2026-07-05", weight: 200 },
    { date: "2026-07-06", weight: 200 },
    { date: "2026-07-07", weight: 200 },
    { date: "2026-07-08", weight: 999 }, // logged for a future day
  ];
  const trend = weightTrend(days, "2026-07-07");
  assert.equal(trend.current, 200);
  assert.equal(trend.avg7, 200);
});
