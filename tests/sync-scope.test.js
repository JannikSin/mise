// Mise 2.0, A-03 (the owner, 2026-10-18: "Nobody in West Lafayette should be able
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
  { id: "david", name: "Owner", household: "wayne", family: "birch", admin: true },
  { id: "mom", name: "Mom", household: "birch", family: "birch" },
  { id: "wren", name: "Wren", household: "birch", family: "birch" },
  { id: "dad", name: "Dad", household: "birch", family: "birch" },
  { id: "flatmate", name: "Flatmate", household: "wayne" },
  { id: "mara", name: "Mara", household: "guesthouse" },
];

test("Flatmate's phone syncs Wayne only; Owner's phone syncs everything", () => {
  assert.deepEqual(syncScopeFor(ROSTER, "flatmate"), {
    profileIds: ["david", "flatmate"],
    houses: ["wayne"],
  });
  assert.equal(syncScopeFor(ROSTER, "david", true), null, "the admin, on his own phone");
  // Tribunal Red Team BLOCK (2.0 loop 1): the owner has no passkey, and the
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
    syncScopeFor(ROSTER.map((p) => ({ ...p, admin: undefined })), "flatmate"),
    null,
    "no admin yet: nothing is hidden",
  );
});

test("out of scope reads never reach GitHub or the cache", async () => {
  await setSyncScope(syncScopeFor(ROSTER, "flatmate"));
  for (const p of [
    "households/birch/events.json",
    "profiles/mom/profile/targets.json",
    "profiles/wren/plans/2026-W43.json",
    "profiles/dad/occasions.json",
    "profiles/mara/profile/targets.json",
  ]) {
    assert.equal(inSyncScope(p), false, p);
    assert.equal(await read(p, { raw: true }), null, `${p} reads as missing`);
  }
  assert.deepEqual(await readCollection("profiles/mom/recipes", { raw: true }), []);
  for (const p of [
    "households/wayne/events.json",
    "profiles/flatmate/plans/2026-W43.json",
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
  await setSyncScope(syncScopeFor(ROSTER, "flatmate"));
  await setScopeGuests(["mara"]);
  assert.equal(inSyncScope("profiles/mara/profile/targets.json"), true);
  assert.equal(inSyncScope("profiles/mara/fitness/targets.json"), true, "the legacy targets path");
  // only their targets (Tribunal Red Team, 2.0 loop 1): a seated Mom must not
  // bring her daily logs and plans with her
  assert.equal(inSyncScope("profiles/mara/fitness/daily.json"), false);
  assert.equal(inSyncScope("profiles/mara/plans/2026-W43.json"), false);
  assert.equal(inSyncScope("profiles/mom/profile/targets.json"), false);
  await setScopeGuests([]);
  assert.equal(inSyncScope("profiles/mara/profile/targets.json"), false);
});

test("a phone outside Owner's house cannot read his root files; the shared bank stays", async () => {
  await setSyncScope({ profileIds: ["mara"], houses: ["guesthouse"] });
  assert.equal(inSyncScope("plans/2026-W43.json"), false);
  assert.equal(inSyncScope("fitness/targets.json"), false);
  assert.equal(inSyncScope("shopping.json"), false);
  assert.equal(inSyncScope("recipes/chili.json"), true);
  await setSyncScope(null);
  assert.equal(inSyncScope("profiles/mom/profile/targets.json"), true, "null lifts it");
});

test("recipe titles drop a hidden person's name", () => {
  const out = withoutHiddenNames(
    [{ id: "a", name: "Wren's Mediterranean Herb Chicken" }, { id: "b", name: "Chili" }],
    ["Wren", "Mom", "Dad"],
  );
  assert.deepEqual(out.map((r) => r.name), ["Mediterranean Herb Chicken", "Chili"]);
  const same = [{ id: "b", name: "Chili" }];
  assert.equal(withoutHiddenNames(same, ["Wren"]), same);
});

test("guest passkey hashes and invite codes are the admin's phone only", async () => {
  await setSyncScope(syncScopeFor(ROSTER, "flatmate"));
  assert.equal(inSyncScope("guests.json"), false);
  assert.equal(inSyncScope("invites.json"), false);
  await setSyncScope(null);
  assert.equal(inSyncScope("guests.json"), true);
});
