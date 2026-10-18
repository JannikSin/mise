import { test } from "node:test";
import assert from "node:assert/strict";
import { PARKED, isParked } from "../app/lib/parked.js";

// Mise decision 0016 (David, 2026-10-12): menu scan, remedies and occasions are
// parked. Their routes and tests stay; only the doors on the screens close.
// Decision 0018 (David, 2026-10-16) parks seven more: house money, the Kroger
// cart buttons, the re-roll, recipe browsing, the dinner chat, the tour, the
// Table tab's per-meal week. David brought the re-roll back on 2026-10-18 (v1.4).
test("the parked set is exactly what David parked on 2026-10-12 and 2026-10-16, less the re-roll", () => {
  assert.deepEqual(
    [...PARKED].sort(),
    [
      "cookbook",
      "dinnerchat",
      "kroger",
      "menu",
      "money",
      "occasions",
      "remedies",
      "tableweek",
      "tour",
    ],
  );
  assert.equal(isParked("menu"), true);
  assert.equal(isParked("hall"), false, "hall trays were kept, never parked");
  assert.equal(isParked("invite"), false, "invites were kept, never parked");
  assert.equal(isParked("reroll"), false, "PICK DIFFERENT MEALS is back (2026-10-18)");
});
