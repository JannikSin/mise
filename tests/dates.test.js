import test from "node:test";
import assert from "node:assert/strict";
import { isoWeekId, localIsoDate, statusDate } from "../app/lib/dates.js";

test("isoWeekId for a mid-year Monday", () => {
  assert.equal(isoWeekId(new Date(2026, 6, 6)), "2026-W28"); // Mon Jul 6 2026
});

test("isoWeekId year boundaries", () => {
  assert.equal(isoWeekId(new Date(2026, 0, 1)), "2026-W01"); // Thu Jan 1 2026
  assert.equal(isoWeekId(new Date(2027, 0, 1)), "2026-W53"); // Fri Jan 1 2027 belongs to prior ISO year
});

test("statusDate renders console format", () => {
  assert.equal(statusDate(new Date(2026, 6, 6)), "MON 07·06");
});

test("localIsoDate is the LOCAL day with zero padding", () => {
  assert.equal(localIsoDate(new Date(2026, 6, 6)), "2026-07-06");
  assert.equal(localIsoDate(new Date(2026, 0, 1, 23, 59)), "2026-01-01"); // late evening stays today
});
