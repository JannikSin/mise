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

const { activeProfile, scoped, readProfiles, patchProfiles, writeErrorMessage } = await import(
  "../app/lib/store.js"
);

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
    // the marker choosers use to say "this is the built-in default, not the
    // real list" — and that patchProfiles-based writers refuse to build on
    fallback: true,
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

test("patchProfiles patches the REAL list, never the caller's snapshot", async () => {
  // remote knows laurie; the caller's device might not — the patch must
  // land on the full list (the 2026-07-20 clobber regression)
  const real = { profiles: [{ id: "david" }, { id: "laurie" }] };
  /** @type {any[]} */
  const writes = [];
  const ok = await patchProfiles((list) => [...list, { id: "mom" }], {
    readCached: async () => ({ data: real, sha: "x" }),
    writeFn: async (path, data) => writes.push([path, data]),
  });
  assert.equal(ok, true);
  assert.deepEqual(
    writes[0][1].profiles.map((/** @type {any} */ p) => p.id),
    ["david", "laurie", "mom"],
  );
});

test("patchProfiles REFUSES when the list can't be established (offline, nothing cached)", async () => {
  /** @type {any[]} */
  const writes = [];
  const ok = await patchProfiles((list) => [...list, { id: "new" }], {
    readCached: async () => null,
    readRemote: async () => {
      throw new Error("offline");
    },
    writeFn: async (path, data) => writes.push([path, data]),
  });
  assert.equal(ok, false);
  assert.equal(writes.length, 0); // nothing written = nothing clobbered
});

test("patchProfiles seeds a confirmed-fresh repo only with allowSeed", async () => {
  const io404 = {
    readCached: async () => null,
    readRemote: async () => null, // github readFile returns null on 404
  };
  /** @type {any[]} */
  const writes = [];
  const refused = await patchProfiles((list) => [...list, { id: "first" }], {
    ...io404,
    writeFn: async (path, data) => writes.push([path, data]),
  });
  assert.equal(refused, false);
  const seeded = await patchProfiles((list) => [...list, { id: "first" }], {
    ...io404,
    allowSeed: true,
    writeFn: async (path, data) => writes.push([path, data]),
  });
  assert.equal(seeded, true);
  assert.deepEqual(
    writes[0][1].profiles.map((/** @type {any} */ p) => p.id),
    ["first"],
  );
});

// ---- the write path stops lying about why a write failed (2026-08-22) -----
// A fine-grained PAT left on GitHub's default "Public repositories" radio
// authenticates perfectly and 404s on the private data repo. On the READ path
// that got its own `norepo` state on 2026-08-16, after it cost David five
// tokens. The WRITE path kept mapping it to "can't reach GitHub right now
// (auto-retrying)" and retrying forever, while the cache-first read made the
// app look like it had saved. That is the bug that swallowed the roommate's
// profile: it exists only in his phone's IndexedDB, and nothing said so.

test("a 404 write says the token cannot SEE the repo, and says not to make another", () => {
  const m = writeErrorMessage("write profiles.json: HTTP 404 Not Found");
  assert.match(m, /can't see the data repo/);
  assert.match(m, /do NOT create a new token/);
  assert.doesNotMatch(m, /auto-retrying/, "this never fixes itself by waiting");
});

test("a genuinely rejected token still says renew it", () => {
  const m = writeErrorMessage("write shopping.json: HTTP 401 Bad credentials");
  assert.equal(m, "GitHub rejected the token (renew it in SYS)");
});

test("a secondary rate limit is NOT a bad token", () => {
  const m = writeErrorMessage(
    "write plans/2026-W34.json: HTTP 403 You have exceeded a secondary rate limit",
  );
  assert.match(m, /rate-limiting/);
  assert.doesNotMatch(m, /renew/, "telling someone to renew a working token is the wrong instruction");
});

test("anything else stays a reachability problem the heartbeat retries", () => {
  assert.match(writeErrorMessage("write pantry.json: HTTP 502"), /can't reach GitHub/);
  assert.match(writeErrorMessage("NetworkError when attempting to fetch"), /can't reach GitHub/);
});

test("the three states are genuinely distinct, so no two failures read alike", () => {
  const msgs = [
    writeErrorMessage("HTTP 404"),
    writeErrorMessage("HTTP 403 Bad credentials"),
    writeErrorMessage("HTTP 403 secondary rate limit"),
    writeErrorMessage("HTTP 500"),
  ];
  assert.equal(new Set(msgs).size, 4);
});
