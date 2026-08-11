// The transform (per-person-plates-design §4-§6). Every test here pins a
// spec rule that a review found breakable without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MACRO, PLATE_GRAMS, partOf, solveSeat, synthesize } from "../app/lib/synth.js";

const RECIPE = {
  id: "chicken-rice",
  servings: 3,
  assembly: "plated",
  nutrition: { calories: 600, protein: 45 },
  ingredients: [
    { food: "chicken breast", qty: 450, unit: "g" },
    { food: "rice", qty: 3, unit: "cup" },
    { food: "broccoli", qty: 300, unit: "g" },
    { food: "olive oil", qty: 2, unit: "tbsp" },
  ],
};
const TARGETS = {
  phase: "loss",
  mealSlots: ["breakfast", "lunch", "dinner"],
  macros: { calories: 1550, protein: 110 },
};
const SLOT_SHARE = 1.3 / 3.45; // dinner over b/l/d

const seat = (s, raw = s) => ({ id: "p", servings: s, rawServings: raw });

test("rung 0: no tag = uniform = today. THE ROLLOUT MECHANISM", () => {
  const r = solveSeat({ recipe: { ...RECIPE, assembly: undefined }, assembly: undefined, seat: seat(1), targets: TARGETS, slotShare: SLOT_SHARE });
  assert.equal(r.synthMode, "uniform");
  assert.equal(r.alpha, 1);
  assert.equal(r.beta, 1);
});

test("rung 0f: A SHOPPED WEEK IS FROZEN (David's rule), tags or no tags", () => {
  const r = solveSeat({ recipe: RECIPE, assembly: "plated", seat: seat(1), targets: TARGETS, slotShare: SLOT_SHARE, weekShopped: true });
  assert.equal(r.synthMode, "uniform");
  assert.equal(r.rung, "0f-week-shopped");
});

test("solve identity: exact targets return alpha = beta = 1", () => {
  // C* = sigma x per-serving calories, P* likewise -> (1,1) exactly
  const sigma = 1.5;
  const t = {
    phase: "recomp",
    mealSlots: ["dinner"],
    macros: { calories: (sigma * 600) / 3, protein: (sigma * 45) / 3 },
  };
  const r = solveSeat({ recipe: RECIPE, assembly: "plated", seat: seat(1.5, sigma), targets: t, slotShare: 1 });
  assert.equal(r.synthMode, "solved");
  assert.ok(Math.abs(r.alpha - 1) < 1e-9, `alpha ${r.alpha}`);
  assert.ok(Math.abs(r.beta - 1) < 1e-9, `beta ${r.beta}`);
});

test("SCALE INVARIANCE: the whole MACRO table x1.15 changes nothing (§4.4's own claim)", () => {
  const before = solveSeat({ recipe: RECIPE, assembly: "plated", seat: seat(0.75), targets: TARGETS, slotShare: SLOT_SHARE });
  const keys = Object.keys(MACRO);
  const saved = keys.map((k) => [...MACRO[k]]);
  try {
    for (const k of keys) {
      MACRO[k][0] *= 1.15;
      MACRO[k][1] *= 1.15;
    }
    const after = solveSeat({ recipe: RECIPE, assembly: "plated", seat: seat(0.75), targets: TARGETS, slotShare: SLOT_SHARE });
    assert.equal(after.alpha, before.alpha);
    assert.equal(after.beta, before.beta);
  } finally {
    keys.forEach((k, i) => {
      MACRO[k][0] = saved[i][0];
      MACRO[k][1] = saved[i][1];
    });
  }
});

test("CATEGORY BANDS: the drafted table cannot hallucinate outside physical ranges", () => {
  const bands = [
    [["chicken", "turkey", "beef", "salmon", "pork", "steak", "cod", "tilapia", "shrimp", "tuna"], 15, 35],
    [["rice", "farro", "quinoa", "couscous", "pasta", "barley", "bulgur"], 2, 6],
    [["lentils", "chickpeas", "beans", "black beans"], 5, 10],
  ];
  for (const [foods, lo, hi] of bands) {
    for (const f of foods) {
      const key = Object.keys(MACRO).find((k) => k === f || k.includes(f));
      if (!key) continue;
      const p = MACRO[key][1];
      assert.ok(p >= lo && p <= hi, `${key} protein ${p} outside [${lo}, ${hi}]`);
    }
  }
  for (const k of Object.keys(MACRO)) {
    assert.ok(MACRO[k][0] > 0 && MACRO[k][1] >= 0, `${k} has a nonsense entry`);
  }
});

test("fat rule: in-pan oil is flavor; a plated drizzle is carbfat", () => {
  assert.equal(partOf({ food: "olive oil" }), "flavor");
  assert.equal(partOf({ food: "olive oil", atPlating: true }), "carbfat");
  assert.equal(partOf({ food: "unknown mystery item" }), "flavor");
  assert.equal(partOf({ food: "chicken thigh" }), "protein");
});

test("manual override: a hand-edited seat makes the human's number the target", () => {
  // stored servings 3 cannot come from raw 1.2 (round/clamp gives 1.25),
  // so sigma := s_p and the solve targets the HUMAN's amount (§4.3)
  const r = solveSeat({ recipe: RECIPE, assembly: "plated", seat: { id: "p", servings: 3, rawServings: 1.2 }, targets: TARGETS, slotShare: SLOT_SHARE });
  assert.equal(r.synthMode, "solved");
  // sigma := s_p means the target side divides by the HUMAN's 3, so plate
  // and target are consistent: either the solve lands clean (no hit line
  // needed, it worked) or a clamp/cap binds and hit reports honestly.
  // What must NEVER happen is the v1 bug: composition solved for 1.2
  // servings riding a 3-serving plate. That composite is what the caps
  // bound, checked in the kilogram-of-chicken test below.
  assert.ok(r.rung === "solved" || r.hit, "bound solves must report achieved-vs-target");
});

test("degenerate single-bucket dish goes uniform with a spoken note", () => {
  const soup = {
    ...RECIPE,
    ingredients: [{ food: "lentils", qty: 4, unit: "cup" }],
  };
  const r = solveSeat({ recipe: soup, assembly: "plated", seat: seat(1), targets: TARGETS, slotShare: SLOT_SHARE });
  assert.equal(r.synthMode, "uniform");
  assert.match(r.note ?? "", /one thing nutritionally/);
});

test("rung 0b: an unbridged or all-flavor dish cannot divide by zero", () => {
  const mystery = { ...RECIPE, ingredients: [{ food: "mystery paste", qty: 2, unit: "jar" }] };
  const r = solveSeat({ recipe: mystery, assembly: "plated", seat: seat(1), targets: TARGETS, slotShare: SLOT_SHARE });
  assert.equal(r.synthMode, "uniform");
  assert.ok(Number.isFinite(r.alpha));
});

test("rung 4: unreadable targets degrade THAT seat to uniform", () => {
  const r = solveSeat({ recipe: RECIPE, assembly: "plated", seat: seat(1), targets: null, slotShare: SLOT_SHARE });
  assert.equal(r.synthMode, "uniform");
  assert.equal(r.rung, "4-no-targets");
});

test("plate caps are absolute and never silently off (kilogram-of-chicken)", () => {
  const gain = { phase: "gain", mealSlots: ["dinner"], macros: { calories: 5000, protein: 400 } };
  const r = solveSeat({ recipe: RECIPE, assembly: "plated", seat: { id: "p", servings: 10, rawServings: 10 }, targets: gain, slotShare: 1 });
  if (r.synthMode === "solved" && r.hit) {
    assert.ok(r.hit.protein <= 100 + 1, `plate protein ${r.hit.protein} breached the default cap`);
  }
});

test("synthesize: POT PRESERVES ROW IDENTITY (§4.8) and uniform mode is today's arithmetic", () => {
  const targetsById = new Map([["a", TARGETS], ["b", null]]);
  const out = synthesize({
    recipe: { ...RECIPE, assembly: undefined },
    seats: [
      { id: "a", servings: 1.5 },
      { id: "b", servings: 1 },
    ],
    targetsById,
    slotShares: { a: SLOT_SHARE, b: SLOT_SHARE },
  });
  assert.equal(out.synthMode, "uniform");
  assert.equal(out.rows.length, RECIPE.ingredients.length);
  out.rows.forEach((row, i) => {
    assert.equal(row.food, RECIPE.ingredients[i].food, "same food, same order");
    assert.equal(row.unit, RECIPE.ingredients[i].unit, "same unit");
  });
  // uniform pot = per-serving x total servings, the exact arithmetic today
  const chicken = out.rows[0];
  assert.ok(Math.abs(chicken.raw - (450 / 3) * 2.5) < 1e-9);
});

test("synthesize: a solved seat moves composition and the pot is the sum of plates", () => {
  const targetsById = new Map([["mom", TARGETS], ["kid", null]]);
  const out = synthesize({
    recipe: RECIPE,
    seats: [
      { id: "mom", servings: 0.75, rawServings: 0.77 },
      { id: "kid", servings: 1 },
    ],
    targetsById,
    slotShares: { mom: SLOT_SHARE, kid: SLOT_SHARE },
  });
  assert.equal(out.synthMode, "solved");
  for (const row of out.rows) {
    const sum = Object.values(row.perSeat).reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(sum - row.raw) < Math.max(0.01 * row.raw, 0.01) + 1e-9, `${row.food} pot != sum of plates`);
  }
  // flavor rows ride appetite only, never a knob (§4.8)
  const oil = out.rows.find((r) => r.food === "olive oil");
  assert.ok(Math.abs(oil.perSeat.mom - (2 / 3) * 0.75) < 1e-9, "flavor scaled by s_p only");
});

test("PLATE_GRAMS entries are physically plausible", () => {
  for (const [food, units] of Object.entries(PLATE_GRAMS)) {
    for (const [unit, g] of Object.entries(units)) {
      assert.ok(g >= 5 && g <= 600, `${food} ${unit} = ${g} g is not a real kitchen quantity`);
    }
  }
});

// ---- frozen pot (spec §10) ----
import { freezePotString, parsePot, recipeRevOf } from "../app/lib/synth.js";
import { setTablePot, setTableSameForEveryone } from "../app/lib/tables.js";

test("freezePotString: uniform tables freeze NOTHING (the inert-deploy guarantee)", () => {
  const s = freezePotString({
    recipe: { ...RECIPE, assembly: undefined },
    seats: [{ id: "a", servings: 1 }],
    targetsById: new Map([["a", TARGETS]]),
    slotShares: { a: SLOT_SHARE },
  });
  assert.equal(s, null);
});

test("freezePotString: a solved table freezes rows + fingerprint; parsePot round-trips", () => {
  const s = freezePotString({
    recipe: RECIPE,
    seats: [{ id: "a", servings: 0.75, rawServings: 0.77 }],
    targetsById: new Map([["a", TARGETS]]),
    slotShares: { a: SLOT_SHARE },
    targetShas: { a: "sha-abc" },
  });
  assert.ok(s);
  const pot = parsePot(s, RECIPE);
  assert.ok(pot);
  assert.equal(pot.rows.length, RECIPE.ingredients.length);
  assert.equal(JSON.parse(s).inputs.recipeRev, recipeRevOf(RECIPE));
  assert.equal(JSON.parse(s).inputs.targets.a, "sha-abc");
});

test("freezePotString respects the SHOPPED-WEEK FREEZE", () => {
  const s = freezePotString({
    recipe: RECIPE,
    seats: [{ id: "a", servings: 0.75, rawServings: 0.77 }],
    targetsById: new Map([["a", TARGETS]]),
    slotShares: { a: SLOT_SHARE },
    weekShopped: true,
  });
  assert.equal(s, null, "a bought week can never grow a pot");
});

test("parsePot refuses corruption: permuted rows, NaN, merge keys, junk JSON", () => {
  const good = freezePotString({
    recipe: RECIPE,
    seats: [{ id: "a", servings: 0.75, rawServings: 0.77 }],
    targetsById: new Map([["a", TARGETS]]),
    slotShares: { a: SLOT_SHARE },
  });
  const pot = JSON.parse(good);
  const swapped = { ...pot, rows: [pot.rows[1], pot.rows[0], ...pot.rows.slice(2)] };
  assert.equal(parsePot(JSON.stringify(swapped), RECIPE), null, "a PERMUTED pot must not pass");
  const nan = { ...pot, rows: pot.rows.map((r, i) => (i === 0 ? { ...r, qty: NaN } : r)) };
  assert.equal(parsePot(JSON.stringify(nan), RECIPE), null);
  const keyed = { ...pot, rows: pot.rows.map((r, i) => (i === 0 ? { ...r, id: "x" } : r)) };
  assert.equal(parsePot(JSON.stringify(keyed), RECIPE), null, "merge-keyed rows re-open the union bug");
  assert.equal(parsePot("{oops", RECIPE), null, "malformed JSON drops the pot, never throws");
  assert.equal(parsePot(undefined, RECIPE), null);
});

test("sameForEveryone DROPS the frozen pot (loop-2 N9)", () => {
  const base = {
    tables: [{ id: "t1", name: "x", date: "2026-09-10", slot: "dinner", recipeId: "chicken-rice", seats: [{ id: "a", servings: 1 }], pot: '{"synthMode":"solved","rows":[]}' }],
  };
  const off = setTableSameForEveryone(base, "t1", true, "2026-09-01");
  assert.equal(off.tables[0].pot, undefined, "a solved pot must not drive the buy under the opt-out flag");
});

test("setTablePot writes and clears atomically-mergeable strings", () => {
  const base = { tables: [{ id: "t1", name: "x", date: "2026-09-10", slot: "dinner", recipeId: "r", seats: [{ id: "a", servings: 1 }] }] };
  const withPot = setTablePot(base, "t1", '{"synthMode":"solved"}', "2026-09-01");
  assert.equal(typeof withPot.tables[0].pot, "string");
  const cleared = setTablePot(withPot, "t1", null, "2026-09-01");
  assert.ok(!("pot" in cleared.tables[0]), "absent, not null, per SCHEMAS convention");
});

// ---- reviewer-required coverage: shopping potRows + brigade carry ----
import { deriveShoppingList } from "../app/lib/shopping.js";
import { materializeBrigade } from "../app/lib/tables.js";

test("deriveShoppingList: frozen potRows are ABSOLUTE and ident-canonicalized (N13)", () => {
  const bank = new Map([["chicken-rice", { ...RECIPE, assembly: undefined }]]);
  const plan = {
    week: "2026-W37",
    entries: [
      {
        recipeId: "chicken-rice",
        date: "2026-09-10",
        servings: 2.5,
        potFromBank: true,
        potRows: [
          { food: "chicken breast", unit: "g", qty: 500 },
          { food: "rice", unit: "cup", qty: 2.25 },
          { food: "broccoli", unit: "g", qty: 250 },
          { food: "olive oil", unit: "tbsp", qty: 1.67 },
        ],
      },
    ],
  };
  const list = deriveShoppingList(plan, bank, { staples: [], perishables: [] }, { items: [] }, undefined, undefined, bank);
  const chicken = list.items.find((i) => i.food.toLowerCase().includes("chicken"));
  assert.ok(chicken, "pot row reached the list");
  // ABSOLUTE: 500 g, never 500 x (servings / recipe.servings)
  const grams = chicken.unit === "kg" ? chicken.qty * 1000 : chicken.qty;
  assert.ok(Math.abs(grams - 500) < 1, `expected 500 g, got ${chicken.qty} ${chicken.unit}`);
});

test("materializeBrigade carries pot + rawServings ONLY while the dish is unchanged", () => {
  const targets = new Map([["a", TARGETS], ["b", TARGETS]]);
  const profiles = new Map([
    ["a", { id: "a", household: "h" }],
    ["b", { id: "b", household: "h" }],
  ]);
  const brigade = { id: "b1", name: "x", memberIds: ["a", "b"], slots: ["dinner"], cookId: "a", from: "2026-09-07", until: "2026-09-13" };
  const bank = new Map([["chicken-rice", { ...RECIPE, mealType: "dinner", assembly: undefined }]]);
  const ctx = { dates: ["2026-09-08"], today: "2026-09-07", house: "h", profilesById: profiles, targetsById: targets, bankById: bank };
  const first = materializeBrigade({ tables: [] }, brigade, ctx).events;
  const t0 = first.tables[0];
  assert.ok(typeof t0.seats[0].rawServings === "number", "rawServings stored with servings");
  const marked = { ...first, tables: first.tables.map((t) => ({ ...t, pot: '{"synthMode":"solved","rows":[]}' })) };
  const regen = materializeBrigade(marked, brigade, { ...ctx, regenerate: true }).events;
  assert.equal(regen.tables[0].pot, '{"synthMode":"solved","rows":[]}', "same dish: pot carries");
  const swapped = materializeBrigade(marked, brigade, { ...ctx, regenerate: true, bankById: new Map([["other", { ...RECIPE, id: "other", mealType: "dinner" }]]) }).events;
  assert.equal(swapped.tables[0].pot, undefined, "swapped dish: a stale pot must NOT follow");
});
