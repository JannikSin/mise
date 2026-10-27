// Mise 2.0, seam fix loop 1, item 6 (Red Team 6): the legacy root
// fitness/targets.json is the root profile's targets on Supabase (full for
// the owner or admin, the plate for anyone else), and a listing applies the
// same plate rule. Made-up data only.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter, classifyPath } =
  await import("../app/lib/backend/supabase-adapter.js");
const { ROOT_PROFILE } = await import("../app/lib/backend/config.js");

const FULL = { macros: { calories: 3000 }, goalWeightLb: 999, diet: "omnivore" };
const PLATE = { macros: { calories: 3000 }, diet: "omnivore" };

function server() {
  const sb = fakeSupabase();
  for (const path of ["fitness/targets.json", "profile/targets.json"]) {
    sb.docs.set(path, { path, data: FULL, rev: 2, legacy_sha: null });
  }
  sb.plates.set(ROOT_PROFILE, { data: PLATE, rev: 2, content_hash: "abc", legacy_sha: null });
  return sb;
}

/** @param {any} sb */
const askedFullRow = (sb) =>
  sb.log.some(
    (/** @type {any} */ e) =>
      e.table === "docs" &&
      (e.filters ?? []).some(
        (/** @type {any[]} */ f) => f[0] === "eq" && /targets\.json$/.test(f[2]),
      ),
  );

test("root fitness/targets.json is the root profile's targets", () => {
  assert.deepEqual(classifyPath("fitness/targets.json"), { kind: "targets", owner: ROOT_PROFILE });
});

test("a non-owner reading the legacy root targets gets the plate and never asks for the row", async () => {
  const sb = server();
  const a = createSupabaseAdapter({
    client: sb.client,
    session: () => ({ slug: "housemate-1", admin: false, home: "house-a" }),
  });
  const got = await a.read("fitness/targets.json");
  assert.deepEqual(got?.data, PLATE);
  assert.equal(askedFullRow(sb), false);
});

test("a listing gives a non-owner the plate, and the owner the full row", async () => {
  const sb = server();
  const other = createSupabaseAdapter({
    client: sb.client,
    session: () => ({ slug: "housemate-1", admin: false, home: "house-a" }),
  });
  const listed = await other.list("profile");
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0]?.data, PLATE);
  assert.equal(listed[0]?.sha, "plate:abc");
  const owner = createSupabaseAdapter({
    client: sb.client,
    session: () => ({ slug: ROOT_PROFILE, admin: false, home: "house-a" }),
  });
  assert.deepEqual((await owner.list("profile"))[0]?.data, FULL);
});
