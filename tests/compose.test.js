// The day composer: the one arithmetic authority (P1 numbers, P2 decided,
// P8 plates). These are the per-day BAND tests the suite never had — the
// 2026-08-30 tribunal's finding was that no test anywhere asserted a
// generated brigade day's calories or protein, which is how six patch
// layers shipped in one evening with every live day 300-900 kcal short.
import test from "node:test";
import assert from "node:assert/strict";
import {
  seatBands,
  solveSeatDay,
  composeDay,
  memberCoverage,
  planBrigadeWeek,
} from "../app/lib/compose.js";
import { brigadeTableId } from "../app/lib/tables.js";

// ---------------------------------------------------------------------------
// fixtures: synthetic, David/Elliot/taranowski-SHAPED, never real data files
// ---------------------------------------------------------------------------

/** @param {string} id @param {string} meal @param {number} kcal @param {number} p */
const recipe = (id, meal, kcal, p, extra = {}) => ({
  id,
  name: id,
  mealType: meal,
  effort: "assembly",
  servings: 2,
  tags: [],
  ingredients: [{ qty: 1, unit: "x", food: "food" }],
  nutrition: { calories: kcal, protein: p },
  ...extra,
});

const BANK = [
  recipe("bf-oats", "breakfast", 550, 38),
  recipe("bf-yogurt", "breakfast", 635, 32),
  recipe("bf-balls", "breakfast", 515, 16),
  recipe("bf-light", "breakfast", 393, 13),
  recipe("smo-berry", "smoothie", 400, 38),
  recipe("smo-banana", "smoothie", 648, 23),
  recipe("smo-mango", "smoothie", 588, 9),
  recipe("smo-big", "smoothie", 810, 30),
  recipe("snk-mix", "snack", 345, 10),
  recipe("snk-cottage", "snack", 245, 29),
  recipe("snk-fruitplate", "snack", 570, 32),
  recipe("snk-small", "snack", 130, 16),
  recipe("din-bulgogi", "dinner", 980, 61),
  recipe("din-gyros", "dinner", 900, 65),
  recipe("din-soup", "dinner", 390, 33),
  recipe("din-stew", "dinner", 620, 28),
  recipe("din-pasta", "dinner", 765, 43),
  recipe("din-kofta", "dinner", 838, 46),
];
const bankById = new Map(BANK.map((r) => [r.id, r]));

const davidTargets = {
  macros: { calories: 3700, caloriesFloor: 3500, protein: 190, proteinAim: 190, proteinCeiling: 215 },
  currencies: [
    { id: "swipes", venue: "buffet", perWeek: 7, preferredSlot: "lunch", estCalories: 1200, estProtein: 90 },
  ],
};
const elliotTargets = {
  macros: { calories: 2850, caloriesFloor: 2650, protein: 145 },
  currencies: [
    { id: "swipes", venue: "buffet", perWeek: 7, preferredSlot: "lunch", estCalories: 950, estProtein: 70 },
  ],
};

const WAYNE_PROFILES = new Map([
  ["david", { id: "david", household: "wayne" }],
  ["elliot", { id: "elliot", household: "wayne" }],
]);
const DATES = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"];
const BRIGADE = {
  id: "wk",
  name: "Wayne kitchen",
  memberIds: ["david", "elliot"],
  slots: ["breakfast", "smoothie", "snack", "dinner"],
  cookId: "david",
  from: "2026-08-31",
  until: "2026-09-27",
};
const wayneCtx = (overrides = {}) => ({
  dates: DATES,
  today: "2026-08-31",
  house: "wayne",
  profilesById: WAYNE_PROFILES,
  targetsById: new Map([
    ["david", davidTargets],
    ["elliot", elliotTargets],
  ]),
  plansById: new Map(),
  bankById,
  ...overrides,
});

// ---------------------------------------------------------------------------

test("seatBands derives the missing ceiling and aim instead of shipping an unbounded band", () => {
  const b = seatBands(elliotTargets, { calories: 950, protein: 70 });
  assert.ok(b);
  assert.equal(b.kcalLo, 1900);
  assert.equal(b.kcalHi, 2000);
  assert.equal(b.pLo, 75);
  assert.equal(b.pHi, Math.round(145 * 1.15) - 70, "ceiling defaults to protein x 1.15");
  assert.equal(b.pAim, 75, "aim defaults to the floor when no proteinAim is written");
});

test("solveSeatDay lands the strict band and never goes over ceiling or +100 kcal", () => {
  const bands = seatBands(davidTargets, { calories: 1200, protein: 90 });
  const dishes = [
    { slot: "breakfast", recipe: bankById.get("bf-yogurt") },
    { slot: "smoothie", recipe: bankById.get("smo-banana") },
    { slot: "snack", recipe: bankById.get("snk-mix") },
    { slot: "dinner", recipe: bankById.get("din-bulgogi") },
  ];
  const s = solveSeatDay(dishes, bands, {});
  assert.ok(s, "a solution exists");
  assert.equal(s.status, "band");
  assert.ok(s.kcal >= 2500 && s.kcal <= 2600, `kcal ${s.kcal} inside [2500, 2600]`);
  assert.ok(s.protein >= 100 && s.protein <= 125, `protein ${s.protein} inside [100, 125]`);
});

test("a hand-set portion binds the solve and is reported, never silently overruled", () => {
  const bands = seatBands(davidTargets, { calories: 1200, protein: 90 });
  const dishes = [
    { slot: "breakfast", recipe: bankById.get("bf-yogurt") },
    { slot: "smoothie", recipe: bankById.get("smo-banana") },
    { slot: "snack", recipe: bankById.get("snk-mix") },
    { slot: "dinner", recipe: bankById.get("din-bulgogi") },
  ];
  const s = solveSeatDay(dishes, bands, {}, { dinner: 0.75 });
  assert.ok(s);
  assert.equal(s.servings.dinner, 0.75, "the hand-set dinner portion survives");
});

test("composeDay swaps a light slot to land every seat jointly", () => {
  const slots = ["breakfast", "smoothie", "snack", "dinner"];
  const poolsBySlot = {
    breakfast: BANK.filter((r) => r.mealType === "breakfast"),
    smoothie: BANK.filter((r) => r.mealType === "smoothie"),
    snack: BANK.filter((r) => r.mealType === "snack"),
    dinner: BANK.filter((r) => r.mealType === "dinner"),
  };
  // start tuple deliberately hostile: tiny dinner + protein-dense smoothie
  const startBySlot = {
    breakfast: bankById.get("bf-light"),
    smoothie: bankById.get("smo-berry"),
    snack: bankById.get("snk-small"),
    dinner: bankById.get("din-soup"),
  };
  const seats = [
    { id: "david", targets: davidTargets, bands: seatBands(davidTargets, { calories: 1200, protein: 90 }) },
    { id: "elliot", targets: elliotTargets, bands: seatBands(elliotTargets, { calories: 950, protein: 70 }) },
  ];
  const out = composeDay({ slots, poolsBySlot, startBySlot, seats });
  assert.ok(out, "the day composes");
  assert.equal(out.allInBand, true, "both seats land in band after swaps");
  for (const id of ["david", "elliot"]) {
    assert.equal(out.seats[id].status, "band", `${id} lands strictly`);
  }
});

test("graduated acceptance: an impossible seat degrades with a name, the day still exists", () => {
  // a seat whose remaining band no pool can reach (tiny remaining budget)
  const tiny = { macros: { calories: 1200, caloriesFloor: 1000, protein: 60 } };
  const slots = ["dinner"];
  const pools = { dinner: BANK.filter((r) => r.mealType === "dinner") };
  const start = { dinner: bankById.get("din-bulgogi") };
  const seats = [
    { id: "big", targets: davidTargets, bands: seatBands(davidTargets, { calories: 2100, protein: 120 }) },
    { id: "small", targets: tiny, bands: seatBands(tiny, { calories: 1050, protein: 45 }) },
  ];
  const out = composeDay({ slots, poolsBySlot: pools, startBySlot: start, seats });
  assert.ok(out, "the day never refuses whole");
  assert.ok(out.seats.big, "the feasible seat is served");
  assert.ok(out.seats.small, "the infeasible seat is served at best effort");
  assert.notEqual(out.seats.small.status, "band");
});

test("memberCoverage credits swipes and screens fixed slots (no phantom credit)", () => {
  const withFixed = {
    ...davidTargets,
    fixedSlots: { smoothie: "smo-banana", lunch: "din-bulgogi" },
    avoidIngredients: ["food"], // screens EVERY fixture recipe
  };
  const cov = memberCoverage(withFixed, null, DATES, new Set(["smoothie"]), bankById, "2026-08-31");
  const day = cov.coveredByDate["2026-08-31"];
  assert.equal(day.calories, 1200, "swipe credited, screened fixed lunch NOT credited");
  // now without the avoid screen: the un-planned fixed lunch credits
  const cov2 = memberCoverage(
    { ...davidTargets, fixedSlots: { lunch: "din-soup" }, currencies: [] },
    null,
    DATES,
    new Set(["smoothie"]),
    bankById,
    "2026-08-31",
  );
  assert.equal(cov2.coveredByDate["2026-08-31"].calories, 390);
});

test("PLAN A BRIGADE WEEK: every wayne day lands BOTH seats in band", () => {
  const { events, made, report } = planBrigadeWeek({ tables: [] }, BRIGADE, wayneCtx());
  assert.equal(made, DATES.length * 4, "one table per date and slot");
  assert.equal(events.tables.length, DATES.length * 4);
  for (const date of DATES) {
    for (const id of ["david", "elliot"]) {
      const row = report.find((r) => r.date === date && r.seatId === id);
      assert.ok(row, `${id} has a report row on ${date}`);
      assert.equal(row.status, "band", `${id} ${date} lands strictly (${row.dayKcal} kcal / ${row.dayProtein} g)`);
    }
    const david = report.find((r) => r.date === date && r.seatId === "david");
    assert.ok(
      david.dayKcal >= 3700 && david.dayKcal <= 3800,
      `David's ${date} full day ${david.dayKcal} kcal inside [3700, 3800]`,
    );
    assert.ok(
      david.dayProtein >= 190 && david.dayProtein <= 215,
      `David's ${date} protein ${david.dayProtein} inside [190, 215]`,
    );
  }
});

test("smoothie slots hold smoothies and breakfasts hold breakfasts, by construction", () => {
  const { events } = planBrigadeWeek({ tables: [] }, BRIGADE, wayneCtx());
  for (const t of events.tables) {
    assert.equal(bankById.get(t.recipeId)?.mealType, t.slot, `${t.recipeId} matches ${t.slot}`);
  }
});

test("the re-roll salt reshuffles the picks; same salt, same week", () => {
  const a = planBrigadeWeek({ tables: [] }, BRIGADE, wayneCtx()).events;
  const b = planBrigadeWeek({ tables: [] }, { ...BRIGADE, salt: 1 }, wayneCtx()).events;
  const c = planBrigadeWeek({ tables: [] }, { ...BRIGADE, salt: 1 }, wayneCtx()).events;
  const seq = (/** @type {any} */ e) =>
    e.tables.map((/** @type {any} */ t) => `${t.date}|${t.slot}|${t.recipeId}`).sort().join(",");
  assert.notEqual(seq(a), seq(b), "a bumped salt produces a different week");
  assert.equal(seq(b), seq(c), "the same salt is deterministic across devices");
  assert.deepEqual(
    a.tables.map((/** @type {any} */ t) => t.id).sort(),
    b.tables.map((/** @type {any} */ t) => t.id).sort(),
    "ids never change — the merge stays id-keyed",
  );
});

test("ids are deterministic and the run is idempotent", () => {
  const first = planBrigadeWeek({ tables: [] }, BRIGADE, wayneCtx());
  const second = planBrigadeWeek(first.events, BRIGADE, wayneCtx());
  assert.equal(second.made, 0, "an unchanged week rewrites nothing");
  assert.deepEqual(second.events.tables, first.events.tables);
  assert.ok(first.events.tables.some((t) => t.id === brigadeTableId("wk", "2026-08-31", "dinner")));
});

test("a skip carries through regeneration; the composer plans around it", () => {
  const first = planBrigadeWeek({ tables: [] }, BRIGADE, wayneCtx());
  const skewed = {
    ...first.events,
    tables: first.events.tables.map((t) =>
      t.date === "2026-09-01" && t.slot === "dinner"
        ? { ...t, seats: t.seats.map((s) => (s.id === "elliot" ? { ...s, status: "skipped" } : s)) }
        : t,
    ),
  };
  const re = planBrigadeWeek(skewed, BRIGADE, wayneCtx({ regenerate: true }));
  const t = re.events.tables.find((x) => x.date === "2026-09-01" && x.slot === "dinner");
  assert.equal(t.seats.find((s) => s.id === "elliot")?.status, "skipped", "the decline survives");
});

test("a member's own pinned entry takes them off that slot's pot for the day", () => {
  const plan = {
    week: "2026-W36",
    entries: [
      { id: "x1", date: "2026-09-02", slot: "dinner", recipeId: "din-pasta", servings: 1, pinned: true },
    ],
  };
  const ctx = wayneCtx({ plansById: new Map([["elliot", plan]]) });
  const { report } = planBrigadeWeek({ tables: [] }, BRIGADE, ctx);
  const row = report.find((r) => r.date === "2026-09-02" && r.seatId === "elliot");
  assert.ok(row, "elliot still gets a day report");
  assert.equal(row.status, "band", "his pinned dinner counts as covered and the rest lands");
});

test("TARANOWSKI SHAPE: three seats with a 1.9x spread never lose a day (Red Team block)", () => {
  const mom = { macros: { calories: 1550, caloriesFloor: 1350, protein: 95 } };
  const dad = { macros: { calories: 2900, caloriesFloor: 2700, protein: 150 } };
  const laurie = { macros: { calories: 2000, caloriesFloor: 1800, protein: 110 } };
  const profiles = new Map([
    ["mom", { id: "mom", household: "t" }],
    ["dad", { id: "dad", household: "t" }],
    ["laurie", { id: "laurie", household: "t" }],
  ]);
  const brigade = {
    id: "fam",
    name: "Family table",
    memberIds: ["mom", "dad", "laurie"],
    slots: ["breakfast", "dinner"],
    from: "2026-08-31",
    until: "2026-09-27",
  };
  const { events, report } = planBrigadeWeek({ tables: [] }, brigade, {
    dates: DATES,
    today: "2026-08-31",
    house: "t",
    profilesById: profiles,
    targetsById: new Map([
      ["mom", mom],
      ["dad", dad],
      ["laurie", laurie],
    ]),
    plansById: new Map(),
    bankById,
  });
  assert.equal(events.tables.length, DATES.length * 2, "every day materializes — no whole-day refusals");
  for (const row of report) {
    const t = { mom, dad, laurie }[row.seatId];
    assert.ok(
      row.dayKcal <= t.macros.calories + 100,
      `${row.seatId} ${row.date} never lands crazy over (${row.dayKcal})`,
    );
  }
});

test("PROPERTY: 12 randomized weeks, every strict seat verdict is arithmetically true", () => {
  // seeded LCG so a failure reproduces
  let seed = 20260830;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let week = 0; week < 12; week++) {
    const targetsA = {
      macros: {
        calories: 2200 + Math.round(rand() * 1800),
        protein: 120 + Math.round(rand() * 90),
      },
    };
    const targetsB = {
      macros: {
        calories: 1600 + Math.round(rand() * 1600),
        protein: 90 + Math.round(rand() * 70),
      },
    };
    const covered = { calories: Math.round(rand() * 1300), protein: Math.round(rand() * 90) };
    const seats = [
      { id: "a", targets: targetsA, bands: seatBands(targetsA, covered) },
      { id: "b", targets: targetsB, bands: seatBands(targetsB, { calories: 0, protein: 0 }) },
    ];
    const slots = ["breakfast", "smoothie", "snack", "dinner"];
    const pools = {
      breakfast: BANK.filter((r) => r.mealType === "breakfast"),
      smoothie: BANK.filter((r) => r.mealType === "smoothie"),
      snack: BANK.filter((r) => r.mealType === "snack"),
      dinner: BANK.filter((r) => r.mealType === "dinner"),
    };
    const start = Object.fromEntries(
      slots.map((s) => {
        const pool = pools[s];
        return [s, pool[Math.floor(rand() * pool.length)]];
      }),
    );
    const out = composeDay({ slots, poolsBySlot: pools, startBySlot: start, seats });
    assert.ok(out, `week ${week}: a day always composes`);
    for (const seat of seats) {
      const got = out.seats[seat.id];
      assert.ok(got, `week ${week}: seat ${seat.id} served`);
      const b = seat.bands;
      // the caps are hard for every verdict EXCEPT an explicit "over" —
      // graduated acceptance feeds a seat too small for the tiniest plate
      // and says so, never silently (the status must then be truthful)
      if (got.status === "over") {
        assert.ok(
          got.kcal > b.kcalHi || got.protein > b.pHi,
          `week ${week} ${seat.id}: an "over" verdict must actually be over`,
        );
      } else {
        assert.ok(got.protein <= b.pHi, `week ${week} ${seat.id}: ceiling holds (${got.protein} <= ${b.pHi})`);
        assert.ok(got.kcal <= b.kcalHi, `week ${week} ${seat.id}: +100 cap holds`);
      }
      if (got.status === "band") {
        assert.ok(got.kcal >= b.kcalLo, `week ${week} ${seat.id}: strict floor true`);
        assert.ok(got.protein >= b.pLo, `week ${week} ${seat.id}: strict protein true`);
      }
      if (got.status === "floor") {
        assert.ok(got.kcal >= b.kcalFloorLo, `week ${week} ${seat.id}: floor verdict true`);
      }
    }
  }
});

test("SHADOW SWEEP: stale week-run tables in the brigade's span are cleared, hand-set survive", () => {
  const stale = DATES.flatMap((date, i) => [
    {
      id: `wk-run-${i}a`,
      name: "Family smoothie",
      date,
      slot: "smoothie",
      recipeId: "smo-mango",
      fromWeekRun: true,
      seats: [{ id: "david", servings: 1 }, { id: "elliot", servings: 1 }],
    },
    {
      id: `wk-run-${i}b`,
      name: "Family dinner",
      date,
      slot: "dinner",
      recipeId: "din-soup",
      seats: [{ id: "david", servings: 1 }, { id: "elliot", servings: 1 }],
    },
  ]);
  const handSet = {
    id: "hand-1",
    name: "Birthday dinner",
    date: "2026-09-03",
    slot: "dinner",
    recipeId: "din-gyros",
    seats: [{ id: "david", servings: 1 }, { id: "elliot", servings: 1 }],
  };
  const { events } = planBrigadeWeek({ tables: [...stale, handSet] }, BRIGADE, wayneCtx());
  assert.ok(
    !events.tables.some((t) => String(t.id).startsWith("wk-run-")),
    "every stale fromWeekRun / Family-named table in the span is gone",
  );
  assert.ok(
    events.tables.some((t) => t.id === "hand-1"),
    "the hand-set table survives the sweep",
  );
});

test("a blocked seat is written SKIPPED with auto, so the cook never buys its plate", () => {
  const plan = {
    week: "2026-W36",
    entries: [
      { id: "x1", date: "2026-09-02", slot: "dinner", recipeId: "din-pasta", servings: 1, pinned: true },
    ],
  };
  const { events } = planBrigadeWeek(
    { tables: [] },
    BRIGADE,
    wayneCtx({ plansById: new Map([["elliot", plan]]) }),
  );
  const t = events.tables.find((x) => x.date === "2026-09-02" && x.slot === "dinner");
  const seat = t?.seats.find((s) => s.id === "elliot");
  assert.equal(seat?.status, "skipped", "his own pinned dinner takes him off the pot");
  assert.equal(/** @type {any} */ (seat)?.auto, true, "machine-stamped, so it recomputes");
  // and once the pin is gone, the next regenerate re-seats him
  const again = planBrigadeWeek(events, BRIGADE, wayneCtx({ regenerate: true }));
  const t2 = again.events.tables.find((x) => x.date === "2026-09-02" && x.slot === "dinner");
  assert.notEqual(t2?.seats.find((s) => s.id === "elliot")?.status, "skipped");
});

test("an edited: true seat binds the composer while the dish is unchanged, and ONLY then", () => {
  const first = planBrigadeWeek({ tables: [] }, BRIGADE, wayneCtx());
  const target = first.events.tables.find((t) => t.date === "2026-09-01" && t.slot === "dinner");
  assert.ok(target);
  const withEdit = {
    ...first.events,
    tables: first.events.tables.map((t) =>
      t.id === target.id
        ? {
            ...t,
            seats: t.seats.map((s) =>
              s.id === "david" ? { ...s, servings: 2, edited: true } : s,
            ),
          }
        : t,
    ),
  };
  const re = planBrigadeWeek(withEdit, BRIGADE, wayneCtx({ regenerate: true }));
  const t2 = re.events.tables.find((x) => x.id === target.id);
  if (t2?.recipeId === target.recipeId) {
    assert.equal(t2.seats.find((s) => s.id === "david")?.servings, 2, "the edit binds");
    assert.equal(
      /** @type {any} */ (t2.seats.find((s) => s.id === "david"))?.edited,
      true,
      "and the marker carries",
    );
  } else {
    assert.notEqual(
      t2?.seats.find((s) => s.id === "david")?.servings,
      2,
      "a swapped dish drops the old portion — 2 servings of chili is not 2 of a lasagna",
    );
  }
  // an untouched machine seat never binds: regeneration re-solves it
  const clean = planBrigadeWeek(first.events, BRIGADE, wayneCtx({ regenerate: true }));
  const report = clean.report.filter((r) => r.seatId === "david");
  assert.ok(
    report.every((r) => r.status === "band"),
    "regenerating an untouched week still lands every day",
  );
});

test("a seat with no usable targets gets a NAMED report row, never silence", () => {
  const ctx = wayneCtx({
    targetsById: new Map([
      ["david", davidTargets],
      ["elliot", { macros: { calories: 0 } }],
    ]),
  });
  const { report } = planBrigadeWeek({ tables: [] }, BRIGADE, ctx);
  const rows = report.filter((r) => r.seatId === "elliot");
  assert.ok(rows.length > 0, "elliot appears in the report");
  assert.ok(
    rows.every((r) => r.status === "no-targets"),
    "and is named as having no targets, not claimed in-band",
  );
});
