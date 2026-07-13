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
