import { test } from "node:test";
import assert from "node:assert/strict";
import { screenSeats, screenOccasion } from "../app/lib/screen-seats.js";

const noodles = {
  id: "peanut-noodles",
  ingredients: [{ food: "peanut butter", qty: 2, unit: "tbsp" }],
};
const rice = { id: "plain-rice", ingredients: [{ food: "rice", qty: 1, unit: "cup" }] };
const allergic = { avoidIngredients: ["peanut"] };
const clean = { avoidIngredients: [] };

test("a missing dish refuses every seat instead of passing it", async () => {
  const out = await screenSeats(undefined, [{ id: "guest-a" }, { id: "housemate-1" }], async () => clean);
  assert.deepEqual(out, {
    "guest-a": ["the dish could not be found"],
    "housemate-1": ["the dish could not be found"],
  });
});

test("seat screen still names the allergy and passes the clean diner", async () => {
  const targets = { "guest-a": allergic, "housemate-1": clean };
  const out = await screenSeats(noodles, [{ id: "guest-a" }, { id: "housemate-1" }], async (id) => targets[id]);
  assert.ok(out["guest-a"].length > 0);
  assert.deepEqual(out["housemate-1"], []);
});

test("an unread profile is refused, not waved on", async () => {
  const out = await screenSeats(rice, [{ id: "guest-a" }], async () => null);
  assert.deepEqual(out["guest-a"], ["their profile could not be read"]);
});

test("occasion screen: a missing dish is never clean", () => {
  const byId = new Map([["plain-rice", rice]]);
  const out = screenOccasion(["plain-rice", "house-0123456789ab"], byId, clean);
  assert.deepEqual(out, { "house-0123456789ab": ["the dish could not be found"] });
});

test("occasion screen: allergen still flagged, duplicates folded", () => {
  const byId = new Map([["peanut-noodles", noodles], ["plain-rice", rice]]);
  const out = screenOccasion(["peanut-noodles", "peanut-noodles", "plain-rice"], byId, allergic);
  assert.deepEqual(Object.keys(out), ["peanut-noodles"]);
});
