import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEvents,
  deriveTables,
  addTable,
  removeTable,
  patchSeat,
  pruneTables,
  stripTableEntries,
  mergeViewPlan,
} from "../app/lib/tables.js";
import { recipeConflicts, mergeRecipePool } from "../app/lib/plan.js";
import { mergeFieldWise } from "../app/lib/merge.js";

const KEBAB = {
  id: "kebab",
  name: "Kebab Bowl",
  mealType: "dinner",
  servings: 1,
  nutrition: { calories: 700, protein: 40 },
  ingredients: [
    { qty: 1, unit: "x", food: "chicken thigh" },
    { qty: 1, unit: "x", food: "shallot" },
  ],
};
const BANK = new Map([[KEBAB.id, KEBAB]]);
const PROFILES = new Map([
  ["david", { id: "david" }], // house "home"
  ["mom", { id: "mom" }],
  ["laurie", { id: "laurie", household: "laurie" }],
]);
const TODAY = "2026-07-21";

const table = (over = {}) => ({
  id: "t1",
  name: "Family dinner",
  date: "2026-07-24",
  slot: "dinner",
  recipeId: "kebab",
  seats: [
    { id: "david", servings: 1.5 },
    { id: "mom", servings: 1 },
  ],
  ...over,
});

const ctx = (over = {}) => ({
  profileId: "david",
  myHouse: "home",
  bankById: BANK,
  ownEntries: [],
  today: TODAY,
  profilesById: PROFILES,
  ...over,
});

test("a seated profile derives one est-based pinned virtual entry", () => {
  const { entries, cookExtras } = deriveTables(
    [{ house: "home", events: { tables: [table()] } }],
    ctx(),
  );
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.table, "t1");
  assert.equal(e.pinned, true);
  assert.equal(e.recipeId, undefined); // never a recipeId: filtered pools lie
  assert.equal(e.estCalories, 1050); // 700 × 1.5
  assert.equal(e.estProtein, 60);
  // david lives in the table's house and sits first: he cooks and shops the sum
  assert.deepEqual(cookExtras, [{ recipeId: "kebab", date: "2026-07-24", servings: 2.5 }]);
});

test("a profile not seated derives nothing; a guest from another house never shops", () => {
  const r = deriveTables(
    [
      {
        house: "home",
        events: {
          tables: [
            table({
              seats: [
                { id: "laurie", servings: 1 },
                { id: "mom", servings: 1 },
              ],
            }),
          ],
        },
      },
    ],
    ctx({ profileId: "laurie", myHouse: "laurie" }),
  );
  assert.equal(r.entries.length, 1); // laurie is seated
  assert.deepEqual(r.cookExtras, []); // but mom (house "home") cooks, not laurie
});

test("diet/avoid conflicts surface as banners, never as pins (the Red Team block)", () => {
  const r = deriveTables(
    [{ house: "home", events: { tables: [table()] } }],
    ctx({ avoid: ["shallot"] }),
  );
  assert.equal(r.entries.length, 0);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0].reasons, ["contains shallot"]);
});

test("skipped seats derive nothing and are excluded from the cook's sum", () => {
  const t = table({
    seats: [
      { id: "david", servings: 1.5, status: "skipped" },
      { id: "mom", servings: 1 },
    ],
  });
  const r = deriveTables([{ house: "home", events: { tables: [t] } }], ctx());
  assert.equal(r.entries.length, 0); // david skipped: no pin, no macros
  // david skipped → mom is the first live home seat → SHE cooks; david adds nothing
  assert.deepEqual(r.cookExtras, []);
  const momView = deriveTables(
    [{ house: "home", events: { tables: [t] } }],
    ctx({ profileId: "mom" }),
  );
  assert.deepEqual(momView.cookExtras, [{ recipeId: "kebab", date: "2026-07-24", servings: 1 }]);
});

test("my own PINNED entry at the slot wins; the table entry reports a collision", () => {
  const r = deriveTables(
    [{ house: "home", events: { tables: [table()] } }],
    ctx({
      ownEntries: [
        { date: "2026-07-24", slot: "dinner", recipeId: "x", servings: 1, pinned: true },
      ],
    }),
  );
  assert.equal(r.entries.length, 0);
  assert.equal(r.collisions.length, 1);
});

test("an unpinned generated meal never blocks a table (it gets displaced instead)", () => {
  const r = deriveTables(
    [{ house: "home", events: { tables: [table()] } }],
    ctx({ ownEntries: [{ date: "2026-07-24", slot: "dinner", recipeId: "x", servings: 1 }] }),
  );
  assert.equal(r.entries.length, 1);
  assert.equal(r.collisions.length, 0);
});

test("trust boundary: garbage tables are skipped individually, servings clamp", () => {
  const poisoned = {
    tables: [
      { id: "bad1", recipeId: "kebab", date: "garbage", slot: "dinner", seats: [] },
      { id: "bad2", recipeId: "kebab", date: "2026-07-24", slot: "elevenses", seats: [] },
      { id: "bad3" },
      null,
      table({ id: "ok", seats: [{ id: "david", servings: 1e9 }] }),
    ],
  };
  const r = deriveTables([{ house: "home", events: normalizeEvents(poisoned) }], ctx());
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].servings, 10); // clamped
  assert.equal(r.entries[0].estCalories, 7000);
});

test("one derived pin per date+slot: first valid table wins", () => {
  const r = deriveTables(
    [{ house: "home", events: { tables: [table(), table({ id: "t2", name: "Second" })] } }],
    ctx(),
  );
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].table, "t1");
});

test("retention: derivation ignores stale tables; CRUD prunes them", () => {
  const stale = table({ id: "old", date: "2026-06-01" });
  const r = deriveTables([{ house: "home", events: { tables: [stale] } }], ctx());
  assert.equal(r.entries.length, 0);
  const pruned = pruneTables({ tables: [stale, table()] }, TODAY);
  assert.deepEqual(
    pruned.tables.map((t) => t.id),
    ["t1"],
  );
});

test("addTable clamps seat servings and assigns an id; removeTable removes", () => {
  const ev = addTable(
    { tables: [] },
    {
      name: "X",
      date: "2026-07-25",
      slot: "dinner",
      recipeId: "kebab",
      seats: [{ id: "mom", servings: 99 }],
    },
    TODAY,
  );
  assert.equal(ev.tables.length, 1);
  assert.ok(ev.tables[0].id.length > 0);
  assert.equal(ev.tables[0].seats[0].servings, 10);
  assert.equal(removeTable(ev, ev.tables[0].id, TODAY).tables.length, 0);
});

test("patchSeat edits only your own seat, clamped", () => {
  const ev = { tables: [table()] };
  const out = patchSeat(ev, "t1", "david", { servings: 0.1, status: "skipped" });
  const david = out.tables[0].seats.find((s) => s.id === "david");
  const mom = out.tables[0].seats.find((s) => s.id === "mom");
  assert.equal(david.servings, 0.5);
  assert.equal(david.status, "skipped");
  assert.equal(mom.servings, 1);
});

test("concurrent seat edits on one table merge per-seat (id-keyed all the way down)", () => {
  const base = { tables: [table()] };
  const local = patchSeat(base, "t1", "david", { servings: 2 });
  const remote = patchSeat(base, "t1", "mom", { status: "skipped" });
  const merged = mergeFieldWise(base, local, remote);
  const seats = merged.tables[0].seats;
  assert.equal(seats.find((s) => s.id === "david").servings, 2);
  assert.equal(seats.find((s) => s.id === "mom").status, "skipped");
});

test("recipeConflicts refactor: mergeRecipePool still screens identically", () => {
  assert.deepEqual(recipeConflicts(KEBAB, undefined, ["shallot"]), ["contains shallot"]);
  assert.deepEqual(recipeConflicts(KEBAB, "vegetarian", []), ["not vegetarian"]);
  assert.deepEqual(recipeConflicts(KEBAB, undefined, []), []);
  const pool = mergeRecipePool([KEBAB], [], undefined, ["shallot"], undefined);
  assert.equal(pool.length, 0);
  const pool2 = mergeRecipePool([KEBAB], [], undefined, [], undefined);
  assert.equal(pool2.length, 1);
});

test("stripTableEntries removes ANY entry carrying a table property, even a falsy id", () => {
  const entries = [
    { id: "a", date: "2026-07-24", slot: "dinner", recipeId: "x", servings: 1 },
    { id: "t", date: "2026-07-24", slot: "lunch", table: "", freeText: "poisoned", servings: 1 },
    { id: "t2", date: "2026-07-25", slot: "dinner", table: "ok", servings: 1 },
  ];
  assert.deepEqual(
    stripTableEntries(entries).map((e) => e.id),
    ["a"],
  );
});

test("mergeViewPlan: displaces unpinned, keeps pinned/OUT, clamps to week, spares past days", () => {
  const weekDates = [
    "2026-07-20",
    "2026-07-21",
    "2026-07-22",
    "2026-07-23",
    "2026-07-24",
    "2026-07-25",
    "2026-07-26",
  ];
  const plan = {
    week: "2026-W30",
    entries: [
      { id: "u", date: "2026-07-24", slot: "dinner", recipeId: "x", servings: 1 }, // displaced
      { id: "p", date: "2026-07-24", slot: "lunch", recipeId: "y", servings: 1, pinned: true },
      { id: "past", date: "2026-07-20", slot: "dinner", recipeId: "z", servings: 1 }, // past: spared
    ],
  };
  const tableEntries = [
    { id: "table-1", table: "1", date: "2026-07-24", slot: "dinner", servings: 1, pinned: true },
    { id: "table-2", table: "2", date: "2026-07-20", slot: "dinner", servings: 1, pinned: true },
    { id: "table-3", table: "3", date: "2026-08-15", slot: "dinner", servings: 1, pinned: true }, // out of week
  ];
  const { plan: view, displaced } = mergeViewPlan(plan, tableEntries, weekDates, "2026-07-22");
  const ids = view.entries.map((e) => e.id);
  assert.ok(!ids.includes("u")); // displaced
  assert.ok(ids.includes("p")); // pinned kept
  assert.ok(ids.includes("past")); // past never displaced (generate would delete history)
  assert.ok(ids.includes("table-1") && ids.includes("table-2"));
  assert.ok(!ids.includes("table-3")); // week clamp: no cross-week ghost days
  assert.equal(displaced, true);
});

test("a poisoned table with an empty id derives nothing", () => {
  const r = deriveTables([{ house: "home", events: { tables: [table({ id: "" })] } }], ctx());
  assert.equal(r.entries.length, 0);
});

test("seat flood: unknown-profile seats never cook, never inflate the sum", () => {
  const seats = [{ id: "david", servings: 1 }];
  for (let i = 0; i < 50; i++) seats.push({ id: `ghost${i}`, servings: 10 });
  const r = deriveTables([{ house: "home", events: { tables: [table({ seats })] } }], ctx());
  assert.deepEqual(r.cookExtras, [{ recipeId: "kebab", date: "2026-07-24", servings: 1 }]);
  // and a ghost-only first seat cannot void the cook role
  const r2 = deriveTables(
    [
      {
        house: "home",
        events: {
          tables: [
            table({
              seats: [
                { id: "zzz", servings: 1 },
                { id: "david", servings: 1 },
              ],
            }),
          ],
        },
      },
    ],
    ctx(),
  );
  assert.equal(r2.cookExtras.length, 1);
});

test("a table on a non-bank recipe surfaces as a conflict, never a silent no-op", () => {
  const r = deriveTables(
    [{ house: "home", events: { tables: [table({ recipeId: "moms-own-thing" })] } }],
    ctx(),
  );
  assert.equal(r.entries.length, 0);
  assert.deepEqual(r.conflicts[0].reasons, ["recipe not in the shared bank"]);
});

test("derived entries carry viewRecipeId and the cook's batch total", () => {
  const { entries } = deriveTables([{ house: "home", events: { tables: [table()] } }], ctx());
  assert.equal(entries[0].viewRecipeId, "kebab");
  assert.equal(entries[0].cookTotal, 2.5); // david cooks: 1.5 + 1
  const momView = deriveTables(
    [{ house: "home", events: { tables: [table()] } }],
    ctx({ profileId: "mom" }),
  );
  assert.equal(momView.entries[0].cookTotal, undefined); // mom is not the cook
});

test("patchSeat whitelists fields: id and junk keys never land", () => {
  const ev = { tables: [table()] };
  const out = patchSeat(ev, "t1", "david", { id: "mom", junk: true, servings: 2 }, TODAY);
  const seat = out.tables[0].seats[0];
  assert.equal(seat.id, "david");
  assert.equal(seat.junk, undefined);
  assert.equal(seat.servings, 2);
});

test("normalizeEvents carries an unbuilt brigades key through untouched", () => {
  const ev = normalizeEvents({ tables: [], brigades: [{ id: "b1" }] });
  assert.deepEqual(ev.brigades, [{ id: "b1" }]);
});
