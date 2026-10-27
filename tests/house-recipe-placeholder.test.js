// Mise 2.0, plan item E2 (ENG 3, ENG L2-4): the recipe pool is the shared
// bank plus every house of mine; a house- id that resolves in none of my
// houses shows "a house dish", carries no macros, and every allergy screen
// refuses it exactly as the existing "the dish could not be found" path does
// (tables.js seatScreen). PROMOTE is the admin's and goes through the bank
// guard. All people and houses here are made up.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { idb } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const {
  myHouses,
  houseRecipeDirs,
  withHouseRecipes,
  wholeHouseRecipe,
  houseDishName,
  mayPromote,
  HOUSE_DISH,
} = await import("../app/lib/house-recipes.js");
const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { write, flushNow, refusedRecords, resetFileChecks } = await import("../app/lib/store.js");
const { mergeRecipePool, recipesById, dayTotals } = await import("../app/lib/plan.js");
const { seatScreen } = await import("../app/lib/tables.js");

const ROSTER = [
  { id: "housemate-1", household: "house-a" },
  { id: "member-2", household: "house-a", family: "house-b" },
  { id: "guest-a" },
];

const bankDish = {
  id: "bank-oats",
  name: "Oats",
  ingredients: [{ food: "oats", qty: 80, unit: "g" }],
  nutrition: { calories: 300, protein: 10 },
};
// a whole special of house-a
const SPECIAL = "house-aaaaaaaaaaaa";
const special = {
  id: SPECIAL,
  name: "Quick curry",
  tags: ["ai-special"],
  ingredients: [{ food: "chickpeas", qty: 200, unit: "g" }],
  nutrition: { calories: 600, protein: 30 },
};
// a house row that never came down whole: a name and macros, no ingredients
const TRUNCATED = "house-bbbbbbbbbbbb";
const truncated = {
  id: TRUNCATED,
  name: "Peanut noodles",
  nutrition: { calories: 700, protein: 25 },
};
// a dish of a house I am not in: nothing of it reaches this phone
const FOREIGN = "house-cccccccccccc";

const omnivore = { diet: "omnivore", avoidIngredients: [] };
const peanutAllergic = { diet: "omnivore", avoidIngredients: ["peanut"] };

/** the pool main.js builds: the bank plus the house listings, as served */
async function poolFromServer() {
  const sb = fakeSupabase();
  for (const d of [special, truncated]) {
    const path = `households/house-a/recipes/${d.id}.json`;
    sb.docs.set(path, { path, data: d, rev: 1, legacy_sha: null });
  }
  sb.recipes.set(bankDish.id, {
    id: bankDish.id,
    data: bankDish,
    rev: 1,
    legacy_sha: null,
    staging: false,
  });
  const a = createSupabaseAdapter({
    client: sb.client,
    session: () => ({ slug: "housemate-1", admin: false, home: "house-a" }),
  });
  const bank = (await a.list("recipes")).map((r) => r.data);
  const dirs = houseRecipeDirs("supabase", ROSTER, "housemate-1");
  const houses = await Promise.all(dirs.map(async (d) => (await a.list(d)).map((r) => r.data)));
  return /** @type {Record<string, any>[]} */ (
    withHouseRecipes(/** @type {any} */ (bank), /** @type {any} */ (houses))
  );
}

test("my houses are my home house plus the family house roster() shows me", () => {
  assert.deepEqual(myHouses(ROSTER, "housemate-1"), ["house-a"]);
  assert.deepEqual(myHouses(ROSTER, "member-2"), ["house-a", "house-b"]);
  assert.deepEqual(myHouses(ROSTER, "guest-a"), [], "a guest belongs to no house");
  assert.deepEqual(myHouses(ROSTER, "nobody"), []);
  assert.deepEqual(
    myHouses([{ id: "x", household: "../bank" }], "x"),
    [],
    "not a slug, reads nothing",
  );
  assert.deepEqual(houseRecipeDirs("supabase", ROSTER, "member-2"), [
    "households/house-a/recipes",
    "households/house-b/recipes",
  ]);
  assert.deepEqual(houseRecipeDirs("github", ROSTER, "member-2"), [], "1.95 reads only the bank");
});

test("the pool is the bank plus my house's whole recipes", async () => {
  const pool = await poolFromServer();
  assert.deepEqual(
    pool.map((r) => r.id),
    ["bank-oats", SPECIAL],
  );
  const screened = mergeRecipePool(
    pool,
    [],
    undefined,
    peanutAllergic.avoidIngredients,
    "omnivore",
  );
  assert.ok(
    screened.some((r) => r.id === SPECIAL),
    "a house special is plannable like a bank dish",
  );
});

test("a bank row wins over a house row with the same id, and non-opaque house rows are dropped", () => {
  const promoted = { ...special, promoted: true };
  const pool = withHouseRecipes(
    [promoted],
    [[special, { ...bankDish, id: "special-named-2026-10-27" }]],
  );
  assert.deepEqual(pool, [promoted]);
  const bank = [bankDish];
  assert.equal(withHouseRecipes(bank, []), bank, "nothing to add keeps the same array");
});

test("an unresolvable house dish shows as a house dish, never its id", async () => {
  const byId = recipesById(await poolFromServer());
  for (const id of [TRUNCATED, FOREIGN]) {
    assert.equal(byId.get(id), undefined, `${id} resolves in none of my houses`);
    assert.equal(houseDishName(id), HOUSE_DISH);
    assert.equal(HOUSE_DISH, "a house dish");
  }
  assert.equal(
    houseDishName("special-quick-curry-2026-10-27"),
    null,
    "a bank id keeps the 1.95 fallback",
  );
  assert.equal(houseDishName(undefined), null);
});

test("an unresolvable house dish carries no macros", async () => {
  const byId = recipesById(await poolFromServer());
  const day = "2026-11-02";
  const entries = /** @type {any[]} */ ([
    { id: "e1", date: day, slot: "dinner", recipeId: TRUNCATED, servings: 1 },
    { id: "e2", date: day, slot: "lunch", recipeId: FOREIGN, servings: 1 },
  ]);
  assert.deepEqual(dayTotals(entries, byId, day), { calories: 0, protein: 0 });
  entries.push({ id: "e3", date: day, slot: "breakfast", recipeId: SPECIAL, servings: 1 });
  assert.deepEqual(
    dayTotals(entries, byId, day),
    { calories: 600, protein: 30 },
    "a resolved one counts",
  );
});

test("the allergy screen fails CLOSED on an unresolvable house dish, like a missing dish", async () => {
  const byId = recipesById(await poolFromServer());
  for (const id of [TRUNCATED, FOREIGN]) {
    for (const t of [omnivore, peanutAllergic]) {
      assert.deepEqual(seatScreen(byId.get(id) ?? null, t), ["the dish could not be found"], id);
    }
  }
  assert.deepEqual(
    seatScreen(byId.get(SPECIAL) ?? null, peanutAllergic),
    [],
    "the whole special screens normally",
  );
  assert.equal(wholeHouseRecipe(truncated), false);
  assert.equal(wholeHouseRecipe({ ...special, nutrition: null }), false, "no macros, not whole");
  assert.equal(wholeHouseRecipe(special), true);
});

test("PROMOTE is the admin's on Supabase, and 1.95 on GitHub", () => {
  const sb = (/** @type {any} */ s) => ({ name: "supabase", session: () => s });
  assert.equal(mayPromote({ name: "github", session: () => null }), true);
  assert.equal(mayPromote(sb({ slug: "admin-1", admin: true, home: "house-a" })), true);
  assert.equal(mayPromote(sb({ slug: "housemate-1", admin: false, home: "house-a" })), false);
  assert.equal(mayPromote(sb(null)), false, "signed out promotes nothing");
});

test("a promote write goes to the bank through its admin check and name guard", async () => {
  /** @param {{ admin: boolean, nameHit: boolean }} o */
  const promoteAs = async (o) => {
    idb.clear();
    resetFileChecks();
    const sb = fakeSupabase({ isAdmin: () => o.admin, nameGuard: () => o.nameHit });
    installBackend(
      createSupabaseAdapter({
        client: sb.client,
        session: () => ({
          slug: o.admin ? "admin-1" : "housemate-1",
          admin: o.admin,
          home: "house-a",
        }),
      }),
    );
    await write(`recipes/${SPECIAL}.json`, { ...special, promoted: true }, { raw: true });
    await flushNow({ timeoutMs: 3000 });
    const refused = await refusedRecords();
    installBackend(null);
    return { sb, refused };
  };
  const clean = await promoteAs({ admin: true, nameHit: false });
  assert.equal(
    clean.sb.recipes.get(SPECIAL)?.data.promoted,
    true,
    "the admin's promote lands in the bank",
  );
  const named = await promoteAs({ admin: true, nameHit: true });
  assert.deepEqual(
    named.refused.map((r) => r.reason),
    ["name"],
    "a name in the dish is refused",
  );
  assert.equal(named.sb.recipes.size, 0);
  const member = await promoteAs({ admin: false, nameHit: false });
  assert.deepEqual(
    member.refused.map((r) => r.reason),
    ["forbidden"],
  );
});

test("main.js builds the pool from the bank plus my houses and gates PROMOTE (spelling check)", () => {
  const src = readFileSync(new URL("../app/main.js", import.meta.url), "utf8");
  assert.match(src, /houseRecipeDirs\(\s*backend\(\)\.name,/);
  assert.match(src, /setBankRecipes\(withHouseRecipes\(r, houses\)\)/);
  assert.match(src, /if \(!mayPromote\(backend\(\)\)\) throw/);
  for (const f of ["../app/views/planner.js", "../app/views/tables.js"]) {
    assert.match(readFileSync(new URL(f, import.meta.url), "utf8"), /houseDishName\(/, f);
  }
});
