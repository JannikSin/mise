// Mise 2.0, seam fix loop 1, item 5 (Red Team 5): a refused edit of my OWN
// targets reads as the server copy with every restriction of the edit added:
// allergens, typed allergy text, avoided ingredients, never-again recipes and
// the stricter diet. Never looser. Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { readTargetsOf, read, resetFileChecks } = await import("../app/lib/store.js");
const { stricterTargets } = await import("../app/lib/stricter-targets.js");
const { seatScreen } = await import("../app/lib/tables.js");

const MINE = "profiles/housemate-1/profile/targets.json";
const THEIRS = "profiles/housemate-2/profile/targets.json";
const server = {
  diet: "omnivore",
  allergens: ["shellfish"],
  avoidIngredients: ["shrimp"],
  note: "x",
};
// the refused edit adds a peanut allergy and, by mistake, drops shellfish
const local = { diet: "omnivore", allergens: ["peanuts"], avoidIngredients: ["peanut"], note: "y" };

/** @param {string} path */
const refused = (path) => ({
  path,
  data: local,
  base: server,
  sha: "pg:2",
  dirty: true,
  queuedAt: 1,
  rev: 3,
  branch: "supabase",
  refused: { reason: "name", at: 1 },
});

const peanutDish = { id: "pb", name: "Peanut noodles", ingredients: [{ food: "peanut butter" }] };
const shrimpDish = { id: "sh", name: "Shrimp rice", ingredients: [{ food: "shrimp" }] };

function signIn() {
  idb.clear();
  kv.clear();
  resetFileChecks();
  const sb = fakeSupabase({ failWith: () => ({ status: 0, message: "offline" }) });
  installBackend(
    createSupabaseAdapter({
      client: sb.client,
      session: () => ({ slug: "housemate-1", admin: false, home: "house-a" }),
    }),
  );
}

test("a refused own-targets edit adding peanut still screens peanut", async () => {
  signIn();
  idb.set(MINE, refused(MINE));
  const t = /** @type {any} */ (await readTargetsOf("housemate-1"));
  assert.ok(t.avoidIngredients.includes("peanut"), "the new allergy holds");
  assert.ok(t.avoidIngredients.includes("shrimp"), "the dropped one holds too");
  assert.deepEqual(t.allergens, ["shellfish", "peanuts"]);
  assert.equal(t.note, "x", "everything else is the server copy");
  assert.ok(seatScreen(peanutDish, t).length > 0, "peanut dish refused");
  assert.ok(seatScreen(shrimpDish, t).length > 0, "shrimp dish refused");
  installBackend(null);
});

test("someone else's refused targets read as the server copy only", async () => {
  signIn();
  idb.set(THEIRS, refused(THEIRS));
  assert.deepEqual(await read(THEIRS, { raw: true }), server);
  installBackend(null);
});

test("the diet only ever gets stricter, and text allergies are kept", () => {
  const s = { diet: "vegetarian", allergensFreeText: "kiwi" };
  assert.equal(stricterTargets(s, { diet: "vegan" })?.diet, "vegan");
  assert.equal(stricterTargets(s, { diet: "omnivore" })?.diet, "vegetarian");
  assert.equal(stricterTargets(s, { diet: "carnivore" })?.diet, "vegetarian");
  assert.equal(
    stricterTargets(s, { allergensFreeText: "mango" })?.allergensFreeText,
    "kiwi, mango",
  );
  assert.equal(stricterTargets(s, { allergensFreeText: "Kiwi" })?.allergensFreeText, "kiwi");
  assert.deepEqual(stricterTargets(null, { avoidRecipes: ["r1"] }), { avoidRecipes: ["r1"] });
  assert.deepEqual(
    stricterTargets({ avoidRecipes: ["r0"] }, { avoidRecipes: ["r1"] })?.avoidRecipes,
    ["r0", "r1"],
  );
});
