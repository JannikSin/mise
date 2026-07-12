import test from "node:test";
import assert from "node:assert/strict";

// store.js touches localStorage at call time (inside activeProfile/scoped) —
// stub the boundary before import, same pattern as github-token.test.js.
/** @type {Map<string, string>} */
const kv = new Map();
globalThis.localStorage = /** @type {any} */ ({
  getItem: (/** @type {string} */ k) => kv.get(k) ?? null,
  setItem: (/** @type {string} */ k, /** @type {string} */ v) => kv.set(k, String(v)),
  removeItem: (/** @type {string} */ k) => kv.delete(k),
});

const { activeProfile, scoped, readProfiles } = await import("../app/lib/store.js");

test("activeProfile defaults to david when the key is unset", () => {
  kv.clear();
  assert.equal(activeProfile(), "david");
});

test("scoped: david's paths stay at the data root", () => {
  kv.clear();
  kv.set("mise.activeProfile", "david");
  assert.equal(scoped("shopping.json"), "shopping.json");
  assert.equal(scoped("fitness/targets.json"), "fitness/targets.json");
  assert.equal(scoped("recipes"), "recipes");
});

test("scoped: other profiles get a profiles/<id>/ prefix", () => {
  kv.clear();
  kv.set("mise.activeProfile", "mom");
  assert.equal(scoped("shopping.json"), "profiles/mom/shopping.json");
  assert.equal(scoped("fitness/targets.json"), "profiles/mom/fitness/targets.json");
  assert.equal(scoped("recipes"), "profiles/mom/recipes");
});

test("scoped: profiles.json is never scoped, even for a non-david profile", () => {
  kv.clear();
  kv.set("mise.activeProfile", "mom");
  assert.equal(scoped("profiles.json"), "profiles.json");
  kv.clear();
  assert.equal(scoped("profiles.json"), "profiles.json"); // unset key too
});

test("readProfiles falls back to a default David profile when the file is missing", async () => {
  const missing = async () => null;
  const result = await readProfiles(missing);
  assert.deepEqual(result, {
    profiles: [{ id: "david", name: "David", emoji: "🏋️", phase: "gain" }],
  });
});

test("readProfiles falls back when the read throws (offline/no token)", async () => {
  const broken = async () => {
    throw new Error("offline");
  };
  const result = await readProfiles(broken);
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].id, "david");
});

test("readProfiles falls back on an empty profiles array", async () => {
  const empty = async () => ({ data: { profiles: [] }, sha: "abc" });
  const result = await readProfiles(empty);
  assert.equal(result.profiles[0].id, "david");
});

test("readProfiles returns the file's profiles when present", async () => {
  const found = async () => ({
    data: {
      profiles: [
        { id: "david", name: "David", emoji: "🏋️", phase: "gain" },
        { id: "mom", name: "Mom", emoji: "🌿", phase: "loss" },
      ],
    },
    sha: "abc",
  });
  const result = await readProfiles(found);
  assert.equal(result.profiles.length, 2);
  assert.equal(result.profiles[1].id, "mom");
});
