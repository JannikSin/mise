// Mise 2.0, seam fix loop 3, item 9 (Red Team 3 L-c / Q4; P4 store): a held
// write comes back on every onSessionChange, the same account again
// included, and a clean cached copy in its slot does not block it. A held
// key itself is never read or pushed, even when its account is the one
// signed in. Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, queued } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const store = await import("../app/lib/store.js");
const { read, flushNow, onSessionChange, refusedRecords } = store;

const A = { slug: "housemate-1", admin: false, home: "house-a" };
const ROW = "households/house-a/pins.json";
const KEY = "#held/housemate-1/5/pins.json";

function setup() {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  const sb = fakeSupabase({});
  sb.docs.set(ROW, { path: ROW, data: { pins: { rice: 1, oats: 2, beans: 3 } }, rev: 3, legacy_sha: null });
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => A }));
  kv.set("mise.storeAccount", A.slug);
  idb.set(KEY, {
    ...queued(KEY, { pins: { rice: 1, oats: 2, beans: 3, lentils: 4 } }),
    base: { rice: 1, oats: 2, beans: 3 },
    queuedAt: 5,
    account: A.slug,
    branch: "held",
    held: { path: "pins.json", account: A.slug, branch: "supabase" },
  });
  return { sb };
}

const heldKeys = () => [...idb.keys()].filter((k) => k.startsWith("#held/"));

test("blocked by a queued 1.95 write, the restore happens on the next same-account call once that landed", async () => {
  const { sb } = setup();
  // a 1.95 queued write (no account) sits in the slot
  idb.set("pins.json", { ...queued("pins.json", { pins: { rice: 1, oats: 2, beans: 3, kale: 7 } }), queuedAt: 1 });
  await onSessionChange(A.slug, A.slug);
  assert.deepEqual(heldKeys(), [KEY], "a queued write in the slot blocks it");

  // the held key is never pushed or read, though its account is signed in
  await flushNow({ timeoutMs: 2000 });
  assert.equal([...sb.docs.keys()].some((k) => k.includes("#held")), false, "never pushed");
  assert.equal(await read(KEY, { raw: true }), null, "never read");
  assert.equal(idb.get("pins.json")?.dirty, false, "the 1.95 write landed");

  // next whoami: same account, the slot holds only a clean copy now
  await onSessionChange(A.slug, A.slug);
  assert.deepEqual(heldKeys(), [], "restored over the clean copy");
  assert.deepEqual(await refusedRecords(), []);
  const r = await flushNow({ timeoutMs: 2000 });
  assert.equal(r.landed, true);
  assert.deepEqual(sb.docs.get(ROW)?.data, { pins: { rice: 1, oats: 2, beans: 3, kale: 7, lentils: 4 } });
  installBackend(null);
});

test("the same account again restores a held write into an empty slot", async () => {
  setup();
  await onSessionChange(A.slug, A.slug);
  assert.deepEqual(heldKeys(), []);
  assert.equal(idb.get("pins.json")?.account, A.slug);
  assert.equal(idb.get("pins.json")?.branch, "supabase", "its own branch comes back");
  installBackend(null);
});
