// Mise 2.0 worker fix loop 1, item 15 with the seam gate's N3, R1b, S4 and
// C3: a direct account switch (an invite link opened on a phone that is
// signed in, so SIGNED_IN for a new user with no SIGNED_OUT first) through
// the REAL session-boot, the REAL store (its own onSessionChange, lock and
// queue) and the real Supabase adapter over an in-memory project. The
// supabase-js JWT is global, as in the real client: every request goes out
// under whoever `state.jwt` names when it is SENT. Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, settle } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const backendMod = await import("../app/lib/backend.js");
const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const store = await import("../app/lib/store.js");
const { createSessionBoot, canSwitchHere } = await import("../app/lib/session-boot.js");

const PEOPLE = {
  A: { slug: "housemate-1", admin: false, home: "house-a" },
  B: { slug: "housemate-2", admin: false, home: "house-a" },
  Admin: { slug: "host-1", admin: true, home: "house-a" },
};

/** @param {any} sb @param {any} state */
function harness(sb, state) {
  /** @type {{ user: string, path: string, data: any }[]} */
  const writes = [];
  /** @type {any} */
  let handler = null;
  const client = {
    from: (/** @type {string} */ t) => sb.client.from(t),
    rpc: async (/** @type {string} */ name, /** @type {any} */ args) => {
      if (name === "whoami") {
        const u = state.jwt;
        if (state.whoamiWait?.[u]) await new Promise((r) => (state.releaseWhoami = r));
        if (state.whoamiError?.[u]) return { data: null, error: { message: "network" } };
        return { data: state.who[u], error: null };
      }
      if (name === "write_doc") writes.push({ user: state.jwt, path: args?.p_path, data: structuredClone(args?.p_data) });
      return sb.client.rpc(name, args);
    },
    auth: {
      onAuthStateChange: (/** @type {any} */ cb) => (handler = cb),
      getSession: async () => ({ data: { session: state.session ?? { user: { id: "uA" }, access_token: "tA" } } }),
      signOut: async () => {},
    },
  };
  const mk = () =>
    createSessionBoot({
      client,
      project: { stamp: "supabase", label: "live" },
      storage: null,
      seam: {
        installBackend: backendMod.installBackend,
        lockedBackend: backendMod.lockedBackend,
        createSupabaseAdapter,
        onSessionChange: store.onSessionChange,
        resetFileChecks: store.resetFileChecks,
        flushNow: () => store.flushNow({ timeoutMs: 300 }),
        purgeEverything: store.purgeEverything,
        refusedRecords: store.refusedRecords,
        discardRefused: store.discardRefused,
        canSwitchProfile: store.canSwitchProfile,
        acquireStoreLock: () => store.acquireStoreLock({ timeoutMs: 2000 }),
      },
    });
  return { writes, mk, fire: (/** @type {any[]} */ ...a) => handler(...a) };
}

function fresh() {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  backendMod.installBackend(null);
}

test("N3/R1b: a flush in the whoami window of a direct switch pushes nothing of A's under B's token", async () => {
  fresh();
  const state = /** @type {any} */ ({ jwt: "A", who: { A: PEOPLE.A, B: PEOPLE.B }, offline: true });
  const sb = fakeSupabase({
    failWith: (/** @type {string} */ op) => (op === "write_doc" && state.offline ? { status: 0, message: "offline" } : null),
  });
  const h = harness(sb, state);
  assert.equal(await h.mk().boot(), "signed-in");
  const P = "profiles/housemate-1/occasions.json";
  await store.write(P, { note: "A queued" }, { raw: true });
  await settle();
  // B signs in on this phone without a sign-out; whoami hangs
  state.offline = false;
  state.jwt = "B";
  state.whoamiWait = { B: true };
  h.fire("SIGNED_IN", { user: { id: "uB" }, access_token: "tB" });
  await settle(5);
  // any flush trigger during whoami (a write, the online event, a timer)
  await store.flushNow({ timeoutMs: 300 });
  assert.deepEqual(
    h.writes.filter((w) => w.user === "B" && w.path === P),
    [],
    "A's queued write never goes out under B's token",
  );
  assert.notEqual(backendMod.backend().session()?.slug, "housemate-1", "A's adapter is out during whoami");
  state.releaseWhoami?.();
  await settle(40);
  assert.equal(backendMod.backend().session()?.slug, "housemate-2");
  assert.deepEqual(h.writes.filter((w) => w.path === P && w.user === "B"), [], "still not after the switch");
  backendMod.installBackend(null);
});

test("S4 (probe Q3): a direct switch whose whoami fails shows nothing of A's and never stamps B's writes as A's", async () => {
  fresh();
  const state = /** @type {any} */ ({ jwt: "A", who: { A: PEOPLE.A, B: PEOPLE.B } });
  const sb = fakeSupabase({});
  const T = "profiles/housemate-1/profile/targets.json";
  sb.docs.set(T, { path: T, data: { allergens: ["peanut"], allergensFreeText: "kiwi", body: { weightLb: 131 } }, rev: 2, legacy_sha: null });
  const h = harness(sb, state);
  assert.equal(await h.mk().boot(), "signed-in");
  assert.ok(await store.readNow(T, { raw: true }), "A reads A's own targets");
  // B opens an invite link on A's tablet; whoami fails (the signal drops)
  state.jwt = "B";
  state.whoamiError = { B: true };
  h.fire("SIGNED_IN", { user: { id: "uB" }, access_token: "tB" });
  await settle(30);
  assert.equal(backendMod.backend().session(), null, "locked, no account");
  assert.equal(await store.read(T, { raw: true }), null, "B, holding the phone, cannot read A's targets");
  const N = "profiles/housemate-2/occasions.json";
  await store.write(N, { note: "B typed this" }, { raw: true });
  assert.notEqual(idb.get(N)?.account, "housemate-1", "B's write is not stamped as A's");
  // reload as B with signal, then A signs in again later
  state.whoamiError = {};
  state.session = { user: { id: "uB" }, access_token: "tB" };
  assert.equal(await h.mk().boot(), "signed-in");
  state.jwt = "A";
  state.session = { user: { id: "uA" }, access_token: "tA" };
  assert.equal(await h.mk().boot(), "signed-in");
  await settle(30);
  assert.deepEqual(
    h.writes.filter((w) => w.user === "A" && JSON.stringify(w.data).includes("B typed this")),
    [],
    "B's note is never pushed under A's token",
  );
  backendMod.installBackend(null);
});

test("C3: SWITCH PROFILE stays hidden from the moment a Supabase boot exists until whoami says admin", async () => {
  fresh();
  const state = /** @type {any} */ ({ jwt: "X", who: { X: PEOPLE.Admin }, whoamiWait: { X: true } });
  const sb = fakeSupabase({});
  const h = harness(sb, state);
  const boot = h.mk();
  assert.equal(canSwitchHere(), false, "hidden before boot runs");
  const p = boot.boot();
  await settle(5);
  assert.equal(canSwitchHere(), false, "hidden while whoami is out");
  state.releaseWhoami?.();
  assert.equal(await p, "signed-in");
  assert.equal(canSwitchHere(), true, "the admin may switch once known");
  backendMod.installBackend(null);
});

test("an offline reload as the SAME account keeps that account's cache readable (no switch, no purge)", async () => {
  fresh();
  const state = /** @type {any} */ ({ jwt: "A", who: { A: PEOPLE.A } });
  const sb = fakeSupabase({});
  const T = "profiles/housemate-1/profile/targets.json";
  sb.docs.set(T, { path: T, data: { allergens: ["peanut"] }, rev: 1, legacy_sha: null });
  const h = harness(sb, state);
  assert.equal(await h.mk().boot(), "signed-in");
  await store.readNow(T, { raw: true });
  state.whoamiError = { A: true };
  assert.equal(await h.mk().boot(), "offline");
  assert.ok(await store.read(T, { raw: true }), "the same person still reads their cache offline");
  backendMod.installBackend(null);
});
