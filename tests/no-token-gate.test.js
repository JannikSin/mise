// NO TOKEN, NO NAMES (David, 2026-11-02: "before i typed in the token it
// showed up as just my name again ... dont want it to automatically have it go
// and work to be in my profile"). P3: nobody lands in someone else's profile.
//
// A phone with no data token used to be offered the built-in default list,
// which is one row: the admin, by name. Now the chooser lists nobody and the
// screen offers CONNECT YOUR KITCHEN or CONTINUE AS GUEST; a guest's writes
// never leave the phone.
import test from "node:test";
import assert from "node:assert/strict";

/** @type {Map<string, string>} */
const kv = new Map();
globalThis.localStorage = /** @type {any} */ ({
  getItem: (/** @type {string} */ k) => kv.get(k) ?? null,
  setItem: (/** @type {string} */ k, /** @type {string} */ v) => kv.set(k, String(v)),
  removeItem: (/** @type {string} */ k) => kv.delete(k),
});

// a small in-memory IndexedDB, the calls db.js makes (guest-seat.test.js)
/** @type {Map<string, any>} */
const idb = new Map();
const req = (/** @type {() => any} */ fn) => {
  /** @type {any} */
  const r = { onsuccess: null, onerror: null, result: undefined };
  queueMicrotask(() => {
    r.result = fn();
    r.onsuccess?.();
  });
  return r;
};
const os = {
  get: (/** @type {string} */ k) => req(() => (idb.has(k) ? structuredClone(idb.get(k)) : undefined)),
  getAll: () => req(() => [...idb.values()].map((v) => structuredClone(v))),
  put: (/** @type {any} */ v) => req(() => void idb.set(v.path, structuredClone(v))),
  delete: (/** @type {string} */ k) => req(() => void idb.delete(k)),
};
globalThis.indexedDB = /** @type {any} */ ({
  open: () => {
    const r = req(() => ({ transaction: () => ({ objectStore: () => os }) }));
    /** @type {any} */ (r).onupgradeneeded = null;
    return r;
  },
});
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

const { chooserRows, LOCAL_GUEST } = await import("../app/lib/privacy.js");
const { writeFile, setToken, getToken, checkDataRepo, tokenProblem } =
  await import("../app/lib/github.js");
const { write, flushNow } = await import("../app/lib/store.js");

// the built-in default readProfiles answers with when nothing is reachable
const FALLBACK = [{ id: "david", name: "David", emoji: "🏋️", phase: "gain" }];

test("no token: the chooser lists nobody, never the admin's name", () => {
  assert.equal(chooserRows(FALLBACK, null, null, false), null);
  assert.equal(chooserRows(FALLBACK, "", null, false), null);
  assert.equal(chooserRows(FALLBACK, "   ", null, false), null);
});

test("token set but offline: the cached household still lists as before", () => {
  const rows = chooserRows(FALLBACK, "github_pat_x", null, false);
  assert.deepEqual(
    rows?.map((p) => p.id),
    ["david"],
  );
});

test("a guest's writes are refused before any network call", async () => {
  kv.set("mise.pat", "t");
  kv.set("mise.activeProfile", LOCAL_GUEST);
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (
    async () => {
      called = true;
      throw new Error("must not be reached");
    }
  );
  try {
    await assert.rejects(writeFile("profiles/local-guest/plans/x.json", { a: 1 }), /guest/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
    kv.delete("mise.activeProfile");
  }
});

test("the guest id is not a name anyone could carry into the shared list", () => {
  assert.equal(LOCAL_GUEST, "local-guest");
  assert.notEqual(LOCAL_GUEST, "david");
});

test("a guest's edits are never queued, so switching profile later pushes nothing", async () => {
  kv.set("mise.pat", "t");
  kv.set("mise.activeProfile", LOCAL_GUEST);
  /** @type {string[]} */
  const puts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (
    async (/** @type {string} */ url, /** @type {any} */ opts) => {
      if (opts?.method === "PUT") puts.push(String(url));
      return { ok: false, status: 404, json: async () => ({}) };
    }
  );
  try {
    await write("plans/2026-W45.json", { days: [] });
    await write("pantry.json", { items: [] }, { raw: true });
    assert.equal(idb.get("profiles/local-guest/plans/2026-W45.json")?.dirty, false);
    assert.equal(idb.get("pantry.json")?.dirty, false);
    // connected later and signed in as a real person
    kv.set("mise.activeProfile", "mom");
    await flushNow({ timeoutMs: 2000 });
    assert.deepEqual(puts, []);
  } finally {
    globalThis.fetch = realFetch;
    kv.delete("mise.activeProfile");
  }
});

test("a pasted token loses every space and newline before it is saved", () => {
  setToken("  github_pat_ab\ncd ef \n");
  assert.equal(getToken(), "github_pat_abcdef");
});

test("a refused token says which refusal it was", async () => {
  kv.set("mise.pat", "t");
  const realFetch = globalThis.fetch;
  /** @param {number} status */
  const authWith = async (status) => {
    globalThis.fetch = /** @type {any} */ (
      async (/** @type {string} */ _u, /** @type {any} */ opts) => ({
        ok: false,
        status: opts?.headers?.Authorization ? status : 404,
        json: async () => ({ message: "Resource not accessible by personal access token" }),
      })
    );
    return (await checkDataRepo()).auth;
  };
  try {
    assert.equal(await authWith(401), "invalid");
    assert.equal(await authWith(403), "norepo");
    assert.equal(await authWith(404), "norepo");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(tokenProblem("invalid"), /rejected this token \(401\)/);
  assert.match(tokenProblem("norepo"), /no access to JannikSin\/mise-data \(403\/404\)/);
  assert.match(tokenProblem("ok", "missing"), /sandbox data branch is missing/);
  assert.equal(tokenProblem("ok", "ok"), "");
  assert.equal(tokenProblem("unknown"), "", "offline is not a refusal");
});

test("every passkey and token box shows dots, not the characters (David, 2026-11-02)", async () => {
  const { readFileSync } = await import("node:fs");
  let boxes = 0;
  for (const f of ["join.js", "profile-gate.js", "system.js"]) {
    const src = readFileSync(new URL(`../app/views/${f}`, import.meta.url), "utf8");
    const inputs = src.match(/<input[^>]*?(?:class="pin-input"|access token")[^>]*?>/g) ?? [];
    for (const tag of inputs) {
      boxes++;
      assert.match(tag, /type="password"/, `${f}: ${tag.slice(0, 80)}`);
    }
  }
  assert.ok(boxes >= 8, `found ${boxes} boxes`);
});
