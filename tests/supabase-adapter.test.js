// Mise 2.0, plan item C1: the Supabase adapter's read, write and list
// against a fake client, the typed errors, and the store taking a listing's
// rows without a second fetch per file (ENG 10).
import test from "node:test";
import assert from "node:assert/strict";
import { idb, settle } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter, classifyPath, mapError } =
  await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { readCollection, collectionFresh } = await import("../app/lib/store.js");

const ME = { slug: "housemate-1", admin: false, home: "house-a" };

test("paths are classified the way doc_scope stores them", () => {
  assert.deepEqual(classifyPath("recipes/chili.json"), {
    kind: "bank",
    id: "chili",
    staging: false,
  });
  assert.deepEqual(classifyPath("recipes-staging/chili.json"), {
    kind: "bank",
    id: "chili",
    staging: true,
  });
  assert.deepEqual(classifyPath("profiles.json"), { kind: "roster" });
  assert.equal(classifyPath("profile/targets.json").kind, "targets");
  assert.deepEqual(classifyPath("profiles/guest-a/fitness/targets.json"), {
    kind: "targets",
    owner: "guest-a",
  });
  assert.equal(
    classifyPath("fitness/targets.json").kind,
    "doc",
    "root fitness is not a plate read",
  );
  assert.equal(classifyPath("households/house-a/events.json").kind, "doc");
});

test("list returns one level of JSON files with their rows, sorted", async () => {
  const sb = fakeSupabase();
  for (const path of [
    "profiles/housemate-1/recipes/b-dish.json",
    "profiles/housemate-1/recipes/a-dish.json",
    "profiles/housemate-1/recipes/old/deep.json",
    "profiles/housemate-10/recipes/x.json",
  ]) {
    sb.docs.set(path, { path, data: { id: path }, rev: 2, legacy_sha: null });
  }
  const a = createSupabaseAdapter({ client: sb.client, session: () => ME });
  const got = await a.list("profiles/housemate-1/recipes");
  assert.deepEqual(
    got.map((e) => [e.name, e.sha]),
    [
      ["a-dish.json", "pg:2"],
      ["b-dish.json", "pg:2"],
    ],
  );
  assert.deepEqual(got[0]?.data, { id: "profiles/housemate-1/recipes/a-dish.json" });
});

test("list of the bank skips staging, and the staging listing is only staging", async () => {
  const sb = fakeSupabase();
  sb.recipes.set("a", { id: "a", data: { id: "a" }, rev: 1, legacy_sha: "g1", staging: false });
  sb.recipes.set("b", { id: "b", data: { id: "b" }, rev: 1, legacy_sha: null, staging: true });
  const a = createSupabaseAdapter({ client: sb.client, session: () => ME });
  assert.deepEqual(
    (await a.list("recipes")).map((e) => [e.path, e.sha]),
    [["recipes/a.json", "g1"]],
  );
  assert.deepEqual(
    (await a.list("recipes-staging")).map((e) => e.path),
    ["recipes-staging/b.json"],
  );
});

test("a dir name with LIKE wildcards matches only itself", async () => {
  const sb = fakeSupabase();
  sb.docs.set("a_b/x.json", { path: "a_b/x.json", data: {}, rev: 1, legacy_sha: null });
  sb.docs.set("aXb/y.json", { path: "aXb/y.json", data: {}, rev: 1, legacy_sha: null });
  const a = createSupabaseAdapter({ client: sb.client, session: () => ME });
  assert.deepEqual(
    (await a.list("a_b")).map((e) => e.path),
    ["a_b/x.json"],
  );
});

test("the roster reads as a 1.95 profiles.json and writes back through write_doc", async () => {
  const sb = fakeSupabase();
  sb.roster.profiles = [
    {
      id: "housemate-1",
      roster: { name: "Housemate One", emoji: "x" },
      household: "house-a",
      family: null,
      admin: false,
    },
    {
      id: "owner-a",
      roster: { name: "Owner A", family: "stale" },
      household: null,
      family: null,
      admin: true,
    },
  ];
  sb.roster.rev = 5;
  const a = createSupabaseAdapter({ client: sb.client, session: () => ME });
  const got = await a.read("profiles.json");
  assert.equal(got?.sha, "pg:5");
  assert.deepEqual(got?.data, {
    profiles: [
      { name: "Housemate One", emoji: "x", id: "housemate-1", household: "house-a" },
      { name: "Owner A", id: "owner-a", admin: true },
    ],
  });
  const res = await a.write("profiles.json", /** @type {any} */ (got?.data), got?.sha);
  assert.equal(res.sha, "pg:6");
  await assert.rejects(a.write("profiles.json", {}, "pg:5"), { name: "ConflictError" });
});

test("refusals come back typed: forbidden, name guard, auth; other failures stay plain", async () => {
  const sb = fakeSupabase({
    canWrite: (p) => !p.startsWith("households/house-b/"),
    nameGuard: (_p, d) => JSON.stringify(d).includes("secret-name"),
  });
  const a = createSupabaseAdapter({ client: sb.client, session: () => ME });
  await assert.rejects(a.write("households/house-b/pantry.json", {}, null), {
    name: "ForbiddenError",
  });
  await assert.rejects(a.write("households/house-a/events.json", { note: "secret-name" }, null), {
    name: "NameGuardError",
  });
  assert.equal(mapError({ code: "PGRST301", message: "JWT expired" }, "x").name, "AuthError");
  assert.equal(mapError({ status: 401, message: "" }, "x").name, "AuthError");
  assert.equal(
    mapError({ code: "42501", message: "permission denied" }, "x").name,
    "ForbiddenError",
  );
  assert.equal(mapError({ code: "P0001", message: "mise_bad_path" }, "x").name, "ForbiddenError");
  assert.equal(mapError({ code: "08006", message: "connection" }, "x").name, "Error");
});

test("status: missing signed out, ok signed in, invalid on a rejected session", async () => {
  const sb = fakeSupabase();
  assert.equal(
    (await createSupabaseAdapter({ client: sb.client, session: () => null }).status()).auth,
    "missing",
  );
  const a = createSupabaseAdapter({ client: sb.client, session: () => ME });
  assert.equal((await a.status()).auth, "ok");
  assert.equal(a.authBroken("invalid"), true);
  assert.equal(a.authBroken("ok"), false);
  const dead = fakeSupabase({ failWith: () => ({ code: "PGRST301", message: "JWT expired" }) });
  const b = createSupabaseAdapter({ client: dead.client, session: () => ME });
  assert.equal((await b.status()).auth, "invalid");
  const tok = createSupabaseAdapter({
    client: sb.client,
    session: () => ME,
    accessToken: () => "jwt-abc",
  });
  assert.equal(await tok.authHeader(), "Bearer jwt-abc");
});

test("the store caches a listing's rows without fetching each file again", async () => {
  idb.clear();
  const sb = fakeSupabase();
  for (const id of ["a", "b", "c"]) {
    sb.recipes.set(id, { id, data: { id, name: id }, rev: 2, legacy_sha: null, staging: false });
  }
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => ME }));
  await readCollection("recipes", { raw: true });
  await settle();
  assert.equal(collectionFresh("recipes", { raw: true }), true);
  const got = await readCollection("recipes", { raw: true });
  assert.deepEqual(got.map((r) => r.id).sort(), ["a", "b", "c"]);
  assert.equal(
    sb.log.filter((l) => l.table === "recipes" && l.filters?.some((f) => f[1] === "id")).length,
    0,
    "no per-recipe reads",
  );
  assert.equal(idb.get("recipes/a.json")?.sha, "pg:2");
  installBackend(null);
});
