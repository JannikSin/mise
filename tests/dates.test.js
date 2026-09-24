import test from "node:test";
import assert from "node:assert/strict";
import { isoWeekId, localIsoDate, planStartIso, statusDate } from "../app/lib/dates.js";

test("isoWeekId for a mid-year Monday", () => {
  assert.equal(isoWeekId(new Date(2026, 6, 6)), "2026-W28"); // Mon Jul 6 2026
});

test("isoWeekId: a Sunday opens the FOLLOWING week id (weeks start Sunday, 2026-09-05)", () => {
  assert.equal(isoWeekId(new Date(2026, 7, 30)), "2026-W36"); // Sun Aug 30 2026 opens W36
  assert.equal(isoWeekId(new Date(2026, 8, 5)), "2026-W36"); // Sat Sep 5 2026 closes it
  assert.equal(isoWeekId(new Date(2026, 8, 6)), "2026-W37"); // Sun Sep 6 2026 opens W37
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

test("planStartIso: today before 7:30 pm, tomorrow after, across a month and a week end", () => {
  // David, 2026-09-24: a Thursday 11 pm generate must not plan or buy Thursday
  assert.equal(planStartIso(new Date(2026, 8, 24, 16, 45)), "2026-09-24");
  assert.equal(planStartIso(new Date(2026, 8, 24, 19, 29)), "2026-09-24");
  assert.equal(planStartIso(new Date(2026, 8, 24, 19, 30)), "2026-09-25");
  assert.equal(planStartIso(new Date(2026, 8, 24, 23, 0)), "2026-09-25");
  assert.equal(planStartIso(new Date(2026, 8, 30, 22, 0)), "2026-10-01");
  // Saturday night rolls into next week's Sunday, so nothing of this week is bought
  assert.equal(planStartIso(new Date(2026, 8, 26, 21, 0)), "2026-09-27");
});
