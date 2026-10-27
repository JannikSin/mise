// Mise 2.0, seam fix loop 3, item 1 (Red Team 3 S1, ENG 3 N7; P4 store):
// a push that hung past the store lock's deadline must never retry its
// conflict through the next account's adapter. One client whose JWT is
// global, as supabase-js's is: every request goes out as whoever is signed
// in at the moment it is SENT. A is in house-a, B in house-b. Made-up people.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, settle } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend, lockedBackend } = await import("../app/lib/backend.js");
const { ConflictError, PushAborted, pushFile } = await import("../app/lib/sync.js");
const store = await import("../app/lib/store.js");
const { readNow, write, flushNow, onSessionChange, acquireStoreLock } = store;

const A = { slug: "housemate-1", admin: false, home: "house-a" };
const B = { slug: "housemate-2", admin: false, home: "house-b" };
const PA = "households/house-a/pins.json";
const PB = "households/house-b/pins.json";

function setup() {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  const sb = fakeSupabase({});
  sb.docs.set(PA, { path: PA, data: { pins: { rice: 1 } }, rev: 3, legacy_sha: null });
  sb.docs.set(PB, { path: PB, data: { pins: { kale: 7 } }, rev: 5, legacy_sha: null });
  const state = { jwt: "A", hangNext: false, /** @type {(() => void) | null} */ release: null };
  /** @type {{ user: string, path: string }[]} */
  const sent = [];
  const client = {
    from: (/** @type {string} */ t) => sb.client.from(t),
    rpc: async (/** @type {string} */ name, /** @type {any} */ args) => {
      if (name === "write_doc") {
        sent.push({ user: state.jwt, path: args?.p_path });
        if (state.hangNext) {
          state.hangNext = false;
          await new Promise((r) => (state.release = () => r(undefined)));
        }
      }
      return sb.client.rpc(name, args);
    },
  };
  const adapter = (/** @type {typeof A} */ who) =>
    createSupabaseAdapter({ client: /** @type {any} */ (client), session: () => who });
  return { sb, state, sent, adapter };
}

test("Q1: A's hung push, back as a conflict after B signed in, sends nothing as B and stays held for A", async () => {
  const { sb, state, sent, adapter } = setup();
  installBackend(adapter(A));
  await onSessionChange(null, A.slug);
  await readNow("pins.json", { raw: true });
  state.hangNext = true;
  await write("pins.json", { pins: { rice: 1, secretA: 42 } }, { raw: true });
  await settle();
  assert.equal(store.getSyncStatus().flushing, true, "the push hangs");
  assert.deepEqual(sent, [{ user: "A", path: PA }]);

  // the switch to B proceeds at the lock's deadline, the push still hung
  const release = await acquireStoreLock({ timeoutMs: 60 });
  assert.equal(release.timedOut, true);
  installBackend(lockedBackend());
  await onSessionChange(A.slug, B.slug);
  state.jwt = "B";
  installBackend(adapter(B));
  release();

  // house-a moved meanwhile, so the hung write comes back as a conflict
  sb.docs.set(PA, { path: PA, data: { pins: { rice: 1, beans: 2 } }, rev: 4, legacy_sha: null });
  state.release?.();
  await settle(60);

  assert.deepEqual(
    sent.filter((s) => s.user === "B"),
    [],
    "no write_doc goes out under B's JWT",
  );
  assert.deepEqual(sb.docs.get(PB)?.data, { pins: { kale: 7 } }, "house-b untouched");
  const held = [...idb.keys()].filter((k) => k.startsWith(`#held/${A.slug}/`));
  assert.equal(held.length, 1, "A's write is still held for A");
  assert.deepEqual(idb.get(held[0]).data, { pins: { rice: 1, secretA: 42 } });

  // A comes back: the held write lands in A's own house, merged
  await onSessionChange(B.slug, A.slug);
  state.jwt = "A";
  installBackend(adapter(A));
  const r = await flushNow({ timeoutMs: 2000 });
  assert.equal(r.landed, true);
  assert.deepEqual(sb.docs.get(PA)?.data, { pins: { rice: 1, beans: 2, secretA: 42 } });
  assert.deepEqual(sb.docs.get(PB)?.data, { pins: { kale: 7 } });
  assert.deepEqual(
    sent.filter((s) => s.user === "B"),
    [],
  );
  installBackend(null);
});

test("P-L1: a hung push rejected as a conflict after the switch never writes through the next backend", async () => {
  const { sb, adapter } = setup();
  const a = adapter(A);
  /** @type {((e: any) => void)[]} */
  const hung = [];
  let first = true;
  installBackend({
    ...a,
    write: (/** @type {any[]} */ ...args) => {
      if (first) {
        first = false;
        return new Promise((_, rej) => hung.push(rej));
      }
      return /** @type {any} */ (a.write)(...args);
    },
  });
  await onSessionChange(null, A.slug);
  const got = /** @type {any} */ (await readNow("pins.json", { raw: true }));
  await write("pins.json", { pins: { ...got.pins, lentils: 4 } }, { raw: true });
  await settle();
  assert.equal(store.getSyncStatus().flushing, true);
  const release = await acquireStoreLock({ timeoutMs: 60 });
  await onSessionChange(A.slug, "housemate-2");
  const b = adapter({ ...B, home: "house-a" });
  /** @type {any[]} */
  const bCalls = [];
  installBackend({
    ...b,
    read: (/** @type {string} */ p) => {
      bCalls.push(["read", p]);
      return b.read(p);
    },
    write: (/** @type {any[]} */ ...args) => {
      bCalls.push(["write", args[0]]);
      return /** @type {any} */ (b.write)(...args);
    },
  });
  release();
  hung.splice(0).forEach((rej) => rej(new ConflictError("pins.json")));
  await settle(60);
  assert.deepEqual(bCalls, [], "neither the retry read nor the retry write used B's backend");
  assert.deepEqual(sb.docs.get(PA)?.data, { pins: { rice: 1 } });
  assert.equal(store.getSyncStatus().flushing, false);
  // the stop is not reported as a network failure: Sync keeps the lock line
  assert.equal(store.getSyncStatus().lastError, store.LOCK_TIMEOUT_MESSAGE);
  installBackend(null);
});

test("an account change alone (the same backend still installed) also stops the retry", async () => {
  const { sb, adapter } = setup();
  const a = adapter(A);
  /** @type {((e: any) => void)[]} */
  const hung = [];
  /** @type {any[]} */
  const calls = [];
  let first = true;
  installBackend({
    ...a,
    read: (/** @type {string} */ p) => {
      calls.push(["read", p]);
      return a.read(p);
    },
    write: (/** @type {any[]} */ ...args) => {
      if (first) {
        first = false;
        return new Promise((_, rej) => hung.push(rej));
      }
      calls.push(["write", args[0]]);
      return /** @type {any} */ (a.write)(...args);
    },
  });
  await onSessionChange(null, A.slug);
  const got = /** @type {any} */ (await readNow("pins.json", { raw: true }));
  calls.length = 0;
  await write("pins.json", { pins: { ...got.pins, lentils: 4 } }, { raw: true });
  await settle();
  // adopt's order: the account change runs before the next adapter goes in
  await onSessionChange(A.slug, "housemate-2");
  hung.splice(0).forEach((rej) => rej(new ConflictError("pins.json")));
  await settle(60);
  assert.deepEqual(calls, [], "no retry read or write after the account changed");
  assert.deepEqual(sb.docs.get(PA)?.data, { pins: { rice: 1 } });
  installBackend(null);
});

test("a backend swap with no account change also stops the retry (the pass is pinned to its backend)", async () => {
  const { sb, adapter } = setup();
  const a = adapter(A);
  /** @type {((e: any) => void)[]} */
  const hung = [];
  let first = true;
  installBackend({
    ...a,
    write: (/** @type {any[]} */ ...args) => {
      if (first) {
        first = false;
        return new Promise((_, rej) => hung.push(rej));
      }
      return /** @type {any} */ (a.write)(...args);
    },
  });
  await onSessionChange(null, A.slug);
  const got = /** @type {any} */ (await readNow("pins.json", { raw: true }));
  await write("pins.json", { pins: { ...got.pins, lentils: 4 } }, { raw: true });
  await settle();
  /** @type {any[]} */
  const calls = [];
  const a2 = adapter(A);
  installBackend({
    ...a2,
    read: (/** @type {string} */ p) => {
      calls.push(["read", p]);
      return a2.read(p);
    },
  });
  hung.splice(0).forEach((rej) => rej(new ConflictError("pins.json")));
  await settle(60);
  assert.deepEqual(calls, [], "the retry did not go through the newly installed backend");
  assert.equal(idb.get("pins.json")?.dirty, true, "still queued, for the next pass");
  const r = await flushNow({ timeoutMs: 2000 });
  assert.equal(r.landed, true, "the next pass lands it");
  assert.deepEqual(sb.docs.get(PA)?.data, { pins: { rice: 1, lentils: 4 } });
  installBackend(null);
});

test("pushFile asks alive() before the first write and before the conflict retry", async () => {
  /** @type {string[]} */
  const calls = [];
  const io = {
    read: async (/** @type {string} */ p) => {
      calls.push(`read ${p}`);
      return { data: {}, sha: "s2" };
    },
    write: async (/** @type {string} */ p) => {
      calls.push(`write ${p}`);
      throw new ConflictError(p);
    },
  };
  const job = { path: "x.json", data: { a: 1 }, base: null, sha: "s1" };
  // dead from the start: no request at all
  await assert.rejects(pushFile(io, job, () => false), PushAborted);
  assert.deepEqual(calls, []);
  // alive for the first write, dead when its conflict comes back: no retry
  let ok = true;
  const io2 = {
    ...io,
    write: async (/** @type {string} */ p) => {
      calls.push(`write ${p}`);
      ok = false;
      throw new ConflictError(p);
    },
  };
  await assert.rejects(pushFile(io2, job, () => ok), PushAborted);
  assert.deepEqual(calls, ["write x.json"]);
  // always alive: the 1.95 path, three tries with a read between
  calls.length = 0;
  await assert.rejects(pushFile(io, job), ConflictError);
  assert.deepEqual(calls, ["write x.json", "read x.json", "write x.json", "read x.json", "write x.json"]);
});
