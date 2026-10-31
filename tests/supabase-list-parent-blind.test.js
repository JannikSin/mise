// Mise 2.0, seam fix loop 3, item 11 (Red Team 3 L-b; P3 knows-you): a
// listing of any PARENT of a targets folder (`profiles/X`, `profiles`) is
// blind too for anyone who may not read those targets in full, because its
// LIKE pattern reaches the nested targets rows. Made-up data only.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");

const FULL = { macros: { calories: 3000 }, goalWeightLb: 999 };
const T = "profiles/housemate-2/profile/targets.json";
const NOTE = "profiles/housemate-2/notes.json";

function server() {
  const sb = fakeSupabase();
  sb.docs.set(T, { path: T, data: FULL, rev: 2, legacy_sha: null });
  sb.docs.set(NOTE, { path: NOTE, data: { n: 1 }, rev: 3, legacy_sha: null });
  return sb;
}

/** @param {any} sb */
const listedCols = (sb) =>
  sb.log
    .filter((/** @type {any} */ e) => e.op === "select" && e.table === "docs")
    .map((/** @type {any} */ e) => e.cols);

/** @param {any} sb @param {{ slug: string, admin: boolean, home: string }} who */
const as = (sb, who) => createSupabaseAdapter({ client: sb.client, session: () => who });

const H1 = { slug: "housemate-1", admin: false, home: "house-a" };
const H2 = { slug: "housemate-2", admin: false, home: "house-a" };
const ADMIN = { slug: "admin-1", admin: true, home: "house-a" };

test("a non-owner's listing of profiles/X asks for no row data", async () => {
  const sb = server();
  const got = await as(sb, H1).list("profiles/housemate-2");
  assert.deepEqual(listedCols(sb), [["path", "rev", "legacy_sha"]]);
  assert.deepEqual(got.map((e) => [e.path, e.data]), [[NOTE, undefined]]);
  assert.equal(JSON.stringify(got).includes("goalWeightLb"), false);
});

test("a non-admin's listing of profiles asks for no row data", async () => {
  const sb = server();
  await as(sb, H2).list("profiles");
  assert.deepEqual(listedCols(sb), [["path", "rev", "legacy_sha"]]);
});

test("the owner of profiles/X and the admin list with the rows, as before", async () => {
  for (const [who, dir] of /** @type {const} */ ([
    [H2, "profiles/housemate-2"],
    [ADMIN, "profiles/housemate-2"],
    [ADMIN, "profiles"],
  ])) {
    const sb = server();
    const got = await as(sb, who).list(dir);
    assert.deepEqual(listedCols(sb), [["path", "data", "rev", "legacy_sha"]], `${who.slug} ${dir}`);
    if (dir !== "profiles") assert.deepEqual(got.find((e) => e.path === NOTE)?.data, { n: 1 });
  }
});

test("a sibling that only starts like a parent is not blinded", async () => {
  const sb = server();
  await as(sb, H1).list("profiles-archive");
  assert.deepEqual(listedCols(sb), [["path", "data", "rev", "legacy_sha"]]);
});
