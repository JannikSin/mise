import test from "node:test";
import assert from "node:assert/strict";
import { appendWaste, wasteBetween } from "../app/lib/waste.js";
import { expirePerishables } from "../app/lib/shopping.js";

test("expirePerishables returns the tossed rows, not just names", () => {
  const pantry = {
    perishables: [
      { id: "sp1", food: "spinach", added: "2026-07-01", qty: "1 bag", location: "fridge" },
      { id: "eg1", food: "eggs", added: "2026-07-18" },
    ],
  };
  const { expired, tossed } = expirePerishables(pantry, "2026-07-19");
  assert.deepEqual(expired, ["spinach"]);
  assert.equal(tossed.length, 1);
  assert.equal(tossed[0].food, "spinach");
  assert.equal(tossed[0].qty, "1 bag");
});

test("appendWaste writes one explicit event per tossed row and preserves history", () => {
  const first = appendWaste(
    null,
    [{ id: "sp1", food: "spinach", qty: "1 bag", added: "2026-07-01", location: "fridge" }],
    "2026-07-19",
  );
  assert.equal(first.events.length, 1);
  assert.deepEqual(first.events[0], {
    id: "sp1|2026-07-19|expired",
    date: "2026-07-19",
    reason: "expired",
    rowId: "sp1",
    food: "spinach",
    qty: "1 bag",
    added: "2026-07-01",
    location: "fridge",
  });
  // appending later never loses earlier events (this history cannot be backfilled)
  const second = appendWaste(first, [{ food: "milk" }], "2026-07-26", "dormancy");
  assert.equal(second.events.length, 2);
  assert.equal(second.events[1].reason, "dormancy");
  assert.equal(second.events[1].rowId, null);
});

test("appendWaste is idempotent per (row, date, reason) — two devices, one event", () => {
  const row = { id: "sp1", food: "spinach", added: "2026-07-01" };
  const once = appendWaste(null, [row], "2026-07-19");
  const twice = appendWaste(once, [row], "2026-07-19");
  assert.equal(twice.events.length, 1);
  // a different day IS a new event (bought again, expired again), and its
  // event id is UNIQUE so the keyed 409 merge can never collapse the two
  // (reviewer finding 1: history loss through keyedMap)
  const later = appendWaste(twice, [row], "2026-07-27");
  assert.equal(later.events.length, 2);
  assert.notEqual(later.events[0].id, later.events[1].id);
});

test("wasteBetween filters to the review window", () => {
  const waste = {
    events: [
      { date: "2026-07-12", food: "a" },
      { date: "2026-07-19", food: "b" },
      { date: "2026-07-26", food: "c" },
    ],
  };
  assert.deepEqual(
    wasteBetween(waste, "2026-07-13", "2026-07-19").map((e) => e.food),
    ["b"],
  );
  assert.deepEqual(wasteBetween(null, "2026-07-01", "2026-07-31"), []);
});
