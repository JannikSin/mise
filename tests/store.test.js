import test from "node:test";
import assert from "node:assert/strict";
import { tokenBroken } from "../app/lib/github.js";

// store.js touches localStorage at call time (inside activeProfile/scoped) —
// stub the boundary before import, same pattern as github-token.test.js.
/** @type {Map<string, string>} */
const kv = new Map();
globalThis.localStorage = /** @type {any} */ ({
  getItem: (/** @type {string} */ k) => kv.get(k) ?? null,
  setItem: (/** @type {string} */ k, /** @type {string} */ v) => kv.set(k, String(v)),
  removeItem: (/** @type {string} */ k) => kv.delete(k),
});

const {
  activeProfile, scoped, pathFor, hasOwnRecipes, readProfiles, patchProfiles,
  writeErrorMessage, readTargetsOf, writeTargetsOf,
} = await import("../app/lib/store.js");

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

// ---- pathFor: the scoping rule now has exactly one home ------------------
// The comment above scoped() called itself "the one scoping chokepoint" while
// seventeen open-coded copies of the same ternary lived in main.js. This is
// the table proof that collapsing them changed nothing: for every profile and
// every document type, pathFor reproduces the rule that was open-coded.

const PROFILES = ["david", "mom", "laurie", "dad"];
const DOCS = [
  "profiles.json", "shopping.json", "pantry.json", "occasions.json",
  "meta.json", "pins.json", "prices.json",
  "fitness/targets.json", "fitness/daily.json", "profile/targets.json",
  "plans/2026-W33.json", "recipes",
];
/** the rule exactly as main.js used to open-code it, 17 times over */
const legacyRule = (id, path) =>
  path === "profiles.json" ? path : id === "david" ? path : `profiles/${id}/${path}`;

test("pathFor reproduces the open-coded rule for every profile x every document", () => {
  for (const id of PROFILES)
    for (const path of DOCS)
      assert.equal(pathFor(id, path), legacyRule(id, path), `${id} / ${path}`);
});

test("pathFor handles a profile id nobody has created yet, like a roommate", () => {
  assert.equal(pathFor("roommate", "shopping.json"), "profiles/roommate/shopping.json");
  assert.equal(pathFor("roommate", "profiles.json"), "profiles.json");
});

test("scoped is exactly pathFor bound to the active profile", () => {
  for (const id of PROFILES) {
    kv.clear();
    kv.set("mise.activeProfile", id);
    for (const path of DOCS) assert.equal(scoped(path), pathFor(id, path));
  }
});

test("hasOwnRecipes is false ONLY for david, and that is not an optimization", () => {
  assert.equal(hasOwnRecipes("david"), false);
  assert.equal(pathFor("david", "recipes"), "recipes", "which IS the shared bank root");
  for (const id of ["mom", "laurie", "dad", "roommate"]) assert.equal(hasOwnRecipes(id), true);
});

// ---- the food profile leaves fitness/ (David, 2026-08-22) ----------------

test("readTargetsOf prefers the new path and never reads the legacy one once migrated", async () => {
  const asked = [];
  const readFn = (p) => {
    asked.push(p);
    // BOTH exist, carrying different numbers, so a wrong preference is visible
    const val =
      p === "profile/targets.json"
        ? { macros: { calories: 3700 } }
        : { macros: { calories: 1 } };
    return Object.assign(Promise.resolve(val), { catch: () => Promise.resolve(val) });
  };
  const got = await readTargetsOf("david", /** @type {any} */ (readFn));
  assert.deepEqual(got, { macros: { calories: 3700 } }, "the new path wins");
  assert.deepEqual(asked, ["profile/targets.json"], "and the legacy file is not even opened");
});

test("readTargetsOf FALLS BACK to fitness/targets.json when the new path is absent", async () => {
  const asked = [];
  const readFn = (p) => {
    asked.push(p);
    const val = p === "fitness/targets.json" ? { macros: { calories: 3700 } } : null;
    return Object.assign(Promise.resolve(val), { catch: () => Promise.resolve(val) });
  };
  const got = await readTargetsOf("david", /** @type {any} */ (readFn));
  assert.deepEqual(got, { macros: { calories: 3700 } }, "an unmigrated profile behaves as yesterday");
  assert.deepEqual(asked, ["profile/targets.json", "fitness/targets.json"], "new first, legacy second");
});

test("readTargetsOf scopes the fallback per profile, never reading David's file for Mom", async () => {
  const asked = [];
  const readFn = (p) => {
    asked.push(p);
    return Object.assign(Promise.resolve(null), { catch: () => Promise.resolve(null) });
  };
  await readTargetsOf("mom", /** @type {any} */ (readFn));
  assert.deepEqual(asked, [
    "profiles/mom/profile/targets.json",
    "profiles/mom/fitness/targets.json",
  ]);
});

test("writeTargetsOf writes the new path AND mirrors the legacy one for Anvil", async () => {
  const wrote = [];
  const writeFn = async (p, d) => { wrote.push([p, d]); };
  await writeTargetsOf("david", { macros: { calories: 3700 } }, /** @type {any} */ (writeFn));
  assert.deepEqual(wrote.map((w) => w[0]), ["profile/targets.json", "fitness/targets.json"]);
  assert.deepEqual(wrote[0][1], wrote[1][1], "the mirror cannot drift: same object, one writer");
});

test("the mirror is scoped too, so Mom's write never lands on David's spine", async () => {
  const wrote = [];
  const writeFn = async (p) => { wrote.push(p); };
  await writeTargetsOf("mom", { macros: {} }, /** @type {any} */ (writeFn));
  assert.deepEqual(wrote, [
    "profiles/mom/profile/targets.json",
    "profiles/mom/fitness/targets.json",
  ]);
});

// ---- a dead token must be loud, and the two failure modes need OPPOSITE
// instructions (2026-08-22, after GENERATE "did not work" and the real cause
// was that every write was being rejected while the screen looked fine) ----

test("tokenBroken covers BOTH failure modes, because either means nothing saves", () => {
  assert.equal(tokenBroken("invalid"), true, "GitHub rejected it: renew");
  assert.equal(tokenBroken("norepo"), true, "valid token, wrong repo access: do NOT renew");
  assert.equal(tokenBroken("ok"), false);
  assert.equal(tokenBroken("missing"), false, "no token at all is a different screen");
  assert.equal(tokenBroken("unknown"), false, "offline is not broken");
  assert.equal(tokenBroken(undefined), false);
});

test("throttling is NOT a broken token: it fixes itself and must not raise the alarm", () => {
  // a 403 is two different things wearing one status code. Sending someone to
  // regenerate a perfectly good token because they wrote too fast is the same
  // class of wrong instruction as the norepo case.
  assert.equal(tokenBroken("throttled"), false);
});
