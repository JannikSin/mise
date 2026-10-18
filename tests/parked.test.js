import { test } from "node:test";
import assert from "node:assert/strict";
import { PARKED, isParked } from "../app/lib/parked.js";

// Mise decision 0016 (David, 2026-10-12): menu scan, remedies and occasions are
// parked. Their routes and tests stay; only the doors on the screens close.
// Decision 0018 (David, 2026-10-16) parks seven more: house money, the Kroger
// cart buttons, the re-roll, recipe browsing, the dinner chat, the tour, the
// Table tab's per-meal week. Decision 0019 (2026-10-18, v1.4) brings back the re-roll and
// the cart button (after GOING TO THE STORE); only the live-price controls stay parked.
test("the parked set is exactly what David parked on 2026-10-12 and 2026-10-16, less the re-roll", () => {
  assert.deepEqual(
    [...PARKED].sort(),
    [
      "cookbook",
      "dinnerchat",
      "liveprices",
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

// 2026-10-17: a fridge component goes with a dinner, never a planned snack
test("fridge components are never auto-planned", async () => {
  const { autoPlanEligible } = await import("../app/lib/plan.js");
  assert.equal(autoPlanEligible({ id: "raita", mealType: "snack", tags: ["fridge-component"] }), false);
  assert.equal(autoPlanEligible({ id: "muffin", mealType: "snack", tags: ["batch-friendly"] }), true);
});
