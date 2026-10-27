// Mise 2.0, seam fix loop 3, item 2 (ENG 3 N5; P4 store): an app write or
// read that lands while the account is changing. The switch is a gate: reads
// and writes wait for it, the outgoing account's queue is held before the
// purge, and a write never builds on a record another account queued (not
// its data, base, sha or queue time). Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const store = await import("../app/lib/store.js");
const { read, readNow, write, flushNow, onSessionChange } = store;

const A = { slug: "housemate-1", admin: false, home: "house-a" };
const B = { slug: "housemate-2", admin: false, home: "house-a" };
const ROW = "households/house-a/pins.json";
const adapter = (/** @type {any} */ sb, /** @type {typeof A} */ who) =>
  createSupabaseAdapter({ client: sb.client, session: () => who });

function setup() {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  const state = { offline: false };
  const sb = fakeSupabase({
    failWith: (op) =>
      op === "write_doc" && state.offline ? { status: 0, message: "offline" } : null,
  });
  sb.docs.set(ROW, { path: ROW, data: { pins: { rice: 1, oats: 2, beans: 3 } }, rev: 3, legacy_sha: null });
  return { sb, state };
}

/** A caches the book and queues a lentils pin with no signal */
async function aQueues(/** @type {any} */ sb, /** @type {{ offline: boolean }} */ state) {
  installBackend(adapter(sb, A));
  await onSessionChange(null, A.slug);
  const got = /** @type {any} */ (await readNow("pins.json", { raw: true }));
  state.offline = true;
  await write("pins.json", { pins: { ...got.pins, lentils: 4 } }, { raw: true });
  await flushNow({ timeoutMs: 500 });
  state.offline = false;
}

const heldOf = (/** @type {string} */ slug) =>
  [...idb.entries()].filter(([k]) => k.startsWith(`#held/${slug}/`)).map(([, v]) => v);

test("P-R2: a write racing the switch keeps A's edit held and never lands B's on A's base", async () => {
  const { sb, state } = setup();
  await aQueues(sb, state);
  // the switch and an app write race (no await between them)
  const sw = onSessionChange(A.slug, B.slug);
  const wr = write("pins.json", { pins: { oats: 555 } }, { raw: true });
  await Promise.all([sw, wr]);
  installBackend(adapter(sb, B));

  const held = heldOf(A.slug);
  assert.equal(held.length, 1, "A's edit is held, not overwritten");
  assert.deepEqual(held[0].data, { pins: { rice: 1, oats: 2, beans: 3, lentils: 4 } });
  const slot = idb.get("pins.json");
  assert.equal(slot.account, B.slug);
  assert.equal(slot.base, null, "nothing of A's record: no base");
  assert.equal(slot.sha, null, "no sha");
  assert.equal(slot.rev, 1);

  await flushNow({ timeoutMs: 2000 });
  // B's write merged onto the server copy: rice and beans survive
  assert.deepEqual(sb.docs.get(ROW)?.data, { pins: { rice: 1, oats: 555, beans: 3 } });

  // A comes back and A's lentils land too
  await onSessionChange(B.slug, A.slug);
  installBackend(adapter(sb, A));
  const r = await flushNow({ timeoutMs: 2000 });
  assert.equal(r.landed, true);
  const final = /** @type {any} */ (sb.docs.get(ROW)).data;
  assert.equal(final.pins.lentils, 4);
  assert.equal(final.pins.rice, 1);
  installBackend(null);
});

test("a read racing the switch waits for the purge: B never sees A's cached copy", async () => {
  const { sb } = setup();
  const T = "profiles/housemate-1/profile/targets.json";
  sb.docs.set(T, { path: T, data: { allergens: ["peanut"] }, rev: 2, legacy_sha: null });
  installBackend(adapter(sb, A));
  await onSessionChange(null, A.slug);
  assert.deepEqual(await readNow(T, { raw: true }), { allergens: ["peanut"] });
  installBackend(adapter(sb, B));
  const sw = onSessionChange(A.slug, B.slug);
  const got = read(T, { raw: true });
  const meta = store.readMeta(T, { raw: true });
  await sw;
  assert.equal(await got, null, "the read waited for the purge");
  assert.equal((await meta).data, null);
  installBackend(null);
});

test("a write never builds on a slot another account queued, even with no switch running", async () => {
  const { sb, state } = setup();
  await aQueues(sb, state);
  // the slot still holds A's queued edit while the store already remembers B
  // (what an interrupted switch leaves); B saves
  kv.set("mise.storeAccount", B.slug);
  installBackend(adapter(sb, B));
  await write("pins.json", { pins: { tofu: 9 } }, { raw: true });
  const held = heldOf(A.slug);
  assert.equal(held.length, 1, "A's write moved out first");
  assert.equal(held[0].data.pins.lentils, 4);
  const slot = idb.get("pins.json");
  assert.deepEqual(slot.data, { pins: { tofu: 9 } });
  assert.equal(slot.account, B.slug);
  assert.equal(slot.base, null);
  assert.equal(slot.sha, null);
  installBackend(null);
});

test("the switch holds before it purges: a clean record is gone and the dirty one held, in one call", async () => {
  const { sb, state } = setup();
  await aQueues(sb, state);
  /** @type {string[]} */
  const order = [];
  const realDelete = idb.delete.bind(idb);
  idb.delete = (/** @type {string} */ k) => {
    order.push(k);
    return realDelete(k);
  };
  const P = "profiles/housemate-1/notes.json";
  idb.set(P, { path: P, data: { n: 1 }, base: { n: 1 }, sha: "pg:2", dirty: false, queuedAt: null, rev: 1 });
  try {
    await onSessionChange(A.slug, B.slug);
  } finally {
    idb.delete = realDelete;
  }
  assert.deepEqual(order, ["pins.json", P], "A's queued slot is freed before the clean purge");
  assert.equal(heldOf(A.slug).length, 1);
});
