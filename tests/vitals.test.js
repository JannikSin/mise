import test from "node:test";
import assert from "node:assert/strict";
import { latestWith, series, average, sparkPoints, latestEkg } from "../app/lib/vitals.js";

const DAYS = [
  { date: "2026-07-16", steps: 5580, hrvMs: 43 },
  { date: "2026-07-18", steps: 8432, hrvMs: 46 },
  { date: "2026-07-17", steps: 8760 }, // no hrv this day
];

test("latestWith returns the newest day carrying the field, null when none", () => {
  assert.deepEqual(latestWith(DAYS, "steps"), { date: "2026-07-18", value: 8432 });
  // newest day (07-18) has hrv, so it wins
  assert.deepEqual(latestWith(DAYS, "hrvMs"), { date: "2026-07-18", value: 46 });
  assert.equal(latestWith(DAYS, "vo2max"), null);
});

test("series is oldest-first, skips days missing the field, caps at n", () => {
  assert.deepEqual(
    series(DAYS, "hrvMs", 5),
    [
      { date: "2026-07-16", value: 43 },
      { date: "2026-07-18", value: 46 },
    ],
  );
  // 07-17 has no hrv, so it is absent (no phantom zero)
  assert.equal(series(DAYS, "steps", 2).length, 2);
  assert.deepEqual(series(DAYS, "steps", 2).map((p) => p.value), [8760, 8432]);
});

test("average rounds and handles empty", () => {
  assert.equal(average([{ value: 43 }, { value: 46 }]), 45); // rounds 44.5 -> 45
  assert.equal(average([{ value: 3.2 }, { value: 4.4 }], 1), 3.8);
  assert.equal(average([]), null);
});

test("sparkPoints maps a series into a padded box, flat + empty handled", () => {
  assert.equal(sparkPoints([], 120, 32), "");
  assert.equal(sparkPoints([{ value: 5 }], 120, 32), "0,16 120,16");
  const p = sparkPoints([{ value: 0 }, { value: 10 }], 120, 32);
  // two points -> x at 0 and 120; min maps to bottom (y=30), max to top (y=2)
  assert.equal(p, "0,30 120,2");
});

test("latestEkg returns the newest reading or null", () => {
  assert.equal(latestEkg([]), null);
  assert.deepEqual(
    latestEkg([
      { date: "2026-07-10", result: "Sinus Rhythm" },
      { date: "2026-07-15", result: "Sinus Rhythm", avgBpm: 61 },
    ]),
    { date: "2026-07-15", result: "Sinus Rhythm", avgBpm: 61 },
  );
});
