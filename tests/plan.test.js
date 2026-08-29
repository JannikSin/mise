import test from "node:test";
import assert from "node:assert/strict";
import {
  datesOfWeek,
  shiftWeek,
  addEntry,
  removeEntryById,
  moveEntry,
  normalizePlan,
  entriesAt,
  dayTotals,
  togglePinById,
  toggleSlotOut,
  outEntryAt,
  slotMacroEstimate,
  buffetMacroEstimate,
  cycleSlotAway,
  currencyUsed,
  OUT_TEXT,
  SWIPE_TEXT,
  setPlanLocked,
  setPlanShopped,
  saveFallback,
  restoreFallback,
  recordCook,
  setCookComment,
  toggleEntryCooked,
  mergeRecipePool,
  dietOf,
  prepSundayOf,
  recipeGated,
  unlockRecipe,
  switchCandidate,
  setEntryRecipe,
 planSwipes,
  weekRunSwipes,
  dailyCovered,
  leanWeekMenu,
  toggleSwipeEaten,
  currencyEaten } from "../app/lib/plan.js";

test("prepSundayOf is the day before the week's Monday", () => {
  assert.equal(prepSundayOf("2026-W30"), "2026-07-19");
  assert.equal(prepSundayOf("2026-W01"), "2025-12-28");
  assert.equal(prepSundayOf("nonsense"), "");
});

test("toggleSlotOut replaces the slot's entries with one pinned eating-out placeholder", () => {
  let plan = { week: "2026-W28", entries: [] };
  plan = addEntry(plan, "2026-07-06", "dinner", { recipeId: "beef", servings: 1 });
  plan = addEntry(plan, "2026-07-06", "dinner", { recipeId: "congee", servings: 1 });
  plan = addEntry(plan, "2026-07-06", "lunch", { recipeId: "lunchbox", servings: 1 });

  const out = toggleSlotOut(plan, "2026-07-06", "dinner");
  const dinner = entriesAt(out.entries, "2026-07-06", "dinner");
  assert.equal(dinner.length, 1);
  assert.equal(dinner[0].freeText, OUT_TEXT);
  assert.equal(dinner[0].pinned, true);
  assert.equal(dinner[0].out, true);
  assert.equal(dinner[0].recipeId, undefined);
  // other slots untouched
  assert.equal(entriesAt(out.entries, "2026-07-06", "lunch").length, 1);
  // outEntryAt finds it, and only it
  assert.equal(outEntryAt(out.entries, "2026-07-06", "dinner")?.id, dinner[0].id);
  assert.equal(outEntryAt(out.entries, "2026-07-06", "lunch"), undefined);
  // original plan not mutated
  assert.equal(entriesAt(plan.entries, "2026-07-06", "dinner").length, 2);
});

test("toggleSlotOut a second time removes the placeholder and leaves the slot empty", () => {
  let plan = { week: "2026-W28", entries: [] };
  plan = toggleSlotOut(plan, "2026-07-06", "dinner");
  const back = toggleSlotOut(plan, "2026-07-06", "dinner");
  assert.equal(entriesAt(back.entries, "2026-07-06", "dinner").length, 0);
});

test("slotMacroEstimate credits the slot's pool average with the 0.85 undershoot", () => {
  const recipes = [
    { id: "a", mealType: "dinner", nutrition: { calories: 800, protein: 50 } },
    { id: "b", mealType: "dinner", nutrition: { calories: 600, protein: 30 } },
    { id: "c", mealType: "lunch", nutrition: { calories: 999, protein: 99 } },
  ];
  const est = slotMacroEstimate(recipes, "dinner");
  // avg 700 kcal x 0.85 = 595 (rounded to 5), avg 40g x 0.85 = 34
  assert.equal(est.estCalories, 595);
  assert.equal(est.estProtein, 34);
  // empty pool falls back to the fixed table, never 0
  assert.ok(slotMacroEstimate([], "dinner").estCalories > 0);
});

test("toggleSlotOut carries the estimate and dayTotals counts it", () => {
  let plan = { week: "2026-W28", entries: [] };
  plan = addEntry(plan, "2026-07-06", "lunch", { recipeId: "lunchbox", servings: 1 });
  plan = toggleSlotOut(plan, "2026-07-06", "dinner", { estCalories: 595, estProtein: 34 });
  const out = outEntryAt(plan.entries, "2026-07-06", "dinner");
  assert.equal(out?.estCalories, 595);
  const byId = new Map([["lunchbox", { nutrition: { calories: 800, protein: 60 } }]]);
  const totals = dayTotals(plan.entries, byId, "2026-07-06");
  assert.equal(totals.calories, 800 + 595);
  assert.equal(totals.protein, 60 + 34);
});

test("toggleSlotOut off-path clears merge-twin placeholders in one tap", () => {
  // two devices marked the same slot out, then merged: twin placeholders
  // with distinct ids — one off-toggle must remove BOTH, or the slot stays
  // stuck reading "out"
  let plan = { week: "2026-W28", entries: [] };
  plan = toggleSlotOut(plan, "2026-07-06", "dinner");
  const twin = { ...plan.entries[0], id: "twin-from-merge" };
  plan = { ...plan, entries: [...plan.entries, twin] };
  const back = toggleSlotOut(plan, "2026-07-06", "dinner");
  assert.equal(entriesAt(back.entries, "2026-07-06", "dinner").length, 0);
});

test("shiftWeek moves across plain and year-boundary weeks", () => {
  assert.equal(shiftWeek("2026-W28", 1), "2026-W29");
  assert.equal(shiftWeek("2026-W28", -1), "2026-W27");
  assert.equal(shiftWeek("2026-W01", -1), "2025-W52");
  assert.equal(shiftWeek("2026-W53", 1), "2027-W01");
});

test("datesOfWeek returns Monday-Sunday ISO dates for an ISO week id", () => {
  assert.deepEqual(datesOfWeek("2026-W28"), [
    "2026-07-06",
    "2026-07-07",
    "2026-07-08",
    "2026-07-09",
    "2026-07-10",
    "2026-07-11",
    "2026-07-12",
  ]);
});

test("datesOfWeek handles year-boundary weeks", () => {
  assert.equal(datesOfWeek("2026-W01")[0], "2025-12-29");
  assert.equal(datesOfWeek("2026-W53")[6], "2027-01-03");
});

test("addEntry appends with a generated unique id and does not mutate", () => {
  const plan = { week: "2026-W28", entries: [] };
  const next = addEntry(plan, "2026-07-06", "dinner", { recipeId: "beef", servings: 1 });
  assert.equal(next.entries.length, 1);
  assert.equal(typeof next.entries[0].id, "string");
  assert.ok(next.entries[0].id.length >= 6);
  assert.equal(next.entries[0].recipeId, "beef");
  assert.deepEqual(plan.entries, []);
});

test("addEntry stacks multiple entries in the SAME date+slot", () => {
  let plan = { week: "2026-W28", entries: [] };
  plan = addEntry(plan, "2026-07-06", "dinner", { recipeId: "beef", servings: 1 });
  plan = addEntry(plan, "2026-07-06", "dinner", { recipeId: "congee", servings: 1 });
  const stacked = entriesAt(plan.entries, "2026-07-06", "dinner");
  assert.equal(stacked.length, 2);
  assert.notEqual(plan.entries[0].id, plan.entries[1].id);
});

test("removeEntryById removes exactly one entry", () => {
  let plan = { week: "2026-W28", entries: [] };
  plan = addEntry(plan, "2026-07-06", "dinner", { recipeId: "beef", servings: 1 });
  plan = addEntry(plan, "2026-07-06", "dinner", { recipeId: "congee", servings: 1 });
  const next = removeEntryById(plan, plan.entries[0].id);
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].recipeId, "congee");
});

test("moveEntry reassigns date+slot, keeping id and content", () => {
  let plan = { week: "2026-W28", entries: [] };
  plan = addEntry(plan, "2026-07-06", "dinner", { recipeId: "beef", servings: 2 });
  const id = plan.entries[0].id;
  const next = moveEntry(plan, id, "2026-07-07", "lunch");
  assert.deepEqual(next.entries[0], {
    id,
    date: "2026-07-07",
    slot: "lunch",
    recipeId: "beef",
    servings: 2,
  });
});

test("normalizePlan preserves locked across a read-refresh (regression: was silently dropped)", () => {
  const raw = { week: "2026-W28", locked: true, entries: [] };
  assert.equal(normalizePlan(raw, "2026-W28").locked, true);
  assert.equal(
    normalizePlan({ week: "2026-W28", locked: false, entries: [] }, "2026-W28").locked,
    false,
  );
  assert.equal("locked" in normalizePlan({ week: "2026-W28", entries: [] }, "2026-W28"), false);
});

test("normalizePlan builds an empty plan and assigns ids to legacy entries", () => {
  assert.deepEqual(normalizePlan(null, "2026-W28"), { week: "2026-W28", entries: [] });
  const legacy = {
    week: "2026-W28",
    entries: [{ date: "2026-07-06", slot: "dinner", recipeId: "beef", servings: 1 }],
  };
  const fixed = normalizePlan(legacy, "2026-W28");
  assert.equal(typeof fixed.entries[0].id, "string");
  assert.equal(fixed.entries[0].recipeId, "beef");
});

test("normalizePlan self-heal ids are DETERMINISTIC — two devices agree", () => {
  // if two devices independently normalize the same legacy file, they must
  // produce identical ids, or id-keyed merges duplicate/resurrect entries
  const legacy = {
    week: "2026-W28",
    entries: [
      { date: "2026-07-06", slot: "dinner", recipeId: "beef", servings: 1 },
      { date: "2026-07-06", slot: "dinner", recipeId: "beef", servings: 1 }, // identical twin
      { date: "2026-07-07", slot: "lunch", freeText: "leftovers", servings: 1 },
    ],
  };
  const a = normalizePlan(structuredClone(legacy), "2026-W28");
  const b = normalizePlan(structuredClone(legacy), "2026-W28");
  assert.deepEqual(
    a.entries.map((e) => e.id),
    b.entries.map((e) => e.id),
  );
  // identical twins in the same slot still get DISTINCT ids
  assert.notEqual(a.entries[0].id, a.entries[1].id);
});

test("togglePinById flips pinned on the matching entry and leaves others untouched", () => {
  let plan = { week: "2026-W28", entries: [] };
  plan = addEntry(plan, "2026-07-06", "dinner", { recipeId: "beef", servings: 1 });
  plan = addEntry(plan, "2026-07-06", "dinner", { recipeId: "congee", servings: 1 });
  const [a, b] = plan.entries;

  const pinned = togglePinById(plan, a.id);
  assert.equal(pinned.entries.find((e) => e.id === a.id)?.pinned, true);
  assert.equal(pinned.entries.find((e) => e.id === b.id)?.pinned, undefined);
  assert.deepEqual(plan.entries, [a, b]); // pure: original untouched

  const unpinned = togglePinById(pinned, a.id);
  assert.equal(unpinned.entries.find((e) => e.id === a.id)?.pinned, false);
});

test("setPlanLocked sets/clears locked without touching entries, and is pure", () => {
  let plan = { week: "2026-W28", entries: [] };
  plan = addEntry(plan, "2026-07-06", "dinner", { recipeId: "beef", servings: 1 });

  const locked = setPlanLocked(plan, true);
  assert.equal(locked.locked, true);
  assert.deepEqual(locked.entries, plan.entries);
  assert.equal(plan.locked, undefined); // pure: original untouched

  const unlocked = setPlanLocked(locked, false);
  assert.equal(unlocked.locked, false);
});

test("mergeRecipePool: untagged bank serves everyone, phases tag filters, own overrides by id", () => {
  const bank = [
    { id: "kofta", nutrition: { calories: 842 } }, // untagged = every profile
    { id: "bulk-bowl", phases: ["gain"] },
    { id: "preload-soup", phases: ["loss", "cut"] },
  ];
  const own = [{ id: "kofta", nutrition: { calories: 480 } }]; // Mom's adjusted variant

  const momPool = mergeRecipePool(bank, own, "loss");
  const momIds = momPool.map((r) => r.id).sort();
  assert.deepEqual(momIds, ["kofta", "preload-soup"]); // bulk-bowl filtered out
  assert.equal(momPool.find((r) => r.id === "kofta")?.nutrition.calories, 480); // override wins

  const davidPool = mergeRecipePool(bank, [], "gain");
  assert.deepEqual(davidPool.map((r) => r.id).sort(), ["bulk-bowl", "kofta"]);

  // no phase known yet (targets still loading): nothing filtered, app stays usable
  assert.equal(mergeRecipePool(bank, [], undefined).length, 3);
});

test("mergeRecipePool: own recipes are never phase-filtered", () => {
  const own = [{ id: "my-treat", phases: ["gain"] }];
  const pool = mergeRecipePool([], own, "loss");
  assert.deepEqual(
    pool.map((r) => r.id),
    ["my-treat"],
  );
});

test("dayTotals sums stacked entries in the same slot", () => {
  const recipes = new Map([
    ["beef", { nutrition: { calories: 900, protein: 61 } }],
    ["snack", { nutrition: { calories: 205, protein: 28 } }],
  ]);
  const entries = [
    { id: "a", date: "2026-07-06", slot: "dinner", recipeId: "beef", servings: 1 },
    { id: "b", date: "2026-07-06", slot: "dinner", recipeId: "snack", servings: 1 },
    { id: "c", date: "2026-07-06", slot: "lunch", freeText: "eating out", servings: 1 },
    { id: "d", date: "2026-07-07", slot: "dinner", recipeId: "beef", servings: 1 },
  ];
  assert.deepEqual(dayTotals(entries, recipes, "2026-07-06"), { calories: 1105, protein: 89 });
});

test("dayTotals counts a described away meal's est fields (P9), bare freeText still 0", () => {
  const recipes = new Map([["beef", { nutrition: { calories: 900, protein: 61 } }]]);
  const entries = [
    { id: "a", date: "2026-07-06", slot: "dinner", recipeId: "beef", servings: 1 },
    // described away meal: real food this person ate, no recipe, est known
    {
      id: "b",
      date: "2026-07-06",
      slot: "lunch",
      freeText: "dining hall tray",
      servings: 1,
      estCalories: 700,
      estProtein: 45,
    },
    // bare freeText with no est stays 0 — nothing honest to count
    { id: "c", date: "2026-07-06", slot: "breakfast", freeText: "tbd", servings: 1 },
  ];
  assert.deepEqual(dayTotals(entries, recipes, "2026-07-06"), { calories: 1600, protein: 106 });
});

test("mergeRecipePool: avoidIngredients screens EVERY recipe, own ones included", () => {
  const bank = [
    { id: "doner", ingredients: [{ food: "red onion" }, { food: "chicken thigh" }] },
    { id: "soup", ingredients: [{ food: "Onion" }, { food: "carrot" }] }, // case-insensitive
    { id: "clean-bowl", ingredients: [{ food: "chicken breast" }, { food: "rice" }] },
  ];
  // A profile's OWN recipes used to skip this screen entirely, on the reasoning
  // that a human authored them for that profile. The exemption followed the
  // DIRECTORY rather than any actual verification, so anything that ever
  // generated a file into profiles/<id>/recipes/ inherited a bypass around the
  // one screen the app calls trust-ending (Tribunal, 2026-08-10). Now a recipe
  // naming an avoided food is dropped whoever wrote it and wherever it lives.
  const own = [{ id: "moms-tagine", ingredients: [{ food: "pearl onion" }] }];
  const pool = mergeRecipePool(bank, own, "loss", ["onion", "shallot"]);
  assert.deepEqual(pool.map((r) => r.id).sort(), ["clean-bowl"]);
  // a CLEAN own recipe still overrides the bank by id, which is the whole
  // point of profile variants — only the unsafe ones are dropped
  const cleanOwn = [{ id: "clean-bowl", ingredients: [{ food: "cod" }], mine: true }];
  const overridden = mergeRecipePool(bank, cleanOwn, "loss", ["onion", "shallot"]);
  assert.equal(overridden.find((r) => r.id === "clean-bowl")?.mine, true);
  // no avoid list = no screening (back-compat)
  assert.equal(mergeRecipePool(bank, [], "loss").length, 3);
});

test("mergeRecipePool: avoid screen skips optional ingredients (gap-analysis fix)", () => {
  const bank = [
    // near-vegan chili whose only dairy is an OPTIONAL yogurt topping — must
    // survive a dairy-free screen (this is the bug the gap analysis flagged)
    {
      id: "plant-chili",
      ingredients: [
        { food: "black beans" },
        { food: "yogurt", optional: true },
        { food: "ground turkey", optional: true },
      ],
    },
    // required cheese: correctly excluded
    { id: "cheesy-bake", ingredients: [{ food: "cheddar cheese" }] },
  ];
  const pool = mergeRecipePool(bank, [], undefined, ["yogurt", "cheese"]);
  assert.deepEqual(
    pool.map((r) => r.id),
    ["plant-chili"],
  );
});

test("dietOf: tag short-circuits, else keyword classes over non-optional ingredients", () => {
  assert.equal(
    dietOf({ tags: ["vegan", "gluten-free"], ingredients: [{ food: "cheese" }] }),
    "vegan",
  );
  assert.equal(dietOf({ ingredients: [{ food: "chicken thigh" }] }), "omnivore");
  assert.equal(dietOf({ ingredients: [{ food: "wild salmon" }, { food: "rice" }] }), "pescatarian");
  assert.equal(
    dietOf({ ingredients: [{ food: "feta cheese" }, { food: "tomato" }] }),
    "vegetarian",
  );
  assert.equal(dietOf({ ingredients: [{ food: "black beans" }, { food: "brown rice" }] }), "vegan");
  // optional meat does not disqualify an otherwise-vegan recipe
  assert.equal(
    dietOf({ ingredients: [{ food: "lentils" }, { food: "ground turkey", optional: true }] }),
    "vegan",
  );
});

test("mergeRecipePool: diet filter removes recipes the profile's diet won't admit", () => {
  const bank = [
    { id: "beef-bowl", ingredients: [{ food: "beef" }] }, // omnivore
    { id: "salmon-bowl", ingredients: [{ food: "salmon" }] }, // pescatarian
    { id: "feta-salad", ingredients: [{ food: "feta cheese" }] }, // vegetarian
    { id: "bean-chili", ingredients: [{ food: "black beans" }] }, // vegan
  ];
  assert.deepEqual(
    mergeRecipePool(bank, [], undefined, [], "vegan")
      .map((r) => r.id)
      .sort(),
    ["bean-chili"],
  );
  assert.deepEqual(
    mergeRecipePool(bank, [], undefined, [], "vegetarian")
      .map((r) => r.id)
      .sort(),
    ["bean-chili", "feta-salad"],
  );
  assert.deepEqual(
    mergeRecipePool(bank, [], undefined, [], "pescatarian")
      .map((r) => r.id)
      .sort(),
    ["bean-chili", "feta-salad", "salmon-bowl"],
  );
  // omnivore (or absent) admits everything
  assert.equal(mergeRecipePool(bank, [], undefined, [], "omnivore").length, 4);
  // and an OWN recipe no longer escapes the diet filter either: a beef bowl in
  // a vegan profile's own folder is exactly the "trust-ending bug" this screen
  // exists to prevent, whoever put the file there (Tribunal, 2026-08-10)
  const own = [{ id: "beef-bowl", ingredients: [{ food: "beef" }] }];
  assert.ok(!mergeRecipePool(bank, own, undefined, [], "vegan").some((r) => r.id === "beef-bowl"));
});

test("pickCommittee: tiredOf foods lose ties softly (penalized but not banned)", async () => {
  const { pickCommittee } = await import("../app/lib/weekbuilder.js");
  const candidates = [
    {
      id: "pasta-bowl",
      cuisine: "italian",
      effort: "cook",
      nutrition: { protein: 20 },
      foodGroups: {},
      ingredients: [{ food: "pasta" }],
    },
    {
      id: "bean-bowl",
      cuisine: "mexican",
      effort: "cook",
      nutrition: { protein: 20 },
      foodGroups: {},
      ingredients: [{ food: "black beans" }],
    },
  ];
  // with pasta in tiredOf, the bean bowl should seed the committee first
  const c = pickCommittee(candidates, { size: 2, tiredOf: ["pasta"] });
  assert.equal(c[0].id, "bean-bowl");
  // without it, the tie breaks the other way is not guaranteed, but the
  // penalty must at least not crash and still return both
  assert.equal(pickCommittee(candidates, { size: 2 }).length, 2);
});

test("pickCommittee: recentRecipeIds rotate the week away from last week's picks", async () => {
  const { pickCommittee } = await import("../app/lib/weekbuilder.js");
  const candidates = [
    {
      id: "last-week-fav",
      cuisine: "korean",
      effort: "cook",
      nutrition: { protein: 30 },
      foodGroups: {},
      ingredients: [{ food: "tofu" }],
    },
    {
      id: "fresh-option",
      cuisine: "mexican",
      effort: "cook",
      nutrition: { protein: 30 },
      foodGroups: {},
      ingredients: [{ food: "black beans" }],
    },
  ];
  // last-week-fav has EQUAL/better protein but was cooked last week -> penalized, fresh seeds first
  const c = pickCommittee(candidates, { size: 2, recentRecipeIds: new Set(["last-week-fav"]) });
  assert.equal(c[0].id, "fresh-option");
  // accepts a plain array too
  const c2 = pickCommittee(candidates, { size: 2, recentRecipeIds: ["last-week-fav"] });
  assert.equal(c2[0].id, "fresh-option");
  // no recent set -> penalty gone, both still returned
  assert.equal(pickCommittee(candidates, { size: 2 }).length, 2);
});

test("normalizePlan preserves buffer across a read-refresh", () => {
  const raw = {
    week: "2026-W28",
    entries: [],
    buffer: { recipeId: "bean-tub", portions: 7 },
  };
  assert.deepEqual(normalizePlan(raw, "2026-W28").buffer, { recipeId: "bean-tub", portions: 7 });
  assert.equal(normalizePlan({ week: "2026-W28", entries: [] }, "2026-W28").buffer, undefined);
});

test("setPlanShopped stamps the week; normalizePlan carries it and cookedAt", () => {
  const plan = setPlanShopped({ week: "2026-W30", entries: [] }, "2026-07-25");
  assert.equal(plan.shoppedAt, "2026-07-25");
  const carried = normalizePlan(
    {
      week: "2026-W30",
      shoppedAt: "2026-07-25",
      entries: [
        { id: "a", date: "2026-07-23", slot: "dinner", servings: 1, cookedAt: "2026-07-23" },
      ],
    },
    "2026-W30",
  );
  assert.equal(carried.shoppedAt, "2026-07-25");
  assert.equal(carried.entries[0].cookedAt, "2026-07-23");
});

test("toggleEntryCooked confirms, and a second tap takes it back", () => {
  const plan = {
    week: "2026-W30",
    entries: [{ id: "a", date: "2026-07-23", slot: "dinner", servings: 1 }],
  };
  const cooked = toggleEntryCooked(plan, "a", "2026-07-23");
  assert.equal(cooked.entries[0].cookedAt, "2026-07-23");
  const undone = toggleEntryCooked(cooked, "a", "2026-07-24");
  assert.ok(!("cookedAt" in undone.entries[0]), "toggle off removes the field");
  assert.equal(plan.entries[0].cookedAt, undefined, "pure: input untouched");
});

test("the recipe gate hides the METHOD, and reads the HOUSE not the person", () => {
  const plan = { week: "2026-W31", entries: [] };
  // no receipt anywhere: the method waits
  assert.equal(recipeGated(plan, "chili"), true);
  // my own receipt opens it
  assert.equal(recipeGated({ ...plan, shoppedAt: "2026-07-27" }, "chili"), false);
  // and so does ANYONE in the house. This is the one that matters: a brigade
  // has one cook and one receipt, so keying the gate to each person's own
  // plan would hide every instruction from the three who never scan anything.
  assert.equal(recipeGated(plan, "chili", true), false);
});

test("the per-meal override opens one recipe without faking a shop", () => {
  const plan = { week: "2026-W31", entries: [] };
  const after = unlockRecipe(plan, "chili");
  assert.equal(recipeGated(after, "chili"), false, "this one opens");
  assert.equal(recipeGated(after, "tagine"), true, "the rest still wait");
  assert.equal(after.shoppedAt, undefined, "and no shop is invented");
  // idempotent, and it survives a normalize round trip
  assert.equal(unlockRecipe(after, "chili"), after);
  assert.deepEqual(normalizePlan(after, "2026-W31").unlocked, ["chili"]);
});

test("a gate with no plan or no recipe never blocks anything", () => {
  assert.equal(recipeGated(null, "chili"), false);
  assert.equal(recipeGated({ week: "2026-W31", entries: [] }, ""), false);
});

test("switchCandidate cycles the same-slot pool in order and wraps", () => {
  const plan = {
    week: "2026-W31",
    entries: [{ id: "e1", date: "2026-07-28", slot: "lunch", recipeId: "b-bowl", servings: 1 }],
  };
  const pool = [
    { id: "a-salad", mealType: "lunch" },
    { id: "b-bowl", mealType: "lunch" },
    { id: "c-wrap", mealType: "lunch" },
    { id: "z-oats", mealType: "breakfast" },
  ];
  // b → c → a → b: predictable, and you can always get back
  assert.equal(switchCandidate(plan, "e1", pool), "c-wrap");
  const atC = setEntryRecipe(plan, "e1", "c-wrap");
  assert.equal(switchCandidate(atC, "e1", pool), "a-salad");
  const atA = setEntryRecipe(atC, "e1", "a-salad");
  assert.equal(switchCandidate(atA, "e1", pool), "b-bowl");
});

test("switchCandidate never offers a meal type from another slot", () => {
  const plan = {
    week: "2026-W31",
    entries: [{ id: "e1", date: "2026-07-28", slot: "lunch", recipeId: "b-bowl", servings: 1 }],
  };
  const pool = [
    { id: "b-bowl", mealType: "lunch" },
    { id: "z-oats", mealType: "breakfast" },
  ];
  // only one lunch exists, so there is nothing to switch to
  assert.equal(switchCandidate(plan, "e1", pool), null);
});

test("switchCandidate skips anything already planned that same day", () => {
  const plan = {
    week: "2026-W31",
    entries: [
      { id: "e1", date: "2026-07-28", slot: "lunch", recipeId: "b-bowl", servings: 1 },
      { id: "e2", date: "2026-07-28", slot: "dinner", recipeId: "c-wrap", servings: 1 },
    ],
  };
  const pool = [
    { id: "a-salad", mealType: "lunch" },
    { id: "b-bowl", mealType: "lunch" },
    { id: "c-wrap", mealType: "lunch" },
  ];
  // c-wrap is dinner today, so switching lunch onto it is not a switch
  assert.equal(switchCandidate(plan, "e1", pool), "a-salad");
});

test("switchCandidate returns null for a free-text or missing entry", () => {
  const plan = {
    week: "2026-W31",
    entries: [{ id: "e1", date: "2026-07-28", slot: "lunch", freeText: "leftovers" }],
  };
  assert.equal(switchCandidate(plan, "e1", [{ id: "a", mealType: "lunch" }]), null);
  assert.equal(switchCandidate(plan, "nope", [{ id: "a", mealType: "lunch" }]), null);
});

test("setEntryRecipe keeps the id, date, slot and servings, and drops cookedAt", () => {
  const plan = {
    week: "2026-W31",
    entries: [
      {
        id: "e1",
        date: "2026-07-28",
        slot: "lunch",
        recipeId: "b-bowl",
        servings: 1.5,
        cookedAt: "2026-07-28",
      },
    ],
  };
  const next = setEntryRecipe(plan, "e1", "c-wrap");
  const e = next.entries[0];
  assert.equal(e.id, "e1");
  assert.equal(e.date, "2026-07-28");
  assert.equal(e.slot, "lunch");
  assert.equal(e.servings, 1.5);
  assert.equal(e.recipeId, "c-wrap");
  // a switched meal is not the meal you cooked
  assert.equal("cookedAt" in e, false);
});

test("mergeRecipePool: avoidRecipes bans by id, own recipes included", () => {
  const bank = [
    { id: "office-lunch-box", ingredients: [] },
    { id: "chana-masala", ingredients: [] },
  ];
  const own = [{ id: "office-lunch-box", ingredients: [] }];
  const pool = mergeRecipePool(bank, own, undefined, undefined, undefined, ["office-lunch-box"]);
  assert.ok(!pool.some((r) => r.id === "office-lunch-box"), "a ban is a ban, own variant included");
  assert.ok(pool.some((r) => r.id === "chana-masala"));
  // and absent = today's behavior exactly
  const open = mergeRecipePool(bank, own, undefined, undefined, undefined);
  assert.ok(open.some((r) => r.id === "office-lunch-box"));
});

// ---- the spend leg (PF.3, 2026-08-19) ---------------------------------------

test("setPlanShopped records the receipt trip total, appending across receipts", () => {
  const p1 = setPlanShopped({ week: "2026-W34", entries: [] }, "2026-08-19", { store: "pay-less", date: "2026-08-19", total: 73.81 });
  assert.equal(p1.shoppedAt, "2026-08-19");
  assert.deepEqual(p1.spend, [{ store: "pay-less", date: "2026-08-19", total: 73.81 }]);
  const p2 = setPlanShopped(p1, "2026-08-21", { store: "marianos", date: "2026-08-21", total: 12.5 });
  assert.equal(p2.spend.length, 2, "a week can hold several receipts");
  const p3 = setPlanShopped(p1, "2026-08-21", null);
  assert.deepEqual(p3.spend, p1.spend, "no spend arg leaves the record alone");
});

// ---- the cook timer (7.10, 2026-08-19) --------------------------------------

test("recordCook marks cooked once, stores the span, never un-cooks", () => {
  const plan = { week: "2026-W34", entries: [{ id: "e1", date: "2026-08-19", slot: "dinner", recipeId: "x" }, { id: "e2", date: "2026-08-19", slot: "lunch", recipeId: "y" }] };
  const p1 = recordCook(plan, "e1", "2026-08-19", 1740);
  assert.equal(p1.entries[0].cookedAt, "2026-08-19");
  assert.equal(p1.entries[0].cookSeconds, 1740);
  assert.equal(p1.entries[1].cookedAt, undefined, "other entries untouched");
  const p2 = recordCook(p1, "e1", "2026-08-20", 900);
  assert.equal(p2.entries[0].cookedAt, "2026-08-19", "a second END never re-dates the cook");
  assert.equal(p2.entries[0].cookSeconds, 900, "but the span refreshes");
  const p3 = recordCook(plan, "e1", "2026-08-19", 0);
  assert.equal(p3.entries[0].cookedAt, "2026-08-19");
  assert.equal(p3.entries[0].cookSeconds, undefined, "a zero-second span records nothing");
});

test("setCookComment sets, trims, caps, and clears", () => {
  const plan = { week: "2026-W34", entries: [{ id: "e1", cookedAt: "2026-08-19" }] };
  const p1 = setCookComment(plan, "e1", "  burned the first batch  ");
  assert.equal(p1.entries[0].cookComment, "burned the first batch");
  const p2 = setCookComment(p1, "e1", "x".repeat(300));
  assert.equal(p2.entries[0].cookComment.length, 200);
  const p3 = setCookComment(p1, "e1", "   ");
  assert.equal(p3.entries[0].cookComment, undefined, "empty clears");
});

// ---- the fluid week (7.2, 2026-08-19) ---------------------------------------

test("saveFallback snapshots the entries; restoreFallback puts them back, cooked stays cooked", () => {
  const plan = { week: "2026-W34", entries: [
    { id: "a", date: "2026-08-20", slot: "dinner", recipeId: "x", servings: 1 },
    { id: "b", date: "2026-08-21", slot: "dinner", recipeId: "y", servings: 1 },
  ] };
  const saved = saveFallback(plan, "2026-08-19");
  assert.equal(saved.fallback.savedAt, "2026-08-19");
  assert.equal(saved.fallback.entries.length, 2);
  // reshape: b swapped to z and cooked, a deleted
  const reshaped = { ...saved, entries: [{ id: "b", date: "2026-08-21", slot: "dinner", recipeId: "z", servings: 1, cookedAt: "2026-08-21" }] };
  const back = restoreFallback(reshaped);
  const bEntry = back.entries.find((e) => e.id === "b");
  assert.equal(bEntry.recipeId, "z", "the cooked meal stays what was actually cooked");
  assert.ok(back.entries.some((e) => e.id === "a"), "the shopped meal returns");
  assert.equal(back.entries.length, 2, "no duplicate for the cooked slot");
  assert.equal(restoreFallback(plan), plan, "no fallback = no-op");
});

test("restoreFallback excludes by ID: a cooked snack's stacked siblings still come back", () => {
  // the top-up stacks up to three DISTINCT snacks in one date+slot; a
  // slot-keyed exclusion dropped the cooked one's uncooked siblings (diff
  // review 2026-08-19)
  const plan = { week: "2026-W34", entries: [
    { id: "s1", date: "2026-08-20", slot: "snack", recipeId: "bites", servings: 1 },
    { id: "s2", date: "2026-08-20", slot: "snack", recipeId: "smoothie", servings: 1 },
    { id: "s3", date: "2026-08-20", slot: "snack", recipeId: "yogurt", servings: 1 },
  ] };
  const saved = saveFallback(plan, "2026-08-19");
  const reshaped = { ...saved, entries: [{ ...plan.entries[0], cookedAt: "2026-08-20" }] };
  const back = restoreFallback(reshaped);
  assert.equal(back.entries.length, 3, "all three snacks survive the restore");
  assert.equal(back.entries.find((e) => e.id === "s1").cookedAt, "2026-08-20");
  assert.ok(back.entries.some((e) => e.id === "s2") && back.entries.some((e) => e.id === "s3"), "the uncooked siblings return");
});

test("normalizePlan passes fallback AND spend through instead of stripping them", () => {
  const raw = { week: "2026-W34", entries: [], fallback: { savedAt: "2026-08-19", entries: [] }, spend: [{ store: "pay-less", date: "2026-08-19", total: 70.12 }] };
  const n = normalizePlan(raw, "2026-W34");
  assert.deepEqual(n.fallback, raw.fallback);
  assert.deepEqual(n.spend, raw.spend, "recorded receipt totals must survive a load");
});

// ---- currencies: the swipe cycle (7.11, 2026-08-19) -------------------------

test("cycleSlotAway: planned -> OUT -> SWIPE (buffet estimates) -> empty", () => {
  let plan = { week: "2026-W34", entries: [] };
  plan = addEntry(plan, "2026-08-20", "lunch", { recipeId: "x", servings: 1 });
  const outEst = { estCalories: 595, estProtein: 34 };
  const swipeEst = { estCalories: 920, estProtein: 60 };
  plan = cycleSlotAway(plan, "2026-08-20", "lunch", outEst, swipeEst, "swipes");
  let away = outEntryAt(plan.entries, "2026-08-20", "lunch");
  assert.equal(away.freeText, OUT_TEXT);
  assert.equal(away.currency, undefined);
  assert.equal(away.estProtein, 34, "restaurant slot undershoots");
  plan = cycleSlotAway(plan, "2026-08-20", "lunch", outEst, swipeEst, "swipes");
  away = outEntryAt(plan.entries, "2026-08-20", "lunch");
  assert.equal(away.freeText, SWIPE_TEXT);
  assert.equal(away.currency, "swipes");
  assert.equal(away.estProtein, 60, "buffet slot absorbs the protein");
  assert.equal(away.pinned, true, "still pinned: GENERATE plans around it");
  plan = cycleSlotAway(plan, "2026-08-20", "lunch", outEst, swipeEst, "swipes");
  assert.equal(entriesAt(plan.entries, "2026-08-20", "lunch").length, 0, "third tap clears");
});

test("cycleSlotAway without a buffet currency stays the classic two-state toggle", () => {
  let plan = { week: "2026-W34", entries: [] };
  const est = { estCalories: 595, estProtein: 34 };
  plan = cycleSlotAway(plan, "2026-08-20", "dinner", est, est, null);
  assert.ok(outEntryAt(plan.entries, "2026-08-20", "dinner"));
  plan = cycleSlotAway(plan, "2026-08-20", "dinner", est, est, null);
  assert.equal(entriesAt(plan.entries, "2026-08-20", "dinner").length, 0);
});

test("buffetMacroEstimate overshoots protein against the pool average; currencyUsed counts", () => {
  const recipes = [
    { id: "a", mealType: "lunch", nutrition: { calories: 850, protein: 40 } },
    { id: "b", mealType: "lunch", nutrition: { calories: 850, protein: 40 } },
  ];
  const est = buffetMacroEstimate(recipes, "lunch");
  assert.equal(est.estProtein, 60, "40 avg x 1.5");
  assert.equal(est.estCalories, 980, "850 avg x 1.15, rounded to 5");
  const plan = { week: "2026-W34", entries: [
    { id: "1", date: "2026-08-20", slot: "lunch", freeText: SWIPE_TEXT, servings: 1, out: true, currency: "swipes" },
    { id: "2", date: "2026-08-21", slot: "lunch", freeText: SWIPE_TEXT, servings: 1, out: true, currency: "swipes" },
    { id: "3", date: "2026-08-21", slot: "dinner", freeText: OUT_TEXT, servings: 1, out: true },
  ] };
  assert.equal(currencyUsed(plan, "swipes"), 2, "plain eating-out is not a swipe");
});

// ---- budgeting the week's swipes (P5, P10, David 2026-08-24) --------------
// The swipe machinery was complete and MANUAL: the generator does the
// arbitrage beautifully for swipes already in the plan, and nothing ever put
// one there. A seven-swipe meal plan only paid off if he remembered to tap
// seven slots before pressing GENERATE.

const WEEK_DATES = [
  "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27",
  "2026-08-28", "2026-08-29", "2026-08-30",
];
const SWIPE_OPTS = {
  perWeek: 7,
  currencyId: "swipes",
  slot: "lunch",
  estimate: { estCalories: 900, estProtein: 60 },
};

test("one swipe a day, on the preferred slot, up to the weekly allowance", () => {
  const out = planSwipes({ week: "2026-W35", entries: [] }, WEEK_DATES, SWIPE_OPTS);
  const swipes = out.entries.filter((e) => e.out && e.currency === "swipes");
  assert.equal(swipes.length, 7);
  assert.deepEqual([...new Set(swipes.map((e) => e.date))].sort(), WEEK_DATES);
  assert.ok(swipes.every((e) => e.slot === "lunch"));
  assert.ok(swipes.every((e) => e.estProtein === 60 && e.estCalories === 900));
});

test("a smaller allowance places fewer, not one a day regardless", () => {
  const out = planSwipes({ week: "2026-W35", entries: [] }, WEEK_DATES, {
    ...SWIPE_OPTS,
    perWeek: 3,
  });
  assert.equal(out.entries.filter((e) => e.currency === "swipes").length, 3);
});

test("running it twice does not spend fourteen swipes on a seven-swipe plan", () => {
  const once = planSwipes({ week: "2026-W35", entries: [] }, WEEK_DATES, SWIPE_OPTS);
  const twice = planSwipes(once, WEEK_DATES, SWIPE_OPTS);
  assert.equal(twice.entries.filter((e) => e.currency === "swipes").length, 7);
});

test("a PAST day is never planned: yesterday's lunch is not re-plannable", () => {
  const out = planSwipes({ week: "2026-W35", entries: [] }, WEEK_DATES, {
    ...SWIPE_OPTS,
    today: "2026-08-28",
  });
  const dates = out.entries.filter((e) => e.currency === "swipes").map((e) => e.date);
  assert.deepEqual(dates.sort(), ["2026-08-28", "2026-08-29", "2026-08-30"]);
});

test("a day already eating away is left alone, however that was decided", () => {
  const seeded = {
    week: "2026-W35",
    entries: [{ id: "x", date: "2026-08-26", slot: "dinner", out: true, servings: 1 }],
  };
  const out = planSwipes(seeded, WEEK_DATES, SWIPE_OPTS);
  const onThatDay = out.entries.filter((e) => e.date === "2026-08-26");
  assert.equal(onThatDay.length, 1, "no swipe stacked onto a day already out");
  assert.equal(out.entries.filter((e) => e.currency === "swipes").length, 6);
});

test("a PINNED meal in the preferred slot is respected, and never cleared", () => {
  const seeded = {
    week: "2026-W35",
    entries: [
      { id: "m", date: "2026-08-25", slot: "lunch", recipeId: "chana-masala", servings: 1, pinned: true },
    ],
  };
  const out = planSwipes(seeded, WEEK_DATES, SWIPE_OPTS);
  assert.ok(
    out.entries.some((e) => e.id === "m" && e.recipeId === "chana-masala"),
    "the pinned meal survives",
  );
  assert.equal(
    out.entries.filter((e) => e.date === "2026-08-25" && e.currency === "swipes").length,
    0,
  );
});

test("an UNPINNED auto-picked meal does NOT block a swipe, because generate clears it anyway", () => {
  // measured: skipping on "any entry" meant an already-generated week could
  // never gain a swipe, which is every week after the first. 0 of 7 placed.
  const seeded = {
    week: "2026-W35",
    entries: WEEK_DATES.map((d, i) => ({
      id: `a${i}`,
      date: d,
      slot: "lunch",
      recipeId: "turkish-lentil-soup",
      servings: 1,
    })),
  };
  const out = planSwipes(seeded, WEEK_DATES, SWIPE_OPTS);
  assert.equal(out.entries.filter((e) => e.currency === "swipes").length, 7);
});

test("no currency, or a zero allowance, changes nothing at all", () => {
  const plan = { week: "2026-W35", entries: [] };
  assert.equal(planSwipes(plan, WEEK_DATES, { ...SWIPE_OPTS, perWeek: 0 }), plan);
  assert.equal(planSwipes(plan, WEEK_DATES, { ...SWIPE_OPTS, currencyId: "" }), plan);
});

// THE WEEK RUN EATS ITS SWIPES (P5, P10, 2026-08-28 plenum). The brigade's
// week-of-meals run used to set a cooked table on every covered lunch and
// seat David at it; the pinned derived entry then blocked the swipe forever,
// so the arbitrage lost to the pot every single week.

const WEEK_MEALS = WEEK_DATES.flatMap((date) => [
  { date, slot: "lunch" },
  { date, slot: "dinner" },
]);
const BUFFET = { id: "swipes", perWeek: 7, preferredSlot: "lunch" };

test("weekRunSwipes claims every covered lunch, one a day, and never a dinner", () => {
  const out = weekRunSwipes(WEEK_MEALS, BUFFET, { week: "2026-W35", entries: [] }, "2026-08-24");
  assert.deepEqual(
    out,
    WEEK_DATES.map((date) => ({ date, slot: "lunch" })),
  );
});

test("weekRunSwipes: the allowance caps it, net of swipes already in the plan", () => {
  const seeded = {
    week: "2026-W35",
    entries: [
      { id: "s", date: "2026-08-24", slot: "lunch", out: true, currency: "swipes", servings: 1 },
    ],
  };
  const out = weekRunSwipes(WEEK_MEALS, { ...BUFFET, perWeek: 3 }, seeded, "2026-08-24");
  // the already-swiped pair is still claimed (off the pot) without spending
  // budget; two fresh days fit inside the remaining allowance of 2
  assert.deepEqual(
    out.map((m) => m.date),
    ["2026-08-24", "2026-08-25", "2026-08-26"],
  );
});

test("weekRunSwipes: a pinned lunch blocks its day, past days are read-only", () => {
  const seeded = {
    week: "2026-W35",
    entries: [
      { id: "m", date: "2026-08-26", slot: "lunch", recipeId: "chana", servings: 1, pinned: true },
    ],
  };
  const out = weekRunSwipes(WEEK_MEALS, BUFFET, seeded, "2026-08-25");
  assert.ok(!out.some((m) => m.date === "2026-08-24"), "yesterday is not re-plannable");
  assert.ok(!out.some((m) => m.date === "2026-08-26"), "the pinned lunch keeps its day");
  assert.equal(out.length, 5);
});

test("weekRunSwipes: a day already eating away in ANOTHER slot is left alone", () => {
  const seeded = {
    week: "2026-W35",
    entries: [{ id: "x", date: "2026-08-27", slot: "dinner", out: true, servings: 1 }],
  };
  const out = weekRunSwipes(WEEK_MEALS, BUFFET, seeded, "2026-08-24");
  assert.ok(!out.some((m) => m.date === "2026-08-27"));
});

test("weekRunSwipes: no buffet currency, or no allowance, claims nothing", () => {
  const plan = { week: "2026-W35", entries: [] };
  assert.deepEqual(weekRunSwipes(WEEK_MEALS, null, plan, "2026-08-24"), []);
  assert.deepEqual(weekRunSwipes(WEEK_MEALS, { ...BUFFET, perWeek: 0 }, plan, "2026-08-24"), []);
});

// dailyCovered (plenum r2): the off-plan day, spelled out for the model

const BANK = new Map([
  ["smoothie-x", { id: "smoothie-x", name: "Fuel", nutrition: { calories: 702, protein: 25.6 } }],
  ["bowl-y", { id: "bowl-y", name: "Bowl", nutrition: { calories: 610, protein: 45 } }],
]);

test("dailyCovered: unplanned fixed slots + the swipe sum to the off-plan day", () => {
  const cov = dailyCovered(
    { fixedSlots: { smoothie: "smoothie-x", breakfast: "bowl-y" } },
    BANK,
    new Set(["breakfast", "dinner"]), // breakfast IS planned → its fixed fill yields
    { estCalories: 1200, estProtein: 90 },
  );
  assert.equal(cov.calories, 1902); // 702 + 1200; the planned breakfast's 610 excluded
  assert.equal(cov.protein, 116); // 26 + 90
  assert.match(cov.note, /fixed daily smoothie/);
  assert.match(cov.note, /dining-hall meal/);
});

test("dailyCovered: nothing off-plan is null, and a missing recipe never counts", () => {
  assert.equal(dailyCovered({ fixedSlots: {} }, BANK, new Set(["dinner"]), null), null);
  assert.equal(dailyCovered({ fixedSlots: { smoothie: "gone" } }, BANK, new Set(["dinner"]), null), null);
});

// THE LEAN MENU SCREEN (2026-08-29 scorch): deterministic, because the
// prompt's band + LEAN labels measurably did not hold (asked 100-120 g
// planned, delivered 139-180 — the model upsized dense picks for calories).

const MENU = [
  { id: "d-dense", name: "Bulgogi", calories: 900, protein: 60, cuisine: "", meal: "dinner" },
  { id: "d-lean", name: "Rice+Peas", calories: 505, protein: 20, cuisine: "", meal: "dinner" },
  { id: "s-shake", name: "Lassi", calories: 457, protein: 41, cuisine: "", meal: "smoothie" },
  { id: "s-lean1", name: "Lean1", calories: 638, protein: 17, cuisine: "", meal: "smoothie" },
  { id: "s-lean2", name: "Lean2", calories: 489, protein: 14, cuisine: "", meal: "smoothie" },
  { id: "s-lean3", name: "Lean3", calories: 415, protein: 12, cuisine: "", meal: "smoothie" },
  { id: "b-yogurt", name: "Yogurt", calories: 755, protein: 56, cuisine: "", meal: "breakfast" },
  { id: "b-oats", name: "Oats", calories: 393, protein: 13, cuisine: "", meal: "breakfast" },
  { id: "b-porridge", name: "Porridge", calories: 361, protein: 13, cuisine: "", meal: "breakfast" },
  { id: "b-wheat", name: "Wheat", calories: 250, protein: 10, cuisine: "", meal: "breakfast" },
  { id: "n-jerky", name: "Jerky", calories: 130, protein: 16, cuisine: "", meal: "snack" },
  { id: "n-mix", name: "Trail mix", calories: 345, protein: 10, cuisine: "", meal: "snack" },
  { id: "n-slaw", name: "Slaw", calories: 97, protein: 3, cuisine: "", meal: "snack" },
  { id: "n-salad", name: "Salad", calories: 80, protein: 2, cuisine: "", meal: "snack" },
];
// David on a 90 g swipe day: (190-90)*1.2/2500 = 0.048 < 0.055 → tight
const TIGHT_PEOPLE = [{ id: "david", calories: 3700, protein: 190 }];
const TIGHT_COVERED = { david: { calories: 1200, protein: 90 } };

test("leanWeekMenu: a tight covered credit strips dense picks from smoothie/snack; breakfast and dinner untouched", () => {
  const { candidates, curated } = leanWeekMenu(MENU, TIGHT_PEOPLE, TIGHT_COVERED);
  assert.equal(curated, true);
  const ids = candidates.map((c) => c.id);
  // dense smoothie/snack picks are OFF the menu — a dish not offered cannot be picked
  assert.ok(!ids.includes("s-shake"));
  assert.ok(!ids.includes("n-jerky"));
  // the lean options survive
  assert.ok(ids.includes("s-lean1") && ids.includes("n-mix"));
  // breakfast is EXEMPT (David 2026-08-29: the yogurt-and-whey bowls stay
  // choosable; adherence beats the gram) — dense bowls included
  assert.ok(ids.includes("b-yogurt") && ids.includes("b-oats"));
  // dinner keeps its full menu, dense included: the anchor stays real
  assert.ok(ids.includes("d-dense") && ids.includes("d-lean"));
});

test("leanWeekMenu: no covered credit, or a roomy remainder, leaves the menu alone", () => {
  // nobody covered
  const a = leanWeekMenu(MENU, TIGHT_PEOPLE, {});
  assert.equal(a.curated, false);
  assert.equal(a.candidates.length, MENU.length);
  // covered, but the remainder is roomy: (190-20)*1.2/3200 = 0.064 > 0.055
  const b = leanWeekMenu(MENU, TIGHT_PEOPLE, { david: { calories: 500, protein: 20 } });
  assert.equal(b.curated, false);
});

test("leanWeekMenu: honest-relax keeps the leanest few when a slot has too few lean options", () => {
  const sparse = [
    { id: "s1", name: "A", calories: 400, protein: 40, cuisine: "", meal: "smoothie" },
    { id: "s2", name: "B", calories: 400, protein: 35, cuisine: "", meal: "smoothie" },
    { id: "s3", name: "C", calories: 400, protein: 30, cuisine: "", meal: "smoothie" },
    { id: "s4", name: "D", calories: 400, protein: 45, cuisine: "", meal: "smoothie" },
  ];
  const { candidates, curated } = leanWeekMenu(sparse, TIGHT_PEOPLE, TIGHT_COVERED);
  assert.equal(curated, true);
  // zero pass the density screen, so the 3 leanest stay — never an empty slot
  assert.deepEqual(candidates.map((c) => c.id).sort(), ["s1", "s2", "s3"]);
});

test("the placeholder carries everything dayTotals and the generator read", () => {
  const [s] = planSwipes({ week: "2026-W35", entries: [] }, WEEK_DATES, SWIPE_OPTS).entries;
  assert.equal(s.out, true, "so the generator pins it and does not re-roll it");
  assert.equal(s.currency, "swipes", "so it renders as SWIPE, not EATING OUT");
  assert.equal(s.freeText, SWIPE_TEXT);
  assert.ok(s.id, "every entry needs an id, it is the merge key");
});

test("a budgeted swipe is PINNED, or the generator deletes the thing it exists to inform", () => {
  // generateWeek keeps only pinned entries and clears the rest. Measured
  // before this was fixed: 7 swipes in, 0 out.
  const [s] = planSwipes({ week: "2026-W35", entries: [] }, WEEK_DATES, SWIPE_OPTS).entries;
  assert.equal(s.pinned, true);
});

// THE SWIPE'S COOKED BUTTON (P1, P11, 2026-08-29 plenum): eatenAt confirms
// the swipe was spent and its allocated macros actually eaten.

test("toggleSwipeEaten stamps only the swipe entry, and toggles back off", () => {
  const plan = {
    week: "2026-W36",
    entries: [
      { id: "s", date: "2026-08-31", slot: "lunch", out: true, currency: "swipes", servings: 1 },
      { id: "m", date: "2026-08-31", slot: "dinner", recipeId: "x", servings: 1 },
    ],
  };
  const on = toggleSwipeEaten(plan, "2026-08-31", "lunch", "2026-08-31");
  assert.equal(on.entries[0].eatenAt, "2026-08-31");
  assert.equal(on.entries[1].eatenAt, undefined, "a cooked meal is not a swipe");
  assert.equal(currencyEaten(on, "swipes"), 1);
  const off = toggleSwipeEaten(on, "2026-08-31", "lunch", "2026-09-01");
  assert.equal(off.entries[0].eatenAt, undefined, "tapping again un-eats a mistake");
  assert.equal(currencyEaten(off, "swipes"), 0);
});

test("toggleSwipeEaten never touches a plain OUT entry (no currency)", () => {
  const plan = {
    week: "2026-W36",
    entries: [{ id: "o", date: "2026-09-01", slot: "dinner", out: true, servings: 1 }],
  };
  const out = toggleSwipeEaten(plan, "2026-09-01", "dinner", "2026-09-01");
  assert.equal(out.entries[0].eatenAt, undefined);
});
