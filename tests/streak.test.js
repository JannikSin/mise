import test from "node:test";
import assert from "node:assert/strict";
import { dayQualifies, computeStreak } from "../app/lib/fitness.js";

const SUPPS = ["creatine", "magnesium"];
const TARGET = 200;

const goodDay = (date) => ({
  date,
  sleepHours: 8,
  pushups: 200,
  supplements: { creatine: true, magnesium: true },
});

test("dayQualifies: sleep logged + pushups at target + all supplements ticked", () => {
  assert.equal(dayQualifies(goodDay("2026-07-06"), SUPPS, TARGET), true);
  assert.equal(dayQualifies({ ...goodDay("x"), pushups: 199 }, SUPPS, TARGET), false);
  assert.equal(dayQualifies({ ...goodDay("x"), sleepHours: undefined }, SUPPS, TARGET), false);
  assert.equal(
    dayQualifies({ ...goodDay("x"), supplements: { creatine: true } }, SUPPS, TARGET),
    false,
  );
  assert.equal(dayQualifies(undefined, SUPPS, TARGET), false);
});

test("computeStreak counts consecutive qualifying days ending today", () => {
  const days = [goodDay("2026-07-04"), goodDay("2026-07-05"), goodDay("2026-07-06")];
  assert.equal(computeStreak(days, SUPPS, TARGET, "2026-07-06"), 3);
});

test("an incomplete today does not break yesterday's streak", () => {
  const days = [goodDay("2026-07-04"), goodDay("2026-07-05")];
  assert.equal(computeStreak(days, SUPPS, TARGET, "2026-07-06"), 2);
});

test("a gap breaks the streak", () => {
  const days = [goodDay("2026-07-02"), goodDay("2026-07-03"), goodDay("2026-07-05")];
  assert.equal(computeStreak(days, SUPPS, TARGET, "2026-07-05"), 1);
});

test("no qualifying days = 0", () => {
  assert.equal(computeStreak([], SUPPS, TARGET, "2026-07-06"), 0);
  assert.equal(
    computeStreak([{ date: "2026-07-06", pushups: 10 }], SUPPS, TARGET, "2026-07-06"),
    0,
  );
});
