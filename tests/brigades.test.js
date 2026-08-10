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

test("THE PICK DOES NOT DEPEND ON THE RUN DAY (Tribunal H2)", () => {
  // The regression this pins: with a used-set the pool was walked relative to
  // the dates THIS run materializes, so a phone generating on Wednesday chose
  // different dinners than one that ran Monday — same deterministic ids, so
  // the merge silently swapped tonight's meal after the cook had shopped.
  const monday = materializeBrigade({ tables: [] }, BRIGADE, ctx()).events;
  const byDate = new Map(monday.tables.map((t) => [t.date, t.recipeId]));
  const wednesday = materializeBrigade({ tables: [] }, BRIGADE, ctx({ today: "2026-07-29" })).events;
  assert.ok(wednesday.tables.length > 0);
  for (const t of wednesday.tables) {
    assert.equal(t.recipeId, byDate.get(t.date), `${t.date} must not depend on the run day`);
  }
  // and the walk still repeats nothing inside one pool's worth of days
  const pool = brigadePool(BANK, [{ id: "mom" }, { id: "laurie" }], "dinner");
  const seq = [...byDate.values()];
  for (let i = 0; i + pool.length <= seq.length; i++) {
    assert.equal(new Set(seq.slice(i, i + pool.length)).size, pool.length, "no repeat in window");
  }
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
    buyerId: "mom",
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
  assert.equal(mondayShops.length, 1, "and the CLAIMED dinner is bought exactly once");
  assert.equal(mondayShops[0].recipeId, "tagine");
});

test("ROTATING COOKS cycle memberIds by calendar day, derived from the date", () => {
  // David 2026-08-01: "each person is responsible for 1-2 dinners." The cook
  // must come from the DATE, never a loop counter, or regenerating mid-week
  // (past days skipped) would silently reassign the remaining nights.
  const rot = { ...BRIGADE, memberIds: ["mom", "laurie", "david"], rotateCooks: true };
  const { events } = materializeBrigade({ tables: [] }, rot, ctx());
  const cooks = events.tables
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => t.cookId);
  assert.deepEqual(cooks, ["mom", "laurie", "david", "mom", "laurie"]);
});

test("rotation is stable when generation happens mid-week", () => {
  // Wednesday's device generates with Mon/Tue already lived: the surviving
  // nights keep the cooks the whole house already agreed to.
  const rot = { ...BRIGADE, memberIds: ["mom", "laurie", "david"], rotateCooks: true };
  const full = materializeBrigade({ tables: [] }, rot, ctx()).events;
  const late = materializeBrigade({ tables: [] }, rot, ctx({ today: "2026-07-29" })).events;
  for (const t of late.tables) {
    const same = full.tables.find((x) => x.id === t.id);
    assert.equal(t.cookId, same.cookId, `${t.date} keeps its cook`);
    // Tribunal H2: the MEAL is as date-stable as the cook. The old used-set
    // walked the pool relative to the run's date list, so a Wednesday device
    // picked different dinners than a Monday one under the SAME table ids
    // and the merge silently swapped a meal the cook had shopped for.
    assert.equal(t.recipeId, same.recipeId, `${t.date} keeps its meal`);
  }
});

test("regenerate onto a CHANGED bank recomputes servings; skips still carry (Tribunal H3)", () => {
  const first = materializeBrigade({ tables: [] }, BRIGADE, ctx()).events;
  // hand-edit mom's servings and skip laurie on the first night
  const night = first.tables.slice().sort((a, b) => a.date.localeCompare(b.date))[0];
  night.seats = night.seats.map((s) =>
    s.id === "mom" ? { ...s, servings: 1.25 } : { ...s, status: "skipped" },
  );
  // the bank changes so the re-roll lands a DIFFERENT recipe on that night
  const fatDish = recipe("zz-massive-lasagna", 1800);
  const bank = new Map([["zz-massive-lasagna", fatDish]]);
  const re = materializeBrigade(first, BRIGADE, ctx({ bankById: bank, regenerate: true })).events;
  const reNight = re.tables.find((t) => t.id === night.id);
  assert.equal(reNight.recipeId, "zz-massive-lasagna");
  const mom = reNight.seats.find((s) => s.id === "mom");
  assert.notEqual(mom.servings, 1.25, "1.25 servings of chili is not 1.25 of an 1800-kcal dish");
  assert.equal(
    reNight.seats.find((s) => s.id === "laurie").status,
    "skipped",
    "the Laurie lesson: a skip is a decision and always carries",
  );
});

test("a SKIPPED named cook hands the role to the next present seat (David 2026-08-09)", () => {
  // supersedes Tribunal 2026-08-01 M6 ("still cooks and still pays"): in
  // this family SKIP MINE means "I'm not there", and a dinner whose named
  // cook is away must still get cooked by someone who is present
  const table = {
    id: "t1",
    name: "Family dinner",
    date: "2026-07-28",
    slot: "dinner",
    recipeId: "chili",
    cookId: "laurie",
    seats: [
      { id: "mom", servings: 1 },
      { id: "laurie", servings: 1, status: "skipped" },
    ],
  };
  const cook = cookOf(table, "taranowski", PROFILES);
  assert.equal(cook?.id, "mom", "skip = away — the role falls to the first present seat");
  // a present named cook keeps the role, of course
  const present = cookOf(
    { ...table, seats: table.seats.map((s) => ({ ...s, status: undefined })) },
    "taranowski",
    PROFILES,
  );
  assert.equal(present?.id, "laurie");
  // a cookId that is NOT of this house (or not a profile at all) still falls
  // through to the house rule: the named path must not void the cook
  const away = cookOf({ ...table, cookId: "away" }, "taranowski", PROFILES);
  assert.equal(away?.id, "mom", "an out-of-house named cook falls back to the house rule");
  const ghost = cookOf({ ...table, cookId: "nobody" }, "taranowski", PROFILES);
  assert.equal(ghost?.id, "mom", "an unknown cookId falls back too, never null");
});

test("a recipe any member banned outright (avoidRecipes) never reaches the shared pot", () => {
  const members = [{ id: "mom", avoidRecipes: ["chili"] }, { id: "laurie" }];
  const pool = brigadePool(BANK, members, "dinner");
  assert.ok(!pool.some((r) => r.id === "chili"));
  assert.ok(pool.some((r) => r.id === "tagine"), "everything else stays");
});

test("materializeBrigade honors a member's avoidRecipes from their targets", () => {
  const targets = new Map(TARGETS);
  targets.set("mom", { ...TARGETS.get("mom"), avoidRecipes: ["chili", "tagine", "curry"] });
  const { events, thin } = materializeBrigade(
    { tables: [] },
    BRIGADE,
    ctx({ targetsById: targets }),
  );
  // only onion-stew survives her ban list, so the week repeats it and says so
  assert.ok(events.tables.every((t) => t.recipeId === "onion-stew"));
  assert.ok(thin.length > 0, "a one-recipe pool is reported thin, not papered over");
});

test("brigade dinners walk a SCATTERED order, still run-day independent", () => {
  // id-sorted adjacency put near-identical dishes on consecutive nights; the
  // hash-shuffled walk must scatter while two run days still agree exactly
  const rot = { ...BRIGADE, until: "2026-08-02" };
  const a = materializeBrigade({ tables: [] }, rot, ctx()).events;
  const b = materializeBrigade({ tables: [] }, rot, ctx({ today: "2026-07-29" })).events;
  const byDate = new Map(a.tables.map((t) => [t.date, t.recipeId]));
  for (const t of b.tables) assert.equal(t.recipeId, byDate.get(t.date));
  // and consecutive days never repeat while the pool lasts
  const seq = a.tables
    .slice()
    .sort((x, y) => x.date.localeCompare(y.date))
    .map((t) => t.recipeId);
  for (let i = 0; i + 1 < seq.length; i++) {
    assert.notEqual(seq[i], seq[i + 1], "no same dinner two nights running");
  }
});

test("deriveTables exposes EVERY table's batch (allCookExtras), mine stays cook-only", () => {
  // the "one shopper buys all the family dinners" trip needs every night's
  // batch with its cook, not just the viewer's own nights
  const rot = { ...BRIGADE, memberIds: ["mom", "laurie", "david"], rotateCooks: true };
  const { events } = materializeBrigade({ tables: [] }, rot, ctx());
  const d = deriveTables([{ house: "taranowski", events }], {
    profileId: "mom",
    bankById: BANK,
    ownEntries: [],
    today: TODAY,
    profilesById: PROFILES,
  });
  assert.equal(d.allCookExtras.length, WEEK.length, "every night has a batch");
  const cooks = new Set(d.allCookExtras.map((x) => x.cookId));
  assert.ok(cooks.has("mom") && cooks.has("laurie") && cooks.has("david"));
  for (const x of d.allCookExtras) assert.ok(x.servings > 0 && x.recipeId && x.date);
  // CLAIMS model: with no buyerId anywhere, NOBODY's list carries a batch —
  // not even the cook's (David 2026-08-03: "you don't know who will buy it")
  assert.deepEqual(d.cookExtras, []);
  // claiming two nights puts exactly those two on the claimant's list
  const claimed = {
    ...events,
    tables: events.tables.map((t, i) => (i < 2 ? { ...t, buyerId: "mom" } : t)),
  };
  const d2 = deriveTables([{ house: "taranowski", events: claimed }], {
    profileId: "mom",
    bankById: BANK,
    ownEntries: [],
    today: TODAY,
    profilesById: PROFILES,
  });
  assert.equal(d2.cookExtras.length, 2, "exactly the claimed nights ride mom's list");
});

test("a grocery claim survives brigade regeneration, like a skip does", () => {
  const first = materializeBrigade({ tables: [] }, BRIGADE, ctx()).events;
  const night = first.tables.slice().sort((a, b) => a.date.localeCompare(b.date))[0];
  night.buyerId = "laurie";
  const re = materializeBrigade(first, BRIGADE, ctx({ regenerate: true })).events;
  assert.equal(
    re.tables.find((t) => t.id === night.id).buyerId,
    "laurie",
    "\"I'm buying Wednesday\" is a decision, not a detail to rebuild away",
  );
});
