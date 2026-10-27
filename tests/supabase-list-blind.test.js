// Mise 2.0, seam fix loop 2, item 10 (Red Team 2 L2; P3 knows-you): a
// listing of a directory that can hold someone else's targets never asks the
// server for full rows. The non-owner gets the plate, and every other file in
// it is listed without data, to be fetched one by one. Made-up data only.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");

const FULL = { macros: { calories: 3000 }, goalWeightLb: 999, diet: "omnivore" };
const PLATE = { macros: { calories: 3000 }, diet: "omnivore" };
const DIR = "profiles/housemate-2/profile";

function server() {
  const sb = fakeSupabase();
  sb.docs.set(`${DIR}/targets.json`, {
    path: `${DIR}/targets.json`,
    data: FULL,
    rev: 2,
    legacy_sha: null,
  });
  sb.docs.set(`${DIR}/notes.json`, {
    path: `${DIR}/notes.json`,
    data: { n: 1 },
    rev: 3,
    legacy_sha: null,
  });
  sb.plates.set("housemate-2", { data: PLATE, rev: 2, content_hash: "abc", legacy_sha: null });
  return sb;
}

/** @param {any} sb */
const listedCols = (sb) =>
  sb.log
    .filter((/** @type {any} */ e) => e.op === "select" && e.table === "docs")
    .map((/** @type {any} */ e) => e.cols);

test("a non-owner's listing asks for no row data and gets the plate", async () => {
  const sb = server();
  const a = createSupabaseAdapter({
    client: sb.client,
    session: () => ({ slug: "housemate-1", admin: false, home: "house-a" }),
  });
  const got = await a.list(DIR);
  assert.deepEqual(listedCols(sb), [["path", "rev", "legacy_sha"]]);
  const byPath = new Map(got.map((e) => [e.path, e]));
  assert.deepEqual(byPath.get(`${DIR}/targets.json`)?.data, PLATE);
  assert.equal(byPath.get(`${DIR}/notes.json`)?.data, undefined, "fetched on its own later");
  assert.equal(byPath.get(`${DIR}/notes.json`)?.sha, "pg:3");
  assert.equal(JSON.stringify(got).includes("goalWeightLb"), false);
});

test("the owner and the admin list with the rows, as before", async () => {
  for (const who of [
    { slug: "housemate-2", admin: false, home: "house-a" },
    { slug: "admin-1", admin: true, home: "house-a" },
  ]) {
    const sb = server();
    const a = createSupabaseAdapter({ client: sb.client, session: () => who });
    const got = await a.list(DIR);
    assert.deepEqual(listedCols(sb), [["path", "data", "rev", "legacy_sha"]]);
    assert.deepEqual(got.find((e) => e.path.endsWith("targets.json"))?.data, FULL);
  }
});

test("a directory that cannot hold targets lists with the rows", async () => {
  const sb = server();
  const a = createSupabaseAdapter({
    client: sb.client,
    session: () => ({ slug: "housemate-1", admin: false, home: "house-a" }),
  });
  await a.list("households/house-a/recipes");
  assert.deepEqual(listedCols(sb), [["path", "data", "rev", "legacy_sha"]]);
});
