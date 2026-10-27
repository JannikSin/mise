// Mise 2.0, plan section 5 (ENG L2-2): a targets read is decided by WHO IS
// ASKING. The owner or the admin gets the full row; anyone else gets the
// plate, and never asks for the full row at all. "The full read came back
// empty" is never the signal: a leaky policy that returned the full row to a
// housemate must still not reach the housemate's screen.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeSupabase } from "./helpers/fake-supabase.js";
import { createSupabaseAdapter } from "../app/lib/backend/supabase-adapter.js";
import { ROOT_PROFILE } from "../app/lib/backend/config.js";

const FULL = {
  diet: "vegetarian",
  allergens: ["peanut"],
  avoidIngredients: ["peanut"],
  macros: { calories: 2400, protein: 140 },
  goalWeightLb: 170,
};
const PLATE = {
  diet: "vegetarian",
  allergens: ["peanut"],
  avoidIngredients: ["peanut"],
  macros: { calories: 2400, protein: 140 },
};

function world() {
  const sb = fakeSupabase();
  for (const path of [
    "profiles/housemate-1/profile/targets.json",
    "profiles/housemate-1/fitness/targets.json",
  ]) {
    sb.docs.set(path, { path, data: structuredClone(FULL), rev: 2, legacy_sha: null });
  }
  sb.docs.set("profile/targets.json", {
    path: "profile/targets.json",
    data: { ...structuredClone(FULL), diet: "omnivore" },
    rev: 1,
    legacy_sha: "rootgit",
  });
  sb.plates.set("housemate-1", { data: PLATE, rev: 3, content_hash: "hm1", legacy_sha: null });
  sb.plates.set(ROOT_PROFILE, {
    data: { ...PLATE, diet: "omnivore" },
    rev: 1,
    content_hash: "r1",
    legacy_sha: "rootgit",
  });
  return sb;
}

/**
 * @param {ReturnType<typeof world>} sb
 * @param {{ slug: string, admin: boolean, home: string | null }} who
 */
const as = (sb, who) => createSupabaseAdapter({ client: sb.client, session: () => who });

const docQueriesFor = (/** @type {ReturnType<typeof world>} */ sb, /** @type {string} */ path) =>
  sb.log.filter((l) => l.table === "docs" && l.filters?.some((f) => f[2] === path));

test("the owner reads their own full targets, under both paths", async () => {
  const sb = world();
  const me = as(sb, { slug: "housemate-1", admin: false, home: "house-a" });
  for (const path of [
    "profiles/housemate-1/profile/targets.json",
    "profiles/housemate-1/fitness/targets.json",
  ]) {
    const got = await me.read(path);
    assert.deepEqual(got?.data, FULL, path);
    assert.equal(got?.sha, "pg:2");
  }
});

test("the admin reads anyone's full targets", async () => {
  const sb = world();
  const admin = as(sb, { slug: ROOT_PROFILE, admin: true, home: "house-a" });
  assert.deepEqual((await admin.read("profiles/housemate-1/profile/targets.json"))?.data, FULL);
});

test("a housemate reads the plate, and never asks for the full row", async () => {
  const sb = world();
  const other = as(sb, { slug: "housemate-2", admin: false, home: "house-a" });
  const path = "profiles/housemate-1/profile/targets.json";
  const got = await other.read(path);
  assert.deepEqual(got?.data, PLATE);
  assert.equal(got?.data.goalWeightLb, undefined, "an owner-only field never arrives");
  assert.equal(got?.sha, "plate:hm1");
  assert.equal(docQueriesFor(sb, path).length, 0, "the full row was never requested");
  // the root profile's targets live at the data root
  const root = await other.read("profile/targets.json");
  assert.equal(root?.data.diet, "omnivore");
  assert.equal(root?.sha, "rootgit", "a migrated plate at rev 1 reads its legacy sha");
});

test("an empty full read never falls back to a plate", async () => {
  const sb = world();
  sb.docs.delete("profiles/housemate-1/profile/targets.json");
  const me = as(sb, { slug: "housemate-1", admin: false, home: "house-a" });
  assert.equal(await me.read("profiles/housemate-1/profile/targets.json"), null);
  assert.equal(sb.log.filter((l) => l.table === "plate_for").length, 0);
});

test("no plate for someone this phone may not see reads as missing", async () => {
  const sb = world();
  const other = as(sb, { slug: "housemate-2", admin: false, home: "house-a" });
  assert.equal(await other.read("profiles/stranger-9/profile/targets.json"), null);
});

test("signed out, a targets read refuses instead of guessing", async () => {
  const sb = world();
  const nobody = createSupabaseAdapter({ client: sb.client, session: () => null });
  await assert.rejects(nobody.read("profiles/housemate-1/profile/targets.json"), {
    name: "AuthError",
  });
});
