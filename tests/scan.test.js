import test from "node:test";
import assert from "node:assert/strict";
import { applyScanItems } from "../app/lib/scan.js";

const PANTRY = {
  staples: [
    { id: "rice", name: "Rice", section: "dry-goods", onHand: false, runningLow: true },
    { id: "cayenne", name: "Cayenne", section: "spices", onHand: true, runningLow: false },
  ],
  perishables: [{ food: "half cabbage", qty: "0.5 head", added: "2026-07-04", useSoon: true }],
};

test("staple item refreshes an existing staple instead of duplicating", () => {
  const next = applyScanItems(PANTRY, [{ name: "rice", kind: "staple", qty: "" }], "2026-07-06");
  const rice = next.staples.filter((s) => s.id === "rice");
  assert.equal(rice.length, 1);
  assert.equal(rice[0].onHand, true, "seen in the photo = on hand");
  assert.equal(rice[0].runningLow, false, "seen = not running low");
});

test("new staple is added with a derived id and section", () => {
  const next = applyScanItems(
    PANTRY,
    [{ name: "Olive Oil", kind: "staple", qty: "" }],
    "2026-07-06",
  );
  const oil = next.staples.find((s) => s.id === "olive-oil");
  assert.ok(oil);
  assert.equal(oil.name, "Olive Oil");
  assert.equal(oil.section, "dry-goods");
  assert.equal(oil.onHand, true);
  assert.equal(oil.runningLow, false);
});

test("new perishable lands with today's date; existing one is not duplicated", () => {
  const next = applyScanItems(
    PANTRY,
    [
      { name: "Half Cabbage", kind: "perishable", qty: "0.5 head" },
      { name: "milk", kind: "perishable", qty: "1L" },
    ],
    "2026-07-06",
  );
  assert.equal(next.perishables.filter((p) => p.food.toLowerCase() === "half cabbage").length, 1);
  const milk = next.perishables.find((p) => p.food === "milk");
  assert.ok(typeof milk.id === "string" && milk.id.length > 0); // P1: stable id at creation
  const rest = { ...milk };
  delete rest.id;
  assert.deepEqual(rest, { food: "milk", qty: "1L", added: "2026-07-06", useSoon: false });
});

test("does not mutate the input pantry and tolerates missing arrays", () => {
  const before = JSON.stringify(PANTRY);
  applyScanItems(PANTRY, [{ name: "x", kind: "staple", qty: "" }], "2026-07-06");
  assert.equal(JSON.stringify(PANTRY), before);
  const next = applyScanItems({}, [{ name: "milk", kind: "perishable", qty: "" }], "2026-07-06");
  assert.equal(next.perishables.length, 1);
  assert.deepEqual(next.staples, []);
});
