// Mise 2.0, seam fix loop 3, item 5 (ENG 3 N6; P4 store): the restore of a
// held write is one move in one transaction (dbMove), and it is idempotent,
// so a phone that dies halfway can never leave a stale duplicate that later
// undoes a newer edit. Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, settle, queued } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { dbMove } = await import("../app/lib/db.js");
const store = await import("../app/lib/store.js");
const { readNow, write, flushNow, onSessionChange, refusedRecords } = store;

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

const heldKeys = () => [...idb.keys()].filter((k) => k.startsWith("#held/"));

test("P-R1: a restore cut off before its delete leaves no stale copy to undo B's later unpin", async () => {
  const { sb, state } = setup();
  installBackend(adapter(sb, A));
  await onSessionChange(null, A.slug);
  const got = /** @type {any} */ (await readNow("pins.json", { raw: true }));
  state.offline = true;
  await write("pins.json", { pins: { ...got.pins, lentils: 4 } }, { raw: true });
  await flushNow({ timeoutMs: 500 });
  await onSessionChange(A.slug, B.slug);
  installBackend(adapter(sb, B));
  state.offline = false;

  // A returns; the phone dies between putting the record back and deleting
  // the held key (what two transactions could leave)
  const realDelete = idb.delete.bind(idb);
  let crashed = false;
  idb.delete = (/** @type {string} */ k) => {
    if (!crashed && k.startsWith("#held/")) {
      crashed = true;
      return false;
    }
    return realDelete(k);
  };
  try {
    await onSessionChange(B.slug, A.slug);
  } finally {
    idb.delete = realDelete;
  }
  await settle();
  assert.equal(crashed, true);
  assert.equal(heldKeys().length, 1, "the duplicate the crash left");

  // next boot runs the restore again: the duplicate goes, nothing is listed
  await onSessionChange(B.slug, A.slug);
  installBackend(adapter(sb, A));
  assert.deepEqual(heldKeys(), []);
  assert.deepEqual(await refusedRecords(), [], "nothing shows as another account's");
  const r = await flushNow({ timeoutMs: 2000 });
  assert.equal(r.landed, true);
  assert.equal(/** @type {any} */ (sb.docs.get(ROW)).data.pins.lentils, 4);

  // B unpins lentils on another phone; this phone goes A to B to A again
  sb.docs.set(ROW, { path: ROW, data: { pins: { rice: 1, oats: 2, beans: 3 } }, rev: 9, legacy_sha: null });
  await onSessionChange(A.slug, B.slug);
  installBackend(adapter(sb, B));
  await onSessionChange(B.slug, A.slug);
  installBackend(adapter(sb, A));
  await flushNow({ timeoutMs: 2000 });
  assert.deepEqual(sb.docs.get(ROW)?.data, { pins: { rice: 1, oats: 2, beans: 3 } }, "lentils stay unpinned");
  installBackend(null);
});

test("a held copy whose slot holds a different queued write of the same account stays held", async () => {
  setup();
  const key = "#held/housemate-1/5/pins.json";
  idb.set(key, {
    ...queued(key, { pins: { a: 1 } }),
    queuedAt: 5,
    account: A.slug,
    branch: "held",
    held: { path: "pins.json", account: A.slug },
  });
  // a newer write of A's in the slot (another queue time): not the same write
  idb.set("pins.json", { ...queued("pins.json", { pins: { a: 2 } }), queuedAt: 6, account: A.slug });
  installBackend(adapter(fakeSupabase({}), A));
  await onSessionChange(A.slug, A.slug);
  assert.deepEqual(heldKeys(), [key], "kept, not dropped");
  assert.deepEqual(idb.get("pins.json").data, { pins: { a: 2 } }, "slot untouched");
  installBackend(null);
});

test("a stale held copy of a write already back and edited again goes; a newer one stays", async () => {
  setup();
  const key = "#held/housemate-1/5/pins.json";
  const heldRec = (/** @type {number} */ rev) => ({
    ...queued(key, { pins: { a: rev } }),
    queuedAt: 5,
    rev,
    account: A.slug,
    branch: "held",
    held: { path: "pins.json", account: A.slug },
  });
  installBackend(adapter(fakeSupabase({}), A));
  // the slot holds the same write, edited once more after the cut-off restore
  idb.set(key, heldRec(2));
  idb.set("pins.json", { ...queued("pins.json", { pins: { a: 3 } }), queuedAt: 5, rev: 3, account: A.slug });
  await onSessionChange(A.slug, A.slug);
  assert.deepEqual(heldKeys(), [], "the stale copy is dropped");
  assert.equal(idb.get("pins.json").rev, 3);
  // a held copy NEWER than the slot is never dropped
  idb.set(key, heldRec(4));
  await onSessionChange(A.slug, A.slug);
  assert.deepEqual(heldKeys(), [key]);
  installBackend(null);
});

test("dbMove: put and delete together, delete only, or nothing", async () => {
  idb.clear();
  idb.set("a", { path: "a", v: 1 });
  assert.equal(
    await dbMove("a", "b", (from, to) => {
      assert.equal(to, undefined);
      return { put: /** @type {any} */ ({ ...from, path: "b" }), deleteFrom: true };
    }),
    true,
  );
  assert.deepEqual([...idb.keys()], ["b"]);
  idb.set("c", { path: "c", v: 2 });
  assert.equal(await dbMove("c", "b", () => ({ deleteFrom: true })), true);
  assert.deepEqual([...idb.keys()], ["b"]);
  assert.equal(await dbMove("b", "x", () => null), false);
  assert.equal(await dbMove("b", "x", () => ({})), false);
  assert.deepEqual([...idb.keys()], ["b"]);
});
