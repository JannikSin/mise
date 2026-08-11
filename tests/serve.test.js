// The serve step's model (per-person-plates-design §7, deploy 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServe, panFraction } from "../app/lib/serve.js";
import { softAvoidMatches, expandAvoidTerms } from "../app/lib/plan.js";

const RECIPE = {
  id: "kofta",
  name: "Kofta",
  servings: 3,
  ingredients: [
    { food: "ground beef", qty: 600, unit: "g" },
    { food: "red onion", qty: 0.5, unit: "unit", optional: true },
    { food: "rice", qty: 2, unit: "cup" },
  ],
  nutrition: { calories: 842, protein: 45 },
};

const PROFILES = [
  { id: "a", name: "Ann" },
  { id: "b", name: "Ben" },
  { id: "c", name: "Cal" },
];

/** @param {Partial<import("../app/lib/tables.js").TableEvent>} t */
const table = (t) => /** @type {import("../app/lib/tables.js").TableEvent} */ ({
  id: "t1",
  name: "dinner",
  date: "2026-08-12",
  slot: "dinner",
  recipeId: "kofta",
  seats: [],
  ...t,
});

test("mass share: every non-skipped seat gets a fraction, profiles.json order", () => {
  const t = table({
    seats: [
      { id: "c", servings: 1 },
      { id: "a", servings: 2 },
      { id: "b", servings: 1 },
    ],
  });
  const m = buildServe(t, RECIPE, PROFILES, {});
  assert.deepEqual(
    m.rows.map((r) => r.id),
    ["a", "b", "c"],
    "seat order comes from profiles.json, never the merge-unstable seats array",
  );
  assert.equal(m.rows[0].fraction, "about half the pan");
  assert.equal(m.rows[1].fraction, "about a quarter of the pan");
  assert.ok(m.rows.every((r) => r.kind === "plate"));
});

test("a PRE-BUY skip is out of the pot and off the screen", () => {
  // nobody has claimed the buy, so the skipped seat's food is never bought
  const t = table({
    seats: [
      { id: "a", servings: 2 },
      { id: "b", servings: 2, status: "skipped" },
    ],
  });
  const m = buildServe(t, RECIPE, PROFILES, {});
  assert.deepEqual(
    m.rows.map((r) => r.id),
    ["a"],
  );
  assert.equal(m.rows[0].fraction, "the whole pan");
});

test("a POST-BUY skip stays in the denominator and renders SET ASIDE (§7.1)", () => {
  // buyerId set = the food is in the pan. Dropping the seat now would
  // regrow everyone else's share ~33%: the B1 over-plate, priced out twice.
  const t = table({
    buyerId: "a",
    seats: [
      { id: "a", servings: 1 },
      { id: "b", servings: 1 },
      { id: "c", servings: 1, status: "skipped" },
    ],
  });
  const m = buildServe(t, RECIPE, PROFILES, {});
  const cal = m.rows.find((r) => r.id === "c");
  assert.equal(cal?.kind, "aside");
  assert.equal(cal?.fraction, "about a third of the pan", "their third is still real food");
  assert.equal(
    m.rows.find((r) => r.id === "a")?.fraction,
    "about a third of the pan",
    "nobody else's share regrew",
  );
});

test("a hard-conflicted seat STAYS IN the denominator and renders SET ASIDE", () => {
  // §5.5 / loop-2 B1: their food is in the pan; shrinking the denominator
  // over-plates everyone else. Eligibility only changes the RENDERING.
  const t = table({
    seats: [
      { id: "a", servings: 1 },
      { id: "b", servings: 1 },
    ],
  });
  const m = buildServe(t, RECIPE, PROFILES, {
    b: { avoidIngredients: ["beef"] },
  });
  const ben = m.rows.find((r) => r.id === "b");
  assert.ok(ben);
  assert.equal(ben.kind, "aside", "never a plate instruction for a conflicted seat");
  assert.equal(ben.fraction, "about half the pan", "still half the pot — it was bought for them");
  const ann = m.rows.find((r) => r.id === "a");
  assert.equal(ann?.fraction, "about half the pan", "denominator unchanged by the conflict");
});

test("an optional avoided row is the SOFT tier: plate line with a named note", () => {
  // §8.2: optional rows never unseat (hard screen skips them), but the cook
  // must be told — an optional red-onion garnish must not be silently plated
  // to the person avoiding onion.
  const t = table({
    seats: [
      { id: "a", servings: 1 },
      { id: "b", servings: 1 },
    ],
  });
  const m = buildServe(t, RECIPE, PROFILES, {
    b: { avoidIngredients: ["onion"] },
  });
  const ben = m.rows.find((r) => r.id === "b");
  assert.equal(ben?.kind, "plate");
  assert.equal(ben?.note, "no red onion");
});

test("family synonyms reach the soft tier only", () => {
  // "onion" on the avoid list must flag a leek row as a note — and must NOT
  // change the hard screen (that would shrink every recipe pool in the app)
  const leeky = {
    ...RECIPE,
    ingredients: [{ food: "leek", qty: 1, unit: "unit" }],
  };
  assert.deepEqual(softAvoidMatches(leeky, ["onion"]), ["leek"]);
  assert.ok(expandAvoidTerms(["onion"]).includes("chive"));
  // non-avoided seats see nothing
  assert.deepEqual(softAvoidMatches(leeky, ["peanut"]), []);
});

test("unreadable rules degrade to a plain plate line, never a guess", () => {
  const t = table({ seats: [{ id: "a", servings: 1 }] });
  const m = buildServe(t, RECIPE, PROFILES, { a: null });
  assert.equal(m.rows[0].kind, "plate");
  assert.equal(m.rows[0].note, undefined);
});

test("panFraction speaks kitchen, never decimals", () => {
  assert.equal(panFraction(0.5), "about half the pan");
  assert.equal(panFraction(0.33), "about a third of the pan");
  assert.equal(panFraction(0.26), "about a quarter of the pan");
  assert.equal(panFraction(1), "the whole pan");
  assert.equal(panFraction(0), "");
  assert.equal(panFraction(NaN), "");
});

test("cook sequencing notes ride along; no numbers are invented", () => {
  const t = table({
    seats: [{ id: "a", servings: 1 }],
    tailor: { at: "2026-08-10", seats: {}, cook: ["hold the bread back"] },
  });
  const m = buildServe(t, RECIPE, PROFILES, {});
  assert.deepEqual(m.cookNotes, ["hold the bread back"]);
});

// SOLVED plate lines (spec §7.3): grams to nearest 25, cups in quarters,
// veg as words, flavor silent, layout unchanged (same rows, extra lines).
test("solved synth renders per-seat lines: grams/quarter-cups/veg words, flavor silent", () => {
  const t = table({
    seats: [
      { id: "a", servings: 1 },
      { id: "b", servings: 1 },
    ],
  });
  const synth = {
    synthMode: "solved",
    rows: [
      { food: "ground beef", unit: "g", part: "protein", perSeat: { a: 262, b: 138 } },
      { food: "rice", unit: "cup", part: "carbfat", perSeat: { a: 0.62, b: 1.4 } },
      { food: "red onion", unit: "unit", part: "veg", perSeat: { a: 0.25, b: 0.25 } },
    ],
    bySeat: {
      a: { synthMode: "solved", topUp: { food: "egg", grams: 100 } },
      b: { synthMode: "solved" },
    },
  };
  const m = buildServe(t, RECIPE, PROFILES, {}, synth);
  const a = m.rows.find((r) => r.id === "a");
  const b = m.rows.find((r) => r.id === "b");
  assert.deepEqual(a.lines, ["250 g ground beef", "1/2 cup rice", "with red onion", "100 g egg on the side"]);
  assert.deepEqual(b.lines, ["150 g ground beef", "1 1/2 cups rice", "with red onion"]);
  assert.ok(a.fraction, "the mass-share fraction survives as the fallback field");
  assert.ok(!JSON.stringify(m).includes("protein\":"), "no macros on the serve screen");
});

test("uniform synth changes NOTHING on the serve screen (inert-deploy guarantee)", () => {
  const t = table({
    seats: [
      { id: "a", servings: 2 },
      { id: "b", servings: 1 },
    ],
  });
  const without = buildServe(t, RECIPE, PROFILES, {});
  const withUniform = buildServe(t, RECIPE, PROFILES, {}, { synthMode: "uniform", rows: null, bySeat: {} });
  assert.deepEqual(withUniform, without);
});
