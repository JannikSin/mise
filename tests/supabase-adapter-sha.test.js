// Mise 2.0, plan section 5, item 9 (ENG L2-6): the sha rule.
//   sha = rev === 1 ? (legacy_sha ?? "pg:1") : "pg:" + rev
// and on a write "pg:N" maps to N, the row's own legacy_sha to 1, anything
// else to a create (conflict and merge on an existing row).
import test from "node:test";
import assert from "node:assert/strict";
import { fakeSupabase } from "./helpers/fake-supabase.js";
import { createSupabaseAdapter, shaOf, plateShaOf } from "../app/lib/backend/supabase-adapter.js";

const ME = { slug: "housemate-1", admin: false, home: "house-a" };

function setup() {
  const sb = fakeSupabase();
  const adapter = createSupabaseAdapter({ client: sb.client, session: () => ME });
  return { sb, adapter };
}

test("create, read back, edit: pg:1, then pg:2, and a stale pg:1 conflicts", async () => {
  const { adapter } = setup();
  const path = "profiles/housemate-1/plans/2026-W44.json";
  const created = await adapter.write(path, { days: [] }, null);
  assert.equal(created.sha, "pg:1");
  const back = await adapter.read(path);
  assert.deepEqual(back, { data: { days: [] }, sha: "pg:1" });
  const edited = await adapter.write(path, { days: [{ date: "2026-10-26" }] }, back?.sha);
  assert.equal(edited.sha, "pg:2");
  assert.equal((await adapter.read(path))?.sha, "pg:2");
  await assert.rejects(adapter.write(path, { days: [] }, "pg:1"), { name: "ConflictError" });
});

test("a migrated row reads its legacy git sha, then edits to pg:2", async () => {
  const { sb, adapter } = setup();
  const path = "households/house-a/pantry.json";
  const git = "3f2a9c0d4b1e8f7a6c5d4e3f2a1b0c9d8e7f6a5b";
  sb.docs.set(path, { path, data: { items: [] }, rev: 1, legacy_sha: git });
  const back = await adapter.read(path);
  assert.equal(back?.sha, git);
  const edited = await adapter.write(path, { items: [{ name: "rice" }] }, git);
  assert.equal(edited.sha, "pg:2");
  const call = sb.log.filter((l) => l.op === "rpc" && l.table === "write_doc").at(-1);
  assert.equal(call?.args.p_expected_rev, 1, "the legacy sha is sent as rev 1");
  assert.equal((await adapter.read(path))?.sha, "pg:2");
});

test("a 1.95 record queued against a sha the row no longer has is a create, so it conflicts", async () => {
  const { sb, adapter } = setup();
  const path = "households/house-a/ledger.json";
  sb.docs.set(path, { path, data: { entries: [] }, rev: 3, legacy_sha: "aaaa" });
  await assert.rejects(adapter.write(path, { entries: [] }, "bbbb"), { name: "ConflictError" });
  const call = sb.log.filter((l) => l.op === "rpc" && l.table === "write_doc").at(-1);
  assert.equal(call?.args.p_expected_rev, null);
  // and the row's own legacy sha on a row already edited past rev 1 is stale
  await assert.rejects(adapter.write(path, { entries: [] }, "aaaa"), { name: "ConflictError" });
});

test("a create of a file that already exists conflicts instead of overwriting it", async () => {
  const { sb, adapter } = setup();
  const path = "profiles/housemate-1/shopping.json";
  sb.docs.set(path, { path, data: { items: ["kept"] }, rev: 2, legacy_sha: null });
  await assert.rejects(adapter.write(path, { items: [] }, null), { name: "ConflictError" });
  assert.deepEqual(sb.docs.get(path)?.data, { items: ["kept"] });
});

test("bank recipes follow the same rule, and a staging row is not a bank row", async () => {
  const { sb, adapter } = setup();
  sb.recipes.set("lentil-soup", {
    id: "lentil-soup",
    data: { id: "lentil-soup" },
    rev: 1,
    legacy_sha: "c0ffee",
    staging: false,
  });
  sb.recipes.set("draft-dish", {
    id: "draft-dish",
    data: { id: "draft-dish" },
    rev: 4,
    legacy_sha: null,
    staging: true,
  });
  assert.equal((await adapter.read("recipes/lentil-soup.json"))?.sha, "c0ffee");
  assert.equal(await adapter.read("recipes/draft-dish.json"), null);
  assert.equal((await adapter.read("recipes-staging/draft-dish.json"))?.sha, "pg:4");
  const edited = await adapter.write(
    "recipes/lentil-soup.json",
    { id: "lentil-soup", promoted: true },
    "c0ffee",
  );
  assert.equal(edited.sha, "pg:2");
});

test("the rule itself, and the plate fingerprint", () => {
  assert.equal(shaOf({ rev: 1 }), "pg:1");
  assert.equal(shaOf({ rev: 1, legacy_sha: "abc" }), "abc");
  assert.equal(shaOf({ rev: 7, legacy_sha: "abc" }), "pg:7");
  assert.equal(plateShaOf({ data: {}, rev: 1, content_hash: "h1", legacy_sha: "abc" }), "abc");
  assert.equal(plateShaOf({ data: {}, rev: 1, content_hash: "h1", legacy_sha: null }), "plate:h1");
  assert.equal(plateShaOf({ data: {}, rev: 2, content_hash: "h2", legacy_sha: "abc" }), "plate:h2");
});
