import test from "node:test";
import assert from "node:assert/strict";
import { labelLineFor } from "../app/lib/shopping.js";
import { leftOffFor } from "../app/lib/tailor.js";

// shrike's 1.96 audit (10/25), the rest of items 8 and 3

test("item 8: a List row says check the label for peanut, naming who in the house avoids it", () => {
  const seats = [
    { name: "Elliot", avoid: ["peanut"] },
    { name: "you", avoid: [] },
  ];
  assert.equal(labelLineFor(["semi-sweet chocolate chips"], seats), "Check the label for peanut (Elliot)");
  assert.equal(labelLineFor(["granola"], seats), "Check the label for peanut (Elliot)");
  assert.equal(labelLineFor(["brown rice"], seats), "", "a plain food says nothing");
  assert.equal(labelLineFor(["semi-sweet chocolate chips"], [{ name: "you", avoid: [] }]), "", "nobody avoids peanut");
  assert.equal(
    labelLineFor(["chocolate chips"], [...seats, { name: "Sam", avoid: ["peanuts"] }]),
    "Check the label for peanut (Elliot, Sam)",
  );
  assert.ok(!labelLineFor(["chocolate chips"], seats).includes("—"));
});

test("item 3: the rotation card leaves off a pick the viewer avoids and names it; unread refuses all", () => {
  const rows = [{ food: "frozen mixed berries" }, { food: "peanut butter" }, { food: "rolled oats" }];
  const r = leftOffFor(rows, ["peanut"]);
  assert.deepEqual(r.left.map((c) => c.food), ["peanut butter"]);
  assert.deepEqual(r.mine.map((c) => c.food), ["frozen mixed berries", "rolled oats"]);
  assert.deepEqual(leftOffFor(rows, ["peanuts"]).left.map((c) => c.food), ["peanut butter"], "plural catches singular");
  assert.deepEqual(leftOffFor(rows, []).left, []);
  assert.deepEqual(leftOffFor(rows, null).mine, [], "an unread list fails closed");
});
