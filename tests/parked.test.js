import { test } from "node:test";
import assert from "node:assert/strict";
import { PARKED, isParked } from "../app/lib/parked.js";

// Mise decision 0016 (David, 2026-10-12): menu scan, remedies and occasions are
// parked. Their routes and tests stay; only the doors on the screens close.
test("the parked set is exactly the three features David parked on 2026-10-12", () => {
  assert.deepEqual([...PARKED].sort(), ["menu", "occasions", "remedies"]);
  assert.equal(isParked("menu"), true);
  assert.equal(isParked("hall"), false, "hall trays were kept, never parked");
  assert.equal(isParked("invite"), false, "invites were kept, never parked");
});
