// Mise 2.0, seam fix loop 2, item 3 (Red Team 2 N2; P4 store): a write made
// on a Supabase build while no account is remembered (the locked backend
// before anyone signs in, or the App still mounted after a sign-out) is held
// as "made before sign-in". It reads on the phone while nobody is signed in,
// and is never pushed by whoever signs in first; DISCARD drops it.
// Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend, lockedBackend } = await import("../app/lib/backend.js");
const store = await import("../app/lib/store.js");
const { read, write, flushNow, onSessionChange, refusedRecords, discardRefused } = store;

const B = { slug: "housemate-2", admin: false, home: "house-a" };
const FILE = "profiles/housemate-1/occasions.json";

/** @param {any} sb @param {typeof B} who */
const signIn = (sb, who) =>
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => who }));
/** @param {any} sb */
const sent = (sb) => sb.log.filter((/** @type {any} */ e) => e.table === "write_doc").length;

test("a write before any sign-in is never pushed by the first account to sign in", async () => {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  const sb = fakeSupabase({});
  installBackend(lockedBackend());
  await write(FILE, { note: "typed before sign-in" }, { raw: true });
  assert.equal(idb.get(FILE)?.account, "#before-sign-in");
  assert.deepEqual(
    await read(FILE, { raw: true }),
    { note: "typed before sign-in" },
    "it reads while nobody is signed in",
  );
  // a stray SIGNED_OUT while nobody is signed in leaves it where it is
  await onSessionChange(null, null);
  assert.deepEqual(await read(FILE, { raw: true }), { note: "typed before sign-in" });

  await onSessionChange(null, B.slug);
  signIn(sb, B);
  await flushNow({ timeoutMs: 1000 });
  assert.equal(sent(sb), 0, "nothing sent under B");
  assert.equal(sb.docs.has(FILE), false);
  assert.equal(await read(FILE, { raw: true }), null, "B never reads it");
  const rows = await refusedRecords();
  assert.deepEqual(
    rows.map((r) => [r.path, r.reason]),
    [[FILE, "presignin"]],
  );
  assert.equal(store.REFUSED_REASON.presignin, "made before sign-in");
  assert.equal(await discardRefused(/** @type {any} */ (rows[0]).id), true);
  assert.deepEqual(await refusedRecords(), []);
  installBackend(null);
});

test("after a sign-out, a write on the still-mounted app is held the same way", async () => {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  const sb = fakeSupabase({});
  signIn(sb, B);
  await onSessionChange(null, B.slug);
  await onSessionChange(B.slug, null);
  installBackend(lockedBackend());
  await write(FILE, { note: "after sign-out" }, { raw: true });
  assert.equal(idb.get(FILE)?.account, "#before-sign-in");
  await onSessionChange(null, B.slug);
  signIn(sb, B);
  await flushNow({ timeoutMs: 1000 });
  assert.equal(sent(sb), 0);
  assert.deepEqual(
    (await refusedRecords()).map((r) => r.reason),
    ["presignin"],
  );
  installBackend(null);
});

test("on GitHub a write carries no account at all (1.95)", async () => {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  installBackend(/** @type {any} */ ({
    ...lockedBackend(),
    name: "github",
    write: async () => {
      throw new Error("offline");
    },
  }));
  await write(FILE, { note: "x" }, { raw: true });
  assert.equal("account" in (idb.get(FILE) ?? {}), false);
  installBackend(null);
});
