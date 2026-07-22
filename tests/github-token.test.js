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
