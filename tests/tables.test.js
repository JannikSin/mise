import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEvents,
  deriveTables,
  addTable,
  removeTable,
  patchSeat,
  setTableTailor,
  setTableCooked,
  setTableHead,
  resolveHead,
  setTableSameForEveryone,
  setTableBuyer,
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
    [{ house: "home", events: { tables: [table({ buyerId: "david" })] } }],
    ctx(),
  );
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.table, "t1");
  assert.equal(e.pinned, true);
  assert.equal(e.recipeId, undefined); // never a recipeId: filtered pools lie
  assert.equal(e.estCalories, 1050); // 700 × 1.5
  assert.equal(e.estProtein, 60);
  // david CLAIMED the buy (buyerId), so his list carries the summed batch
  // potFromBank: the shared pot always resolves to the BANK recipe, never the
  // buyer's personal variant of the same id (2026-08-10)
  assert.deepEqual(cookExtras, [
    { recipeId: "kebab", date: "2026-07-24", servings: 2.5, potFromBank: true },
  ]);
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
    buyerId: "mom",
    seats: [
      { id: "david", servings: 1.5, status: "skipped" },
      { id: "mom", servings: 1 },
    ],
  });
  const r = deriveTables([{ house: "home", events: { tables: [t] } }], ctx());
  assert.equal(r.entries.length, 0); // david skipped: no pin, no macros
  // mom claimed the buy; skipped david's list carries nothing
  assert.deepEqual(r.cookExtras, []);
  const momView = deriveTables(
    [{ house: "home", events: { tables: [t] } }],
    ctx({ profileId: "mom" }),
  );
  assert.deepEqual(momView.cookExtras, [
    { recipeId: "kebab", date: "2026-07-24", servings: 1, potFromBank: true },
  ]);
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
  const r = deriveTables(
    [{ house: "home", events: { tables: [table({ seats, buyerId: "david" })] } }],
    ctx(),
  );
  assert.deepEqual(r.cookExtras, [
    { recipeId: "kebab", date: "2026-07-24", servings: 1, potFromBank: true },
  ]);
  // and a ghost-only first seat cannot void the cook role
  const r2 = deriveTables(
    [
      {
        house: "home",
        events: {
          tables: [
            table({
              buyerId: "david",
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

test("normalizeEvents now VALIDATES brigades instead of passing them through", () => {
  // brigades used to be an unbuilt placeholder, carried through untouched so a
  // hand-prototyped array was not lost. They now drive a write loop, which
  // makes the key a real trust boundary: a malformed one is dropped on its
  // own, and a good one beside it survives.
  const good = {
    id: "b1",
    name: "Family dinners",
    memberIds: ["mom", "laurie"],
    slots: ["dinner"],
    from: "2026-07-27",
    until: "2026-08-02",
  };
  const ev = normalizeEvents({ tables: [], brigades: [{ id: "b0" }, good] });
  assert.deepEqual(ev.brigades, [good]);
});

test("setTableTailor attaches a whitelisted tailor block to the right table", () => {
  const ev = { tables: [table(), table({ id: "t2" })] };
  const out = setTableTailor(
    ev,
    "t1",
    {
      at: TODAY,
      seats: { david: { plate: ["extra tofu"], estCalories: 1000, estProtein: 60 } },
      cook: ["hold the bread"],
      junk: "never lands",
    },
    TODAY,
  );
  assert.deepEqual(out.tables[0].tailor, {
    at: TODAY,
    seats: { david: { plate: ["extra tofu"], estCalories: 1000, estProtein: 60 } },
    cook: ["hold the bread"],
  });
  assert.equal(out.tables[1].tailor, undefined, "other tables untouched");
  assert.equal(ev.tables[0].tailor, undefined, "pure: input untouched");
});

test("a tailored table's derived entry carries my seat's plate notes", () => {
  const t = table({
    tailor: {
      at: TODAY,
      seats: { david: { plate: ["add 100g extra tofu"], estCalories: 1150, estProtein: 66 } },
      cook: [],
    },
  });
  const { entries } = deriveTables([{ house: "home", events: { tables: [t] } }], ctx());
  assert.deepEqual(entries[0].plate, ["add 100g extra tofu"]);
  const other = deriveTables(
    [{ house: "home", events: { tables: [t] } }],
    ctx({ profileId: "mom" }),
  );
  assert.equal(other.entries[0].plate, undefined, "untailored seat gets no plate notes");
});

test("a tailored seat's estimate replaces recipe x servings in the derived entry", () => {
  const t = table({
    tailor: {
      at: TODAY,
      seats: { david: { plate: ["add extra tofu"], estCalories: 1400, estProtein: 82 } },
      cook: [],
    },
  });
  const { entries } = deriveTables([{ house: "home", events: { tables: [t] } }], ctx());
  assert.equal(entries[0].estCalories, 1400, "meter counts the tailored plate");
  assert.equal(entries[0].estProtein, 82);
  const mom = deriveTables([{ house: "home", events: { tables: [t] } }], ctx({ profileId: "mom" }));
  assert.equal(mom.entries[0].estCalories, 700, "untailored seat keeps recipe x servings");
});

test("cook shopping dedupe is HOUSE-scoped: another house's same-night dinner never starves mine", () => {
  // code review 2026-08-02 HIGH #2: unscoped, the first table across ALL
  // houses at a date+slot ate the slot key and my own house's cook bought
  // nothing for their night
  const mine = table({ buyerId: "david" });
  const theirs = { ...table(), id: "other-house", seats: [{ id: "away", servings: 2 }] };
  const profiles = new Map([
    ["david", { id: "david", household: "home" }],
    ["away", { id: "away", household: "elsewhere" }],
  ]);
  const r = deriveTables(
    [
      { house: "elsewhere", events: { tables: [theirs] } },
      { house: "home", events: { tables: [mine] } },
    ],
    { ...ctx(), profilesById: profiles },
  );
  assert.equal(r.cookExtras.length, 1, "my house's batch still shops");
  assert.equal(r.allCookExtras.filter((x) => x.date === mine.date).length, 2, "both houses' batches known");
});

test("setTableBuyer claims and releases; clearing writes the field OUT (absent, not null)", () => {
  const events = { tables: [table()] };
  const claimed = setTableBuyer(events, "t1", "mom", "2026-07-24");
  assert.equal(claimed.tables[0].buyerId, "mom");
  const released = setTableBuyer(claimed, "t1", null, "2026-07-24");
  assert.ok(!("buyerId" in released.tables[0]), "absent, per SCHEMAS conventions");
});

// --- tailoring is the default; sameForEveryone is the exception -----------
// David, 2026-08-10: "the norm should be tailoring, the norm should be
// following exactly what you should be doing. A button to UN-tailor."

test("sameForEveryone opts one meal out and drops its plates", () => {
  const base = {
    house: "home",
    tables: [
      {
        id: "t1",
        name: "kofta",
        date: "2026-07-24",
        slot: "dinner",
        recipeId: "kebab",
        seats: [{ id: "david", servings: 2 }],
        tailor: { at: "2026-07-23", seats: { david: { plate: ["x"] } }, cook: [] },
      },
    ],
    brigades: [],
  };
  const off = setTableSameForEveryone(base, "t1", true, "2026-07-20");
  assert.equal(off.tables[0].sameForEveryone, true);
  assert.equal(off.tables[0].tailor, undefined, "the plates it just rejected are dropped");

  // clearing removes the field entirely (absent = tailored, SCHEMAS convention)
  const back = setTableSameForEveryone(off, "t1", false, "2026-07-20");
  assert.ok(!("sameForEveryone" in back.tables[0]), "absent, not false");

  // and it never touches another table
  assert.equal(setTableSameForEveryone(base, "nope", true, "2026-07-20").tables[0].tailor?.at, "2026-07-23");
});

test("setTableCooked is set-once: the serve step's COOKED cannot be re-stamped", () => {
  const base = {
    tables: [
      {
        id: "t1",
        name: "kofta",
        date: "2026-07-24",
        slot: "dinner",
        recipeId: "kebab",
        seats: [{ id: "david", servings: 2 }],
      },
    ],
  };
  const cooked = setTableCooked(base, "t1", "2026-07-24", "2026-07-24");
  assert.equal(cooked.tables[0].cookedAt, "2026-07-24");
  // a second confirmation days later must not move the date — you cannot
  // un-cook or re-cook food, and the instrument reads this field
  const again = setTableCooked(cooked, "t1", "2026-07-26", "2026-07-26");
  assert.equal(again.tables[0].cookedAt, "2026-07-24");
  // and it never touches another table
  assert.equal(setTableCooked(base, "nope", "2026-07-24", "2026-07-24").tables[0].cookedAt, undefined);
});

// THE HEAD (spec §9): human-tap-only writer + presence-aware resolution.
test("setTableHead writes only by tap; resolveHead falls through head -> cook -> profiles order", () => {
  const today = "2026-08-10";
  let ev = normalizeEvents({
    tables: [
      {
        id: "h1",
        name: "dinner",
        date: "2026-08-12",
        slot: "dinner",
        recipeId: "r",
        cookId: "b",
        seats: [
          { id: "b", servings: 1 },
          { id: "a", servings: 1 },
          { id: "c", servings: 1 },
        ],
      },
    ],
  });
  const order = [{ id: "a" }, { id: "b" }, { id: "c" }];
  // no head tapped: the cook sets the table
  assert.equal(resolveHead(ev.tables[0], order), "b");
  ev = setTableHead(ev, "h1", "c", today);
  assert.equal(ev.tables[0].headId, "c");
  assert.equal(resolveHead(ev.tables[0], order), "c");
  // SEATED IGNORES SKIP STATUS (spec §9, verbatim): the tapped head who
  // taps "skip mine" (cooking, eating late) KEEPS the table — reusing a
  // presence filter here is the exact bug §9 names about cookOf
  const skipped = { ...ev.tables[0], seats: ev.tables[0].seats.map((s) => (s.id === "c" ? { ...s, status: "skipped" } : s)) };
  assert.equal(resolveHead(skipped, order), "c");
  // an UNSEATED head (removed from the table entirely) falls to the cook
  const gone = { ...ev.tables[0], seats: ev.tables[0].seats.filter((s) => s.id !== "c") };
  assert.equal(resolveHead(gone, order), "b");
  // cook also unseated: first SEATED profile in PROFILES order, any status
  const both = { ...gone, seats: gone.seats.filter((s) => s.id !== "b") };
  assert.equal(resolveHead(both, order), "a");
  // nobody seated at all: null, never a guess
  assert.equal(resolveHead({ ...ev.tables[0], seats: [] }, order), null);
  // clearing restores the default chain
  ev = setTableHead(ev, "h1", null, today);
  assert.equal(ev.tables[0].headId, undefined);
});
