import test from "node:test";
import assert from "node:assert/strict";
import { DOZEN_GROUPS, dozenRemaining } from "../app/lib/dozen.js";

const TARGETS = { dailyDozen: { beverages: 5, greens: 2, otherFruit: 3, otherVeg: 2 } };

test("dozenRemaining computes the gap per category", () => {
  const day = { dozen: { beverages: 2, greens: 2, otherFruit: 0 } };
  assert.deepEqual(dozenRemaining(day, TARGETS), {
    beverages: 3,
    greens: 0,
    otherFruit: 3,
    otherVeg: 2,
  });
});

test("dozenRemaining never goes negative when a category is over target", () => {
  const day = { dozen: { beverages: 9 } };
  assert.equal(dozenRemaining(day, TARGETS).beverages, 0);
});

test("dozenRemaining defaults to zero remaining when day/targets are absent (never fabricates a goal)", () => {
  assert.deepEqual(dozenRemaining(undefined, null), {
    beverages: 0,
    greens: 0,
    otherFruit: 0,
    otherVeg: 0,
  });
});

test("DOZEN_GROUPS exposes the four hand-tracked categories in display order", () => {
  assert.deepEqual(DOZEN_GROUPS.map((g) => g.key), [
    "beverages",
    "greens",
    "otherFruit",
    "otherVeg",
  ]);
});
