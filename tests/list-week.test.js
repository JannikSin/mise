// THE LIST OPENS ON THE LIST'S WEEK (2026-11-09, P4). Live evidence: on
// Mon 11/9 the List offered "BUILD MON 11/9 – THU 11/12"; after planning the
// next week it offered "BUILD FRI 11/13 – THU 11/19"; and on 11/6 opening the
// List from the tab bar showed THIS week, so BUILD replaced next week's
// 45-row list with a 2-day one and GOING TO THE STORE stamped the wrong week.
import test from "node:test";
import assert from "node:assert/strict";
import { tripFor } from "../app/lib/plan.js";
import { listWeekOnOpen } from "../app/lib/shopping.js";

const MON = "2026-11-09"; // in week 2026-W46 (Sun 11/8 .. Sat 11/14)

test("the odd trip windows are a FRIDAY buy day, not a date bug: Mon to Thu this week, Fri to Thu next", () => {
  assert.deepEqual(tripFor("2026-W46", MON, MON, 5), [
    "2026-11-09",
    "2026-11-10",
    "2026-11-11",
    "2026-11-12",
  ]);
  assert.deepEqual(tripFor("2026-W47", MON, MON, 5), [
    "2026-11-13",
    "2026-11-14",
    "2026-11-15",
    "2026-11-16",
    "2026-11-17",
    "2026-11-18",
    "2026-11-19",
  ]);
  // with a SUNDAY buy day the same Monday shops to Saturday, the next week Sun to Sat
  assert.deepEqual(tripFor("2026-W46", MON, MON, 0).at(-1), "2026-11-14");
  assert.deepEqual(tripFor("2026-W47", MON, MON, 0), [
    "2026-11-15",
    "2026-11-16",
    "2026-11-17",
    "2026-11-18",
    "2026-11-19",
    "2026-11-20",
    "2026-11-21",
  ]);
});

test("a list built for next week opens on next week, so BUILD and GOING TO THE STORE act on that week", () => {
  // the fixture: today's week is W46 and the tab bar left the view on it; the
  // stored list was built from W47 (its trip is mostly W47's days)
  assert.equal(listWeekOnOpen("2026-W46", "2026-W46", "2026-W47"), "2026-W47");
  // across a year end the ids still compare in calendar order
  assert.equal(listWeekOnOpen("2026-W53", "2026-W53", "2027-W01"), "2027-W01");
});

test("otherwise the List keeps the week on screen", () => {
  assert.equal(listWeekOnOpen("2026-W46", "2026-W46", "2026-W46"), "2026-W46", "this week's list");
  assert.equal(listWeekOnOpen("2026-W46", "2026-W46", "2026-W45"), "2026-W46", "an old list");
  assert.equal(listWeekOnOpen("2026-W46", "2026-W46", undefined), "2026-W46", "no list yet");
  assert.equal(listWeekOnOpen("2026-W46", "2026-W46", "junk"), "2026-W46", "not a week id");
  assert.equal(
    listWeekOnOpen("2026-W46", "2026-W44", "2026-W47"),
    "2026-W44",
    "a week he paged to on purpose stays",
  );
  assert.equal(listWeekOnOpen("2026-W46", "2026-W48", "2026-W47"), "2026-W48");
});
