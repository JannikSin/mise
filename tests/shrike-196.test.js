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

test("item 15: a plain SET applies a grown breakfast list to unbought breakfasts and leaves dinners alone", async () => {
  const { planBrigadeWeek } = await import("../app/lib/compose.js");
  const { sundayTwoPotsOn } = await import("../app/lib/tables.js");
  const r = (id, mealType, food, extra = {}) => ({
    id,
    name: id,
    mealType,
    servings: 1,
    safeDays: 4,
    tags: ["batch-friendly"],
    nutrition: { calories: mealType === "dinner" ? 700 : 450, protein: 35 },
    ingredients: [{ qty: 200, unit: "g", food }],
    ...extra,
  });
  const bank = new Map(
    [
      r("oats-a", "breakfast", "rolled oats"),
      r("oats-b", "breakfast", "steel cut oats"),
      r("beef-bowl", "dinner", "ground beef"),
      r("turkey-bowl", "dinner", "ground turkey"),
      r("chicken-strips", "dinner", "chicken breast", { ingredients: [{ qty: 200, unit: "g", food: "chicken breast", note: "sliced thin" }] }),
      r("pork-bowl", "dinner", "ground pork"),
    ].map((x) => [x.id, x]),
  );
  const PROFILES = new Map([["david", { id: "david", household: "wayne" }], ["elliot", { id: "elliot", household: "wayne" }]]);
  const TARGETS = new Map([
    ["david", { macros: { calories: 3000, protein: 180 }, mealSlots: ["breakfast", "dinner"] }],
    ["elliot", { macros: { calories: 2400 }, mealSlots: ["breakfast", "dinner"] }],
  ]);
  const WEEK = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"];
  const rule = {
    id: "k",
    name: "K",
    memberIds: ["david", "elliot"],
    slots: ["breakfast", "dinner"],
    cookId: "david",
    from: "2026-10-13",
    until: "2026-11-09",
    cookDays: [0, 5, 6],
    dinnerMeat: true,
    slotRecipes: { breakfast: ["oats-a"] },
  };
  const asPlanned = (b) => ({ ...b, sundayBatch: true, sundayTwoPots: sundayTwoPotsOn(b) });
  const ctx = (o = {}) => ({
    dates: WEEK,
    today: "2026-11-02",
    calendarToday: "2026-11-02",
    house: "wayne",
    profilesById: PROFILES,
    targetsById: TARGETS,
    plansById: new Map(),
    bankById: bank,
    keepSet: true,
    bought: () => false,
    ...o,
  });
  const first = planBrigadeWeek({ tables: [] }, asPlanned(rule), ctx({ today: "2026-11-01", calendarToday: "2026-11-01" }));
  const of = (events, slot) =>
    events.tables.filter((t) => t.slot === slot).sort((a, b) => a.date.localeCompare(b.date)).map((t) => `${t.date}:${t.recipeId}`);
  assert.ok(of(first.events, "breakfast").every((x) => x.endsWith("oats-a")));
  const grown = { ...rule, slotRecipes: { breakfast: ["oats-a", "oats-b"] } };
  const again = planBrigadeWeek(first.events, asPlanned(grown), ctx());
  const bks = of(again.events, "breakfast").filter((x) => x >= "2026-11-02");
  assert.ok(bks.some((x) => x.endsWith("oats-b")), bks.join(" "));
  assert.deepEqual(of(again.events, "dinner"), of(first.events, "dinner"), "dinners are not re-rolled");
  // the same list again changes nothing more: no churn on a second SET
  const third = planBrigadeWeek(again.events, asPlanned(grown), ctx());
  assert.deepEqual(of(third.events, "breakfast"), of(again.events, "breakfast"));
  // a bought breakfast is kept even when the list grew
  const keepBought = planBrigadeWeek(first.events, asPlanned(grown), ctx({ bought: () => true }));
  assert.deepEqual(of(keepBought.events, "breakfast"), of(first.events, "breakfast"));
});
