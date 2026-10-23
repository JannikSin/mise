// Mise 2.0, A-03 (David, 2026-10-18: "Nobody in West Lafayette should be able
// to see my family"): a phone outside the family syncs only its own house.
import test from "node:test";
import assert from "node:assert/strict";

/** @type {Map<string, string>} */
const kv = new Map();
globalThis.localStorage = /** @type {any} */ ({
  getItem: (/** @type {string} */ k) => kv.get(k) ?? null,
  setItem: (/** @type {string} */ k, /** @type {string} */ v) => kv.set(k, String(v)),
  removeItem: (/** @type {string} */ k) => kv.delete(k),
});

const { syncScopeFor, withoutHiddenNames } = await import("../app/lib/privacy.js");
const { setSyncScope, setScopeGuests, inSyncScope, read, readCollection } = await import(
  "../app/lib/store.js"
);

const ROSTER = [
  { id: "david", name: "David", household: "wayne", family: "taranowski", admin: true },
  { id: "mom", name: "Mom", household: "taranowski", family: "taranowski" },
  { id: "laurie", name: "Laurie", household: "taranowski", family: "taranowski" },
  { id: "dad", name: "Dad", household: "taranowski", family: "taranowski" },
  { id: "elliot", name: "Elliot", household: "wayne" },
  { id: "annie", name: "Annie", household: "guesthouse" },
];

test("Elliot's phone syncs Wayne only; David's phone syncs everything", () => {
  assert.deepEqual(syncScopeFor(ROSTER, "elliot"), {
    profileIds: ["david", "elliot"],
    houses: ["wayne"],
  });
  assert.equal(syncScopeFor(ROSTER, "david", true), null, "the admin, on his own phone");
  // Tribunal Red Team BLOCK (2.0 loop 1): David has no passkey, and the
  // offline fallback row made any phone his with one tap
  assert.deepEqual(
    syncScopeFor(ROSTER, "david"),
    { profileIds: [], houses: [] },
    "the admin on a phone that never verified him syncs nothing personal",
  );
  assert.deepEqual(
    syncScopeFor(ROSTER, "ghost"),
    { profileIds: [], houses: [] },
    "a chosen profile missing from the roster syncs nothing, never everything",
  );
  assert.equal(
    syncScopeFor(ROSTER.map((p) => ({ ...p, admin: undefined })), "elliot"),
    null,
    "no admin yet: nothing is hidden",
  );
});

test("out of scope reads never reach GitHub or the cache", async () => {
  await setSyncScope(syncScopeFor(ROSTER, "elliot"));
  for (const p of [
    "households/taranowski/events.json",
    "profiles/mom/profile/targets.json",
    "profiles/laurie/plans/2026-W43.json",
    "profiles/dad/occasions.json",
    "profiles/annie/profile/targets.json",
  ]) {
    assert.equal(inSyncScope(p), false, p);
    assert.equal(await read(p, { raw: true }), null, `${p} reads as missing`);
  }
  assert.deepEqual(await readCollection("profiles/mom/recipes", { raw: true }), []);
  for (const p of [
    "households/wayne/events.json",
    "profiles/elliot/plans/2026-W43.json",
    "plans/2026-W43.json",
    "fitness/targets.json",
    "recipes/chili.json",
    "profiles.json",
    "prices.json",
  ]) {
    assert.equal(inSyncScope(p), true, p);
  }
});

test("a guest seated at Wayne's table stays readable, so the plate screen can check them", async () => {
  await setSyncScope(syncScopeFor(ROSTER, "elliot"));
  await setScopeGuests(["annie"]);
  assert.equal(inSyncScope("profiles/annie/profile/targets.json"), true);
  assert.equal(inSyncScope("profiles/annie/fitness/targets.json"), true, "the legacy targets path");
  // only their targets (Tribunal Red Team, 2.0 loop 1): a seated Mom must not
  // bring her daily logs and plans with her
  assert.equal(inSyncScope("profiles/annie/fitness/daily.json"), false);
  assert.equal(inSyncScope("profiles/annie/plans/2026-W43.json"), false);
  assert.equal(inSyncScope("profiles/mom/profile/targets.json"), false);
  await setScopeGuests([]);
  assert.equal(inSyncScope("profiles/annie/profile/targets.json"), false);
});

test("a phone outside David's house cannot read his root files; the shared bank stays", async () => {
  await setSyncScope({ profileIds: ["annie"], houses: ["guesthouse"] });
  assert.equal(inSyncScope("plans/2026-W43.json"), false);
  assert.equal(inSyncScope("fitness/targets.json"), false);
  assert.equal(inSyncScope("shopping.json"), false);
  assert.equal(inSyncScope("recipes/chili.json"), true);
  await setSyncScope(null);
  assert.equal(inSyncScope("profiles/mom/profile/targets.json"), true, "null lifts it");
});

test("recipe titles drop a hidden person's name", () => {
  const out = withoutHiddenNames(
    [{ id: "a", name: "Laurie's Mediterranean Herb Chicken" }, { id: "b", name: "Chili" }],
    ["Laurie", "Mom", "Dad"],
  );
  assert.deepEqual(out.map((r) => r.name), ["Mediterranean Herb Chicken", "Chili"]);
  const same = [{ id: "b", name: "Chili" }];
  assert.equal(withoutHiddenNames(same, ["Laurie"]), same);
});

test("guest passkey hashes and invite codes are the admin's phone only", async () => {
  await setSyncScope(syncScopeFor(ROSTER, "elliot"));
  assert.equal(inSyncScope("guests.json"), false);
  assert.equal(inSyncScope("invites.json"), false);
  await setSyncScope(null);
  assert.equal(inSyncScope("guests.json"), true);
});
