import test from "node:test";
import assert from "node:assert/strict";
import { dayQualifies, computeStreak } from "../app/lib/fitness.js";

const SUPPS = ["creatine", "magnesium"];
const TARGET = 200;
const WATER = 3.5; // liters

const goodDay = (date) => ({
  date,
  sleepHours: 8,
  pushups: 200,
  water: 3.5,
  supplements: { creatine: true, magnesium: true },
});

test("dayQualifies: sleep + pushups + water (liters) + all supplements", () => {
  assert.equal(dayQualifies(goodDay("2026-07-06"), SUPPS, TARGET, WATER), true);
  assert.equal(dayQualifies({ ...goodDay("x"), pushups: 199 }, SUPPS, TARGET, WATER), false);
  assert.equal(dayQualifies({ ...goodDay("x"), water: 3.25 }, SUPPS, TARGET, WATER), false);
  assert.equal(
    dayQualifies({ ...goodDay("x"), sleepHours: undefined }, SUPPS, TARGET, WATER),
    false,
  );
  assert.equal(
    dayQualifies({ ...goodDay("x"), supplements: { creatine: true } }, SUPPS, TARGET, WATER),
    false,
  );
  assert.equal(dayQualifies(undefined, SUPPS, TARGET, WATER), false);
});

test("computeStreak counts consecutive qualifying days ending today", () => {
  const days = [goodDay("2026-07-04"), goodDay("2026-07-05"), goodDay("2026-07-06")];
  assert.equal(computeStreak(days, SUPPS, TARGET, WATER, "2026-07-06"), 3);
});

test("an incomplete today does not break yesterday's streak", () => {
  const days = [goodDay("2026-07-04"), goodDay("2026-07-05")];
  assert.equal(computeStreak(days, SUPPS, TARGET, WATER, "2026-07-06"), 2);
});

test("a gap breaks the streak", () => {
  const days = [goodDay("2026-07-02"), goodDay("2026-07-03"), goodDay("2026-07-05")];
  assert.equal(computeStreak(days, SUPPS, TARGET, WATER, "2026-07-05"), 1);
});

test("no qualifying days = 0", () => {
  assert.equal(computeStreak([], SUPPS, TARGET, WATER, "2026-07-06"), 0);
  assert.equal(
    computeStreak([{ date: "2026-07-06", pushups: 10 }], SUPPS, TARGET, WATER, "2026-07-06"),
    0,
  );
});

test("K1: streak only checks the markers the profile actually tracks", () => {
  // Mom-style profile: sleep + water only, no pushups, no supplements
  const momTracks = ["sleep", "weight", "water", "dailyDozen"];
  const momDay = { date: "x", sleepHours: 7, water: 2.0 };
  assert.equal(dayQualifies(momDay, [], 200, 2.0, momTracks), true);
  // her missing pushups never disqualify her
  assert.equal(dayQualifies({ ...momDay, pushups: 0 }, [], 200, 2.0, momTracks), true);
  // but HER tracked water still must hit target
  assert.equal(dayQualifies({ ...momDay, water: 1.0 }, [], 200, 2.0, momTracks), false);
  // a profile tracking no streak markers never qualifies
  assert.equal(dayQualifies(momDay, [], 200, 2.0, ["weight", "dailyDozen"]), false);
  // absent tracks = David's full legacy rule, unchanged
  assert.equal(dayQualifies(momDay, [], 200, 2.0), false); // no pushups logged
});

test("K1: computeStreak counts a sleep-only profile's run", () => {
  const days = [
    { date: "2026-07-19", sleepHours: 8 },
    { date: "2026-07-20", sleepHours: 7 },
    { date: "2026-07-21", sleepHours: 6.5 },
  ];
  assert.equal(computeStreak(days, [], 200, 3.5, "2026-07-21", ["sleep"]), 3);
});
