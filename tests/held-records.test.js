// Mise 2.0, seam fix loop 2, item 1 (Red Team 2 N1, ENG 2 N1; P4 store):
// one phone, two housemates in the same house. The first one's queued edit
// of the shared pins book is HELD out of the path's slot when the second
// signs in, so the second reads and saves from the server's own copy and
// never on top of a write they cannot see. When the first signs back in the
// held edit moves back and lands through the normal conflict path.
// Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const store = await import("../app/lib/store.js");
const { readNow, write, flushNow, onSessionChange, refusedRecords, discardRefused } = store;

const A = { slug: "housemate-1", admin: false, home: "house-a" };
const B = { slug: "housemate-2", admin: false, home: "house-a" };
const ROW = "households/house-a/pins.json";

/** @param {any} sb @param {typeof A} who */
const signIn = (sb, who) =>
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => who }));

function setup() {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  const state = { offline: false };
  const sb = fakeSupabase({
    failWith: (op) =>
      op === "write_doc" && state.offline ? { status: 0, message: "offline" } : null,
  });
  sb.docs.set(ROW, {
    path: ROW,
    data: { pins: { rice: 1, oats: 2, beans: 3 } },
    rev: 3,
    legacy_sha: null,
  });
  return { sb, state };
}

/** A caches the book, then queues a fourth pin with no signal */
async function aQueuesAnEdit(/** @type {any} */ sb, /** @type {{ offline: boolean }} */ state) {
  signIn(sb, A);
  await onSessionChange(null, A.slug);
  const got = /** @type {any} */ (await readNow("pins.json", { raw: true }));
  assert.deepEqual(got, { pins: { rice: 1, oats: 2, beans: 3 } });
  state.offline = true;
  await write("pins.json", { pins: { ...got.pins, lentils: 4 } }, { raw: true });
  await flushNow({ timeoutMs: 1000 });
  assert.equal(idb.get("pins.json")?.dirty, true, "queued");
}

test("B saves one pin: the three pins survive A's held edit, and A's edit lands when A returns", async () => {
  const { sb, state } = setup();
  await aQueuesAnEdit(sb, state);

  // B signs in on the same phone, signal back
  await onSessionChange(A.slug, B.slug);
  signIn(sb, B);
  state.offline = false;
  assert.equal(idb.has("pins.json"), false, "the slot is free");
  const bView = /** @type {any} */ (await readNow("pins.json", { raw: true }));
  assert.deepEqual(bView, { pins: { rice: 1, oats: 2, beans: 3 } }, "B reads the server's book");
  await write("pins.json", { pins: { ...bView.pins, tofu: 9 } }, { raw: true });
  assert.equal((await flushNow({ timeoutMs: 2000 })).landed, false, "A's held edit still waits");
  assert.deepEqual(sb.docs.get(ROW)?.data, { pins: { rice: 1, oats: 2, beans: 3, tofu: 9 } });
  const listed = await refusedRecords();
  assert.deepEqual(
    listed.map((r) => [r.path, r.reason]),
    [["pins.json", "account"]],
    "A's edit is listed, by its file, for DISCARD",
  );

  // A comes back: the held edit moves back and merges with B's pin
  await onSessionChange(B.slug, A.slug);
  signIn(sb, A);
  assert.equal(idb.get("pins.json")?.account, A.slug, "back in its slot");
  const r = await flushNow({ timeoutMs: 2000 });
  assert.equal(r.landed, true, JSON.stringify(r));
  assert.deepEqual(sb.docs.get(ROW)?.data, {
    pins: { rice: 1, oats: 2, beans: 3, tofu: 9, lentils: 4 },
  });
  assert.deepEqual(await refusedRecords(), []);
  installBackend(null);
});

test("a held write is never pushed, never read, and DISCARD by its id drops it", async () => {
  const { sb, state } = setup();
  await aQueuesAnEdit(sb, state);
  await onSessionChange(A.slug, B.slug);
  signIn(sb, B);
  state.offline = false;
  const before = sb.log.filter((/** @type {any} */ e) => e.table === "write_doc").length;
  await flushNow({ timeoutMs: 2000 });
  assert.equal(
    sb.log.filter((/** @type {any} */ e) => e.table === "write_doc").length,
    before,
    "nothing sent under B",
  );
  assert.equal(
    [...idb.keys()].some((k) => !k.startsWith("#held/") && idb.get(k).dirty),
    false,
    "no queued record in any path slot",
  );
  const [row] = await refusedRecords();
  assert.ok(row && row.id !== row.path, "the id names the held copy");
  assert.equal(await discardRefused(row.id), true);
  assert.deepEqual(await refusedRecords(), []);
  // A returns to nothing held
  await onSessionChange(B.slug, A.slug);
  signIn(sb, A);
  assert.equal(idb.has("pins.json"), false);
  installBackend(null);
});

test("DISCARD by the file path, as the Settings list passes it, drops the held write", async () => {
  const { sb, state } = setup();
  await aQueuesAnEdit(sb, state);
  await onSessionChange(A.slug, B.slug);
  signIn(sb, B);
  assert.equal(await discardRefused("pins.json"), true);
  assert.deepEqual(await refusedRecords(), []);
  installBackend(null);
});

test("sign-out holds the queue too, and the same account signing in gets it back", async () => {
  const { sb, state } = setup();
  await aQueuesAnEdit(sb, state);
  await onSessionChange(A.slug, null);
  assert.equal(idb.has("pins.json"), false, "held on sign-out");
  const heldKey = [...idb.keys()].find((k) => k.startsWith("#held/"));
  assert.ok(heldKey);
  assert.equal(idb.get(heldKey).branch, "held", "a branch no build replays");
  await onSessionChange(null, A.slug);
  signIn(sb, A);
  const back = idb.get("pins.json");
  assert.equal(back?.dirty, true);
  assert.equal(back?.branch, "supabase", "its own stamp again");
  assert.equal(back?.held, undefined);
  state.offline = false;
  assert.equal((await flushNow({ timeoutMs: 2000 })).landed, true);
  assert.deepEqual(sb.docs.get(ROW)?.data, { pins: { rice: 1, oats: 2, beans: 3, lentils: 4 } });
  installBackend(null);
});
