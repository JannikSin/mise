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
  setPlanLocked,
  mergeRecipePool,
  dietOf,
} from "../app/lib/plan.js";

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
  assert.equal(normalizePlan({ week: "2026-W28", locked: false, entries: [] }, "2026-W28").locked, false);
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
  assert.deepEqual(pool.map((r) => r.id), ["my-treat"]);
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

test("mergeRecipePool: avoidIngredients screens bank recipes by substring, own recipes exempt", () => {
  const bank = [
    { id: "doner", ingredients: [{ food: "red onion" }, { food: "chicken thigh" }] },
    { id: "soup", ingredients: [{ food: "Onion" }, { food: "carrot" }] }, // case-insensitive
    { id: "clean-bowl", ingredients: [{ food: "chicken breast" }, { food: "rice" }] },
  ];
  const own = [{ id: "moms-tagine", ingredients: [{ food: "pearl onion" }] }]; // hers, untouched
  const pool = mergeRecipePool(bank, own, "loss", ["onion", "shallot"]);
  assert.deepEqual(pool.map((r) => r.id).sort(), ["clean-bowl", "moms-tagine"]);
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
  assert.equal(dietOf({ tags: ["vegan", "gluten-free"], ingredients: [{ food: "cheese" }] }), "vegan");
  assert.equal(dietOf({ ingredients: [{ food: "chicken thigh" }] }), "omnivore");
  assert.equal(dietOf({ ingredients: [{ food: "wild salmon" }, { food: "rice" }] }), "pescatarian");
  assert.equal(dietOf({ ingredients: [{ food: "feta cheese" }, { food: "tomato" }] }), "vegetarian");
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
    mergeRecipePool(bank, [], undefined, [], "vegan").map((r) => r.id).sort(),
    ["bean-chili"],
  );
  assert.deepEqual(
    mergeRecipePool(bank, [], undefined, [], "vegetarian").map((r) => r.id).sort(),
    ["bean-chili", "feta-salad"],
  );
  assert.deepEqual(
    mergeRecipePool(bank, [], undefined, [], "pescatarian").map((r) => r.id).sort(),
    ["bean-chili", "feta-salad", "salmon-bowl"],
  );
  // omnivore (or absent) admits everything, own recipes always exempt
  assert.equal(mergeRecipePool(bank, [], undefined, [], "omnivore").length, 4);
  const own = [{ id: "beef-bowl", ingredients: [{ food: "beef" }] }];
  assert.ok(mergeRecipePool(bank, own, undefined, [], "vegan").some((r) => r.id === "beef-bowl"));
});

test("pickCommittee: tiredOf foods lose ties softly (penalized but not banned)", async () => {
  const { pickCommittee } = await import("../app/lib/weekbuilder.js");
  const candidates = [
    { id: "pasta-bowl", cuisine: "italian", effort: "cook", nutrition: { protein: 20 }, foodGroups: {}, ingredients: [{ food: "pasta" }] },
    { id: "bean-bowl", cuisine: "mexican", effort: "cook", nutrition: { protein: 20 }, foodGroups: {}, ingredients: [{ food: "black beans" }] },
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
    { id: "last-week-fav", cuisine: "korean", effort: "cook", nutrition: { protein: 30 }, foodGroups: {}, ingredients: [{ food: "tofu" }] },
    { id: "fresh-option", cuisine: "mexican", effort: "cook", nutrition: { protein: 30 }, foodGroups: {}, ingredients: [{ food: "black beans" }] },
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
