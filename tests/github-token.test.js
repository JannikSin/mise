import test from "node:test";
import assert from "node:assert/strict";

// github.js touches localStorage at call time — stub the boundary before import
/** @type {Map<string, string>} */
const store = new Map();
globalThis.localStorage = /** @type {any} */ ({
  getItem: (/** @type {string} */ k) => store.get(k) ?? null,
  setItem: (/** @type {string} */ k, /** @type {string} */ v) => store.set(k, String(v)),
  removeItem: (/** @type {string} */ k) => store.delete(k),
});

const { getToken, setToken, tokenAgeDays, TOKEN_WARN_AGE_DAYS } =
  await import("../app/lib/github.js");

test("setToken stamps savedAt; tokenAgeDays reads 0 for a fresh token", () => {
  store.clear();
  setToken("tok-abc");
  assert.equal(tokenAgeDays(), 0);
});

test("tokenAgeDays computes whole days from savedAt", () => {
  store.clear();
  store.set("mise.pat", "tok-abc");
  store.set("mise.pat.savedAt", new Date(Date.now() - 355 * 86400000).toISOString());
  assert.ok((tokenAgeDays() ?? 0) >= TOKEN_WARN_AGE_DAYS);
});

test("getToken backfills savedAt for tokens that predate the stamp", () => {
  store.clear();
  store.set("mise.pat", "legacy-token"); // no savedAt — pre-feature token
  assert.equal(tokenAgeDays(), null);
  assert.equal(getToken(), "legacy-token");
  assert.equal(tokenAgeDays(), 0); // clock started — the warning can now fire eventually
});

test("no token means no backfill and null age", () => {
  store.clear();
  assert.equal(getToken(), null);
  assert.equal(tokenAgeDays(), null);
});

// The 404-vs-401 split: a token that authenticates but was never granted the
// data repo must NOT read as "invalid", or the fix looks like minting another
// token (which lands on the same default scope and fails identically).
test("checkDataRepo: authenticated 404 is norepo, 401 is invalid", async () => {
  const { checkDataRepo, tokenBroken } = await import("../app/lib/github.js");
  store.clear();
  store.set("mise.pat", "fake-token-wrong-scope");

  /** @param {number} authedStatus */
  const runWith = (authedStatus) => {
    let call = 0;
    globalThis.fetch = /** @type {any} */ (
      async (/** @type {string} */ _u, /** @type {any} */ opts) => {
        call++;
        const authed = Boolean(opts?.headers?.Authorization);
        assert.equal(call === 1, !authed); // probe first, unauthenticated
        return { ok: false, status: authed ? authedStatus : 404, json: async () => ({}) };
      }
    );
    return checkDataRepo();
  };

  const missingRepo = await runWith(404);
  assert.equal(missingRepo.auth, "norepo");
  assert.equal(missingRepo.privacy, "private"); // anon 404 still means not public
  assert.equal(tokenBroken(missingRepo.auth), true);

  const deadToken = await runWith(401);
  assert.equal(deadToken.auth, "invalid");
  assert.equal(tokenBroken(deadToken.auth), true);

  assert.equal(tokenBroken("ok"), false);
  assert.equal(tokenBroken(undefined), false);
});

test("B4: data repo override parses owner/repo, rejects junk, defaults back", async () => {
  const { DATA_REPO, setDataRepo, dataRepoOverridden } = await import("../app/lib/github.js");
  assert.equal(DATA_REPO.owner, "JannikSin");
  assert.equal(dataRepoOverridden(), false);
  assert.equal(setDataRepo("dormcrew/mise-data-dorm"), true);
  assert.equal(DATA_REPO.owner, "dormcrew");
  assert.equal(DATA_REPO.repo, "mise-data-dorm");
  assert.equal(dataRepoOverridden(), true);
  assert.equal(setDataRepo("not a repo path!!"), false); // rejected, unchanged
  assert.equal(DATA_REPO.owner, "dormcrew");
  assert.equal(setDataRepo(""), true); // blank = back to default
  assert.equal(DATA_REPO.repo, "mise-data");
});
