// Stress checks (2026-08-07): the app at family scale and against dirty data.
// Scenarios: 500+ item pantries, 10+ profiles, cross-profile diet conflicts,
// malformed/partial JSON from the data repo, and the Laurie-incident class
// (concurrent profile edits: id-targeted patch vs whole-array write).
import test from "node:test";
import assert from "node:assert/strict";

// store.js and github.js touch localStorage at call time — stub before import,
// same pattern as store.test.js.
/** @type {Map<string, string>} */
const kv = new Map();
globalThis.localStorage = /** @type {any} */ ({
  getItem: (/** @type {string} */ k) => kv.get(k) ?? null,
  setItem: (/** @type {string} */ k, /** @type {string} */ v) => kv.set(k, String(v)),
  removeItem: (/** @type {string} */ k) => kv.delete(k),
});

const { normalizePantry, deriveShoppingList, mergeProfileLists, slug } =
  await import("../app/lib/shopping.js");
const { generateWeek } = await import("../app/lib/weekbuilder.js");
const { mergeRecipePool, recipeConflicts, recipesById } = await import("../app/lib/plan.js");
const { brigadePool } = await import("../app/lib/tables.js");
const { patchProfiles } = await import("../app/lib/store.js");
const { pushFile, ConflictError } = await import("../app/lib/sync.js");
const { readFile } = await import("../app/lib/github.js");

/** @returns {Record<string, any>} */
const mkRecipe = (
  /** @type {string} */ id,
  /** @type {string} */ mealType,
  /** @type {number} */ calories,
  /** @type {number} */ protein,
  /** @type {string[]} */ foods,
  /** @type {Record<string, any>} */ extra = {},
) => ({
  id,
  name: id,
  mealType,
  servings: 1,
  nutrition: { calories, protein },
  ingredients: foods.map((f) => ({ qty: 100, unit: "g", food: f })),
  foodGroups: {},
  tags: [],
  ...extra,
});

/** A realistic mixed bank: 20 dinners, 12 lunches, 8 breakfasts, 4 smoothies, 8 snacks. */
function bigBank() {
  /** @type {Record<string, any>[]} */
  const out = [];
  for (let i = 0; i < 20; i++) {
    out.push(
      mkRecipe(`din-${i}`, "dinner", 700 + (i % 5) * 50, 40 + (i % 4) * 5, [
        `protein-${i % 6}`,
        `veg-${i % 8}`,
        `grain-${i % 4}`,
      ]),
    );
  }
  for (let i = 0; i < 12; i++) {
    out.push(
      mkRecipe(`lun-${i}`, "lunch", 600 + (i % 4) * 40, 35, [`protein-${i % 6}`, `veg-${i % 8}`]),
    );
  }
  for (let i = 0; i < 8; i++) {
    out.push(mkRecipe(`brk-${i}`, "breakfast", 450, 25, [`grain-${i % 4}`, `fruit-${i % 3}`]));
  }
  for (let i = 0; i < 4; i++) {
    out.push(mkRecipe(`smo-${i}`, "smoothie", 300, 20, [`fruit-${i % 3}`, "milk"]));
  }
  for (let i = 0; i < 8; i++) {
    out.push(
      mkRecipe(`snk-${i}`, "snack", 250 + (i % 3) * 50, 15 + (i % 3) * 5, [`nut-${i % 3}`], {
        tags: ["make-ahead"],
      }),
    );
  }
  return out;
}

const TARGETS = {
  macros: { calories: 3400, protein: 210 },
  dailyDozen: { greens: 2, cruciferousVeg: 1, beans: 3 },
};

// ---------------------------------------------------------------------------
// A. Large pantry (500+ items)
// ---------------------------------------------------------------------------

test("stress: normalizePantry heals 600 legacy perishables deterministically and fast", () => {
  const perishables = [];
  for (let i = 0; i < 600; i++) {
    // every third row is a "twin" (same content, no id) — the duplicate case
    // the twin-index scheme exists for
    perishables.push({ food: `food-${i % 200}`, qty: "1 lb", added: "2026-08-01" });
  }
  const t0 = performance.now();
  const a = normalizePantry({ staples: [], perishables });
  const b = normalizePantry({ staples: [], perishables });
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 1000, `normalizePantry took ${elapsed}ms for 2x600 rows`);
  assert.deepEqual(a, b, "two devices healing the same pantry must agree");
  const ids = a.perishables.map((/** @type {any} */ p) => p.id);
  assert.equal(new Set(ids).size, 600, "every healed perishable id is unique");
});

test("stress: deriveShoppingList stays correct and fast against a 500+ item pantry", () => {
  const staples = [];
  for (let i = 0; i < 300; i++) {
    staples.push({
      id: `staple-${i}`,
      name: `staple-food-${i}`,
      onHand: i % 2 === 0,
      runningLow: i % 50 === 0,
    });
  }
  const pantry = {
    staples,
    perishables: Array.from({ length: 250 }, (_, i) => ({
      id: `p-${i}`,
      food: `perish-${i}`,
      qty: "1 lb",
      location: "fridge",
      group: "other",
    })),
  };
  const bank = bigBank();
  const byId = recipesById(bank);
  const entries = [];
  let n = 0;
  for (const r of bank.slice(0, 35)) {
    entries.push({
      id: `e${n}`,
      date: `2026-09-${String(28 - (n % 7)).padStart(2, "0")}`,
      slot: r.mealType,
      recipeId: r.id,
      servings: 1,
    });
    n++;
  }
  const t0 = performance.now();
  const list = deriveShoppingList({ week: "2026-W40", entries }, byId, pantry, null);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 1000, `deriveShoppingList took ${elapsed}ms`);
  assert.ok(list.items.length > 0, "the week still shops its ingredients");
  // no shopped row may name an onHand (not running-low) staple
  const onHand = new Set(staples.filter((s) => s.onHand && !s.runningLow).map((s) => slug(s.name)));
  for (const item of list.items) {
    assert.ok(!onHand.has(slug(item.food)), `${item.food} is onHand and must not be bought`);
  }
});

test("stress: generateWeek completes quickly with a 550-perishable pantry", () => {
  const pantry = {
    staples: [],
    perishables: Array.from({ length: 550 }, (_, i) => ({
      id: `p-${i}`,
      food: `perish-food-${i}`,
      qty: "1 lb",
      location: "fridge",
      group: "other",
      useSoon: i % 10 === 0, // 55 use-soon needles
    })),
  };
  const t0 = performance.now();
  const { plan, report } = generateWeek({
    recipes: bigBank(),
    targets: TARGETS,
    pantry,
    weekId: "2026-W40",
    plan: { week: "2026-W40", entries: [] },
  });
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 5000, `generateWeek took ${elapsed}ms with a 550-item pantry`);
  const dinners = plan.entries.filter((e) => e.slot === "dinner");
  assert.equal(dinners.length, 7, "all 7 dinners planned");
  assert.ok(report, "report produced");
});

// ---------------------------------------------------------------------------
// B. Many profiles (10+)
// ---------------------------------------------------------------------------

const FOURTEEN = Array.from({ length: 14 }, (_, i) => ({
  id: `p${i}`,
  name: `Person ${i}`,
  emoji: "🙂",
  phase: "maintain",
}));

test("stress: patchProfiles touches ONLY the targeted profile among 14 (Laurie-class)", async () => {
  /** @type {Record<string, any> | null} */
  let written = null;
  const ok = await patchProfiles(
    (profiles) => profiles.map((p) => (p.id === "p7" ? { ...p, emoji: "🧑‍🍳" } : p)),
    {
      readCached: async () => ({ data: { profiles: FOURTEEN }, sha: "s1" }),
      writeFn: async (path, data) => {
        written = data;
      },
    },
  );
  assert.equal(ok, true);
  const out = /** @type {any} */ (written).profiles;
  assert.equal(out.length, 14, "no profile lost");
  assert.equal(out[7].emoji, "🧑‍🍳");
  for (let i = 0; i < 14; i++) {
    if (i !== 7) assert.deepEqual(out[i], FOURTEEN[i], `p${i} untouched`);
  }
});

test("stress: concurrent profile edits on two devices merge without losing anyone", async () => {
  // base: 14 profiles. Local device renames p3. Remote device (already on
  // GitHub) added p14b and changed p7's phase. The 409 path must keep all
  // three changes and all 15 people.
  const base = { profiles: FOURTEEN };
  const local = {
    profiles: FOURTEEN.map((p) => (p.id === "p3" ? { ...p, name: "Laurie" } : p)),
  };
  const remote = {
    profiles: [
      ...FOURTEEN.map((p) => (p.id === "p7" ? { ...p, phase: "gain" } : p)),
      { id: "p14b", name: "New Cousin", emoji: "🆕", phase: "maintain" },
    ],
  };
  let writes = 0;
  const io = {
    read: async () => ({ data: remote, sha: "sha-remote" }),
    write: async (/** @type {string} */ _path, /** @type {any} */ data, /** @type {any} */ sha) => {
      writes++;
      if (writes === 1) throw new ConflictError("profiles.json"); // stale sha
      assert.equal(sha, "sha-remote", "retry carries the re-fetched sha");
      return { sha: "sha-new", data };
    },
  };
  const pushed = await pushFile(io, {
    path: "profiles.json",
    data: local,
    base,
    sha: "sha-stale",
  });
  const merged = /** @type {any} */ (pushed.data).profiles;
  assert.equal(merged.length, 15, "all 15 profiles survive the merge");
  assert.equal(merged.find((/** @type {any} */ p) => p.id === "p3").name, "Laurie");
  assert.equal(merged.find((/** @type {any} */ p) => p.id === "p7").phase, "gain");
  assert.ok(merged.some((/** @type {any} */ p) => p.id === "p14b"));
});

test("stress: mergeProfileLists combines 12 profiles' lists into one honest trip", () => {
  const lists = Array.from({ length: 12 }, (_, i) => ({
    profileId: `p${i}`,
    list: {
      items: [
        // everyone wants broccoli; only p0 has ticked it
        {
          id: "broccoli",
          food: "broccoli",
          qty: 1,
          unit: "head",
          section: "produce",
          checked: i === 0,
          manual: false,
        },
        {
          id: `only-p${i}`,
          food: `special-${i}`,
          qty: 1,
          unit: "x",
          section: "other",
          checked: false,
          manual: false,
        },
      ],
    },
  }));
  const combined = mergeProfileLists(lists);
  const broccoli = combined.find((i) => i.id === "broccoli");
  assert.ok(broccoli);
  assert.equal(broccoli.qty, 12, "quantities sum across all 12 profiles");
  assert.equal(broccoli.sources.length, 12);
  assert.ok(
    !broccoli.sources.every((s) => s.checked),
    "half-bought is not bought: one tick of twelve does not read checked",
  );
  assert.equal(combined.length, 13, "12 personal items + 1 shared");
});

// ---------------------------------------------------------------------------
// C. Conflicting diets / avoid lists across profiles
// ---------------------------------------------------------------------------

test("stress: brigadePool intersection empties HONESTLY when member screens conflict", () => {
  const bank = new Map(
    [
      mkRecipe("beef-stew", "dinner", 700, 45, ["beef", "carrot"]),
      mkRecipe("tofu-onion", "dinner", 600, 30, ["tofu", "onion"]),
      mkRecipe("lentil-bowl", "dinner", 650, 32, ["lentils", "spinach"]),
    ].map((r) => [r.id, r]),
  );
  const vegan = { id: "a", diet: "vegan" };
  const noOnionNoLentil = { id: "b", avoid: ["onion", "lentil"] };
  // vegan kills beef-stew; b's avoids kill tofu-onion and lentil-bowl
  assert.deepEqual(brigadePool(bank, [vegan, noOnionNoLentil], "dinner"), []);
  // sanity: relax one screen and the intersection reopens
  const pool = brigadePool(bank, [vegan, { id: "b", avoid: ["onion"] }], "dinner");
  assert.deepEqual(
    pool.map((r) => r.id),
    ["lentil-bowl"],
  );
});

test("stress: two profiles, one bank, conflicting avoid lists — neither plan leaks a banned food", () => {
  const bank = bigBank();
  const profiles = [
    { id: "a", avoid: ["protein-0", "protein-1"], diet: undefined },
    { id: "b", avoid: ["veg-2"], diet: "vegetarian" },
  ];
  for (const prof of profiles) {
    const pool = mergeRecipePool(bank, [], undefined, prof.avoid, prof.diet);
    const { plan } = generateWeek({
      recipes: pool,
      targets: { ...TARGETS, avoidIngredients: prof.avoid },
      pantry: { staples: [], perishables: [] },
      weekId: "2026-W41",
      plan: { week: "2026-W41", entries: [] },
    });
    const byId = recipesById(bank);
    for (const e of plan.entries) {
      if (!e.recipeId) continue;
      const conflicts = recipeConflicts(byId.get(e.recipeId), prof.diet, prof.avoid);
      assert.deepEqual(conflicts, [], `${prof.id}'s plan holds ${e.recipeId}: ${conflicts}`);
    }
  }
});

test("stress: a pool emptied by screens generates an EMPTY week, not a crash", () => {
  const pool = mergeRecipePool(
    bigBank(),
    [],
    undefined,
    ["protein-", "grain-", "fruit-", "nut-"],
    undefined,
  );
  assert.equal(pool.length, 0, "the avoid list wipes the whole bank");
  const { plan, report } = generateWeek({
    recipes: pool,
    targets: TARGETS,
    pantry: { staples: [], perishables: [] },
    weekId: "2026-W41",
    plan: { week: "2026-W41", entries: [] },
  });
  assert.equal(plan.entries.length, 0, "nothing invented");
  assert.ok(report.proteinShortDays.length > 0, "the shortfall is reported, not fudged");
});

// ---------------------------------------------------------------------------
// D. Malformed / partial JSON from the data repo
// ---------------------------------------------------------------------------

test("stress: normalizePantry heals malformed shapes instead of crashing", () => {
  // non-array tiers (a hand-edited or truncated pantry.json); null/undefined
  // are fine as-is — every consumer already reads tiers with `?? []`
  for (const junk of ["oops", 42, {}, true]) {
    const healed = normalizePantry({ staples: junk, perishables: junk });
    assert.deepEqual(healed.staples, [], `staples: ${JSON.stringify(junk)} heals to []`);
    assert.deepEqual(healed.perishables, [], `perishables: ${JSON.stringify(junk)} heals to []`);
  }
  const nullTiers = { staples: null, perishables: null };
  assert.equal(normalizePantry(nullTiers), nullTiers, "null tiers pass through untouched");
  // non-object rows mixed into an otherwise-valid array
  const healed = normalizePantry({
    staples: [null, { id: "s1", name: "salt", onHand: true }, "junk"],
    perishables: [null, 7, { food: "spinach", qty: "1 bag" }, ["nested"]],
  });
  assert.equal(healed.staples.length, 1, "junk staple rows dropped");
  assert.equal(healed.perishables.length, 1, "junk perishable rows dropped");
  assert.equal(typeof healed.perishables[0].id, "string", "surviving row still self-heals an id");
  // a clean pantry passes through untouched (identity fast-path intact)
  const clean = {
    staples: [{ id: "s1", name: "salt", onHand: true }],
    perishables: [{ id: "p1", food: "spinach", location: "fridge", group: "produce" }],
  };
  assert.equal(normalizePantry(clean), clean);
});

test("stress: deriveShoppingList survives recipes with malformed ingredient rows", () => {
  const recipe = {
    id: "r1",
    name: "r1",
    mealType: "dinner",
    servings: 1,
    nutrition: { calories: 500, protein: 30 },
    ingredients: [
      { qty: 1, unit: "g" }, // no food at all (partial JSON)
      { qty: 1, unit: "g", food: null },
      { qty: 2, unit: "x", food: "eggs" }, // the one real row
    ],
  };
  const plan = {
    week: "2026-W40",
    entries: [{ id: "e1", date: "2026-09-28", slot: "dinner", recipeId: "r1", servings: 1 }],
  };
  const pantry = { staples: [{ id: "s1", runningLow: true }], perishables: [] }; // nameless staple too
  const list = deriveShoppingList(plan, recipesById([recipe]), pantry, null);
  assert.deepEqual(
    list.items.map((i) => i.food),
    ["eggs"],
    "only the real ingredient shops; junk rows are skipped, not crashed on",
  );
});

test("stress: generateWeek tolerates an empty/absent-field pantry and null targets", () => {
  const { plan } = generateWeek({
    recipes: bigBank(),
    targets: null,
    pantry: {},
    weekId: "2026-W40",
    plan: { week: "2026-W40", entries: [] },
  });
  assert.equal(plan.entries.filter((e) => e.slot === "dinner").length, 7);
});

test("stress: github.readFile turns bad Contents-API payloads into clean errors", async () => {
  kv.set("mise.pat", "test-token");
  const respond = (/** @type {any} */ body, status = 200) =>
    /** @type {any} */ ({ ok: status < 300, status, json: async () => body });
  const realFetch = globalThis.fetch;
  try {
    // truncated JSON inside the blob: JSON.parse must throw (the store layer
    // catches and keeps serving cache) — never a half-parsed object
    globalThis.fetch = async () => respond({ content: btoa('{"a": 1, "b":'), sha: "x" });
    await assert.rejects(() => readFile("pantry.json"), SyntaxError);
    // a directory listing where a file was expected
    globalThis.fetch = async () => respond([{ name: "a.json" }]);
    await assert.rejects(() => readFile("plans"), /not a small JSON file/);
    // >1MB file: GitHub omits `content`
    globalThis.fetch = async () => respond({ sha: "x", size: 2_000_000 });
    await assert.rejects(() => readFile("huge.json"), /not a small JSON file/);
    // plain 404 = absent, not an error
    globalThis.fetch = async () => respond({}, 404);
    assert.equal(await readFile("missing.json"), null);
    // server error surfaces with the status in the message
    globalThis.fetch = async () => respond({}, 500);
    await assert.rejects(() => readFile("pantry.json"), /HTTP 500/);
  } finally {
    globalThis.fetch = realFetch;
    kv.delete("mise.pat");
  }
});

// ---------------------------------------------------------------------------
// E. Failed-push path: nothing is lost when the network dies mid-flush
// ---------------------------------------------------------------------------

test("stress: pushFile propagates a network failure without inventing a result", async () => {
  const io = {
    read: async () => {
      throw new Error("offline");
    },
    write: async () => {
      throw new TypeError("fetch failed");
    },
  };
  await assert.rejects(
    () => pushFile(io, { path: "pantry.json", data: { a: 1 }, base: null, sha: null }),
    TypeError,
    "a network error must surface so the write stays queued (never swallowed)",
  );
});
