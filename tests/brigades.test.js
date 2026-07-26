import test from "node:test";
import assert from "node:assert/strict";
import {
  validBrigade,
  brigadePool,
  seatServingsFor,
  materializeBrigade,
  brigadeTableId,
  addBrigade,
  removeBrigade,
  deriveTables,
  cookOf,
} from "../app/lib/tables.js";

// A brigade is a STANDING table: two or more people in ONE house eating the
// same meals at their own portions. It is built as a table factory, so these
// tests mostly pin the things that would silently corrupt shared state.

const recipe = (id, calories, extra = {}) => ({
  id,
  name: id,
  mealType: "dinner",
  servings: 1,
  nutrition: { calories, protein: 30 },
  ingredients: [{ qty: 1, unit: "x", food: "lentils" }],
  ...extra,
});

const ONION = {
  ...recipe("onion-stew", 500),
  ingredients: [{ qty: 1, unit: "x", food: "onion" }],
};

const BANK = new Map(
  [recipe("chili", 500), recipe("tagine", 600), recipe("curry", 550), ONION].map((r) => [r.id, r]),
);

const PROFILES = new Map([
  ["mom", { id: "mom", household: "taranowski" }],
  ["laurie", { id: "laurie", household: "taranowski" }],
  ["david", { id: "david", household: "taranowski" }],
  ["away", { id: "away", household: "elsewhere" }],
]);

const TARGETS = new Map([
  ["mom", { macros: { calories: 1800 }, mealSlots: ["breakfast", "lunch", "dinner"] }],
  ["laurie", { macros: { calories: 2000 }, mealSlots: ["breakfast", "lunch", "dinner"] }],
  ["david", { macros: { calories: 3700 }, mealSlots: ["breakfast", "lunch", "dinner"] }],
  ["away", { macros: { calories: 2000 }, mealSlots: ["breakfast", "lunch", "dinner"] }],
]);

const BRIGADE = {
  id: "b1",
  name: "Mom + Laurie",
  memberIds: ["mom", "laurie"],
  slots: ["dinner"],
  cookId: "mom",
  from: "2026-07-27",
  until: "2026-08-02",
};

const WEEK = ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"];
const TODAY = "2026-07-27";

const ctx = (over = {}) => ({
  dates: WEEK,
  today: TODAY,
  house: "taranowski",
  profilesById: PROFILES,
  targetsById: TARGETS,
  bankById: BANK,
  ...over,
});

test("validBrigade requires an end date and a bounded span", () => {
  assert.ok(validBrigade(BRIGADE));
  assert.equal(validBrigade({ ...BRIGADE, until: undefined }), false, "open-ended is refused");
  assert.equal(
    validBrigade({ ...BRIGADE, until: "2027-07-27" }),
    false,
    "a year-long brigade would materialize without horizon",
  );
  assert.equal(validBrigade({ ...BRIGADE, until: "2026-07-01" }), false, "until before from");
  assert.equal(
    validBrigade({ ...BRIGADE, memberIds: ["mom"] }),
    false,
    "a brigade needs 2+ people",
  );
  assert.equal(validBrigade({ ...BRIGADE, slots: ["brunch"] }), false, "unknown slot");
  assert.equal(validBrigade({ ...BRIGADE, id: "" }), false, "empty id defeats the entry strip");
});

test("the pool is the INTERSECTION of every member's screen, never the union", () => {
  // Mom avoids onion. A meal she cannot eat must not become the meal everyone
  // eats, which is the whole risk of a shared plan.
  const members = [{ id: "mom", avoid: ["onion"] }, { id: "laurie" }];
  const pool = brigadePool(BANK, members, "dinner");
  assert.ok(
    !pool.some((r) => r.id === "onion-stew"),
    "a recipe one member avoids is out of the shared pool",
  );
  assert.equal(pool.length, 3);
  // and the same pool without her screen would have included it
  assert.ok(
    brigadePool(BANK, [{ id: "laurie" }, { id: "david" }], "dinner").some(
      (r) => r.id === "onion-stew",
    ),
  );
});

test("an unpromoted AI special is never auto-planned into a brigade", () => {
  const bank = new Map([...BANK, ["ai", recipe("ai", 500, { source: "ai-special" })]]);
  const pool = brigadePool(bank, [{ id: "mom" }, { id: "laurie" }], "dinner");
  assert.ok(
    !pool.some((r) => r.id === "ai"),
    "council 2026-07-23: AI at the table, not in the plan",
  );
});

test("same meal, different plates: portions come from each member's own targets", () => {
  const meal = recipe("chili", 500);
  const mom = seatServingsFor(TARGETS.get("mom"), "dinner", meal);
  const david = seatServingsFor(TARGETS.get("david"), "dinner", meal);
  assert.ok(david > mom, `gain-phase David should eat more than Mom (${david} vs ${mom})`);
  assert.ok(mom >= 0.5 && david <= 3, "and both stay inside the clamp");
  assert.equal(mom * 4, Math.round(mom * 4), "servings land on quarters");
  // a member who skips breakfast gets a bigger dinner, not a short day
  const skipper = seatServingsFor(
    { macros: { calories: 1800 }, mealSlots: ["lunch", "dinner"] },
    "dinner",
    meal,
  );
  assert.ok(skipper > mom);
});

test("materialize sets one table per date and slot, seated for every member", () => {
  const { events, made } = materializeBrigade({ tables: [] }, BRIGADE, ctx());
  assert.equal(made, WEEK.length);
  assert.equal(events.tables.length, WEEK.length);
  for (const t of events.tables) {
    assert.equal(t.fromBrigade, "b1");
    assert.equal(t.cookId, "mom");
    assert.deepEqual(
      t.seats.map((s) => s.id),
      ["mom", "laurie"],
    );
  }
});

test("IDS ARE DETERMINISTIC, so two phones generating offline cannot double-shop", () => {
  // The failure this prevents: Mom taps GENERATE in the car, David taps it two
  // minutes later, neither device has seen the other. With random ids nothing
  // collides on the id-keyed merge and the cook buys every dinner twice.
  const a = materializeBrigade({ tables: [] }, BRIGADE, ctx()).events;
  const b = materializeBrigade({ tables: [] }, BRIGADE, ctx()).events;
  assert.deepEqual(
    a.tables.map((t) => t.id),
    b.tables.map((t) => t.id),
  );
  assert.deepEqual(
    a.tables.map((t) => t.recipeId),
    b.tables.map((t) => t.recipeId),
    "and the same meal is picked, not just the same id",
  );
  assert.equal(a.tables[0].id, brigadeTableId("b1", "2026-07-27", "dinner"));
});

test("materialize is idempotent: running it again changes nothing", () => {
  const first = materializeBrigade({ tables: [] }, BRIGADE, ctx()).events;
  const second = materializeBrigade(first, BRIGADE, ctx());
  assert.equal(second.made, 0);
  assert.deepEqual(second.events.tables, first.tables);
});

test("REGENERATION CARRIES SEATS FORWARD, so a decline is never reversed", () => {
  // Laurie says she is out on Wednesday. David re-rolls on Tuesday. If the
  // rebuild recreated seats from scratch her skip would vanish and the cook
  // would shop and cook a portion nobody eats. That is the Laurie lesson.
  const built = materializeBrigade({ tables: [] }, BRIGADE, ctx()).events;
  const target = built.tables[1];
  const withSkip = {
    ...built,
    tables: built.tables.map((t) =>
      t.id === target.id
        ? {
            ...t,
            seats: t.seats.map((s) =>
              s.id === "laurie" ? { ...s, status: "skipped", servings: 2 } : s,
            ),
          }
        : t,
    ),
  };
  const again = materializeBrigade(withSkip, BRIGADE, ctx({ regenerate: true })).events;
  const after = again.tables.find((t) => t.id === target.id);
  const laurie = after.seats.find((s) => s.id === "laurie");
  assert.equal(laurie.status, "skipped", "the skip survives a re-roll");
  assert.equal(laurie.servings, 2, "and so does her edited portion");
});

test("already-lived days are never touched", () => {
  const mid = "2026-07-29";
  const { events } = materializeBrigade({ tables: [] }, BRIGADE, ctx({ today: mid }));
  assert.deepEqual(
    events.tables.map((t) => t.date),
    ["2026-07-29", "2026-07-30", "2026-07-31"],
  );
});

test("ONE HOUSE: a member who moved out stops being planned for", () => {
  // Laurie goes back to her own apartment after the visit. Her seat has to
  // stop riding the cook's shopping list, checked at materialize time rather
  // than trusted from when the brigade was created.
  const moved = new Map([...PROFILES, ["laurie", { id: "laurie", household: "laurie-apt" }]]);
  const { events, made } = materializeBrigade(
    { tables: [] },
    BRIGADE,
    ctx({ profilesById: moved }),
  );
  assert.equal(made, 0, "a brigade of one is not a brigade");
  assert.equal(events.tables.length, 0);

  // with a third member still in the house it keeps running, minus her
  const three = { ...BRIGADE, memberIds: ["mom", "laurie", "david"] };
  const still = materializeBrigade({ tables: [] }, three, ctx({ profilesById: moved })).events;
  assert.deepEqual(
    still.tables[0].seats.map((s) => s.id),
    ["mom", "david"],
  );
});

test("a thin pool is reported out loud, never silently repeated", () => {
  const tiny = new Map([["chili", recipe("chili", 500)]]);
  const { thin, events } = materializeBrigade({ tables: [] }, BRIGADE, ctx({ bankById: tiny }));
  assert.deepEqual(thin, [{ slot: "dinner", available: 1 }]);
  assert.equal(events.tables.length, WEEK.length, "the week still fills, honestly repeating");
});

test("a pool of zero makes nothing at all", () => {
  const members = new Map([...TARGETS]);
  members.set("mom", { ...TARGETS.get("mom"), avoidIngredients: ["lentils", "onion"] });
  const { events, thin } = materializeBrigade(
    { tables: [] },
    BRIGADE,
    ctx({ targetsById: members }),
  );
  assert.equal(events.tables.length, 0);
  assert.deepEqual(thin, [{ slot: "dinner", available: 0 }]);
});

test("addBrigade refuses an invalid one; removeBrigade cleans up its future meals", () => {
  const empty = { tables: [] };
  assert.deepEqual(
    addBrigade(
      empty,
      {
        name: "bad",
        memberIds: ["mom"],
        slots: ["dinner"],
        from: "2026-07-27",
        until: "2026-08-02",
      },
      TODAY,
    ),
    empty,
  );

  const withB = addBrigade(empty, { ...BRIGADE, id: undefined }, TODAY);
  assert.equal(withB.brigades.length, 1);
  const id = withB.brigades[0].id;

  const built = materializeBrigade(withB, { ...withB.brigades[0] }, ctx()).events;
  // a past meal from this brigade, which the money ledger is entitled to keep
  const past = {
    ...built,
    tables: [...built.tables, { ...built.tables[0], id: "old", date: "2026-07-20" }],
  };
  const gone = removeBrigade(past, id, TODAY);
  assert.equal(gone.brigades.length, 0);
  assert.equal(gone.tables.filter((t) => t.date >= TODAY).length, 0, "future meals go");
  assert.ok(
    gone.tables.some((t) => t.id === "old"),
    "the meal already eaten stays, the ledger owns it",
  );
});

test("an explicit cookId decides who shops, not seat array order", () => {
  const t = {
    id: "x",
    name: "n",
    date: "2026-07-27",
    slot: "dinner",
    recipeId: "chili",
    cookId: "laurie",
    seats: [
      { id: "mom", servings: 1 },
      { id: "laurie", servings: 1 },
    ],
  };
  assert.equal(cookOf(t, "taranowski", PROFILES)?.id, "laurie");
  // no cookId: the original first-seat rule still applies
  assert.equal(cookOf({ ...t, cookId: undefined }, "taranowski", PROFILES)?.id, "mom");
  // a cookId naming someone who is not seated falls back rather than voiding
  assert.equal(cookOf({ ...t, cookId: "ghost" }, "taranowski", PROFILES)?.id, "mom");
});

test("A HAND-SET TABLE BEATS THE BRIGADE'S, and the cook shops the meal once", () => {
  // David sets a family dinner on a night Mom and Laurie's brigade also runs.
  // Setting one by hand is how you say "not the usual tonight": it must win,
  // and the cook must not end up buying both.
  const built = materializeBrigade({ tables: [] }, BRIGADE, ctx()).events;
  const handSet = {
    id: "family-1",
    name: "Family dinner",
    date: "2026-07-27",
    slot: "dinner",
    recipeId: "tagine",
    cookId: "mom",
    seats: [
      { id: "mom", servings: 1 },
      { id: "laurie", servings: 1 },
    ],
  };
  const events = { ...built, tables: [...built.tables, handSet] };

  const out = deriveTables([{ house: "taranowski", events }], {
    profileId: "mom",
    bankById: BANK,
    ownEntries: [],
    today: TODAY,
    profilesById: PROFILES,
  });

  const monday = out.entries.filter((e) => e.date === "2026-07-27");
  assert.equal(monday.length, 1, "one meal, one pin");
  assert.equal(monday[0].table, "family-1", "the hand-set table wins the slot");

  const mondayShops = out.cookExtras.filter((e) => e.date === "2026-07-27");
  assert.equal(mondayShops.length, 1, "and the cook buys that dinner exactly once");
  assert.equal(mondayShops[0].recipeId, "tagine");
});
