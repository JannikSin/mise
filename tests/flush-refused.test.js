// Mise 2.0, plan section 5 (ENG 2, ENG L2-8): every queued record gets its
// own outcome. Forbidden or name guard: refused, kept, listed, and no longer
// overriding reads; conflict: merge; auth: stop and keep the queue; network:
// retry. The 1.95 flush stopped at the first error, so one refused file
// stranded everything queued behind it.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, settle, queued } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const {
  read,
  readCollection,
  readMeta,
  write,
  flushNow,
  getSyncStatus,
  refusedRecords,
  discardRefused,
  resetFileChecks,
  writeErrorMessage,
  REFUSED_REASON,
} = await import("../app/lib/store.js");

const ME = { slug: "housemate-1", admin: false, home: "house-a" };
const OTHER_HOUSE = "households/house-b/pantry.json";
const NAMED = "households/house-a/events.json";

function rig(/** @type {Parameters<typeof fakeSupabase>[0]} */ hooks = {}) {
  idb.clear();
  resetFileChecks();
  const sb = fakeSupabase({
    canWrite: (p) => !p.startsWith("households/house-b/"),
    nameGuard: (_p, d) => JSON.stringify(d).includes("hidden-name"),
    ...hooks,
  });
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => ME }));
  return sb;
}

test("refused then good flushes the good one", async () => {
  const sb = rig();
  idb.set(OTHER_HOUSE, queued(OTHER_HOUSE, { items: ["x"] }, { queuedAt: 1, branch: "supabase" }));
  idb.set(
    NAMED,
    queued(NAMED, { note: "dinner with hidden-name" }, { queuedAt: 2, branch: "supabase" }),
  );
  const good = "households/house-a/pantry.json";
  idb.set(good, queued(good, { items: ["rice"] }, { queuedAt: 3, branch: "supabase" }));
  const res = await flushNow({ timeoutMs: 3000 });
  assert.deepEqual(sb.docs.get(good)?.data, { items: ["rice"] }, "the good one landed");
  assert.equal(idb.get(good)?.dirty, false);
  assert.equal(res.landed, false, "a refused write is not a saved one");
  assert.equal(getSyncStatus().refused, 2);
  assert.deepEqual(
    (await refusedRecords()).map((r) => [r.path, r.reason]),
    [
      [NAMED, "name"],
      [OTHER_HOUSE, "forbidden"],
    ],
  );
  assert.equal(REFUSED_REASON.name, "would show a name to another house");
  // a refused record is not retried on every heartbeat
  const before = sb.log.length;
  await flushNow({ timeoutMs: 3000 });
  assert.equal(sb.log.length, before);
  installBackend(null);
});

test("refused record does not override reads", async () => {
  const sb = rig();
  sb.docs.set(NAMED, { path: NAMED, data: { tables: ["server"] }, rev: 4, legacy_sha: null });
  idb.set(
    NAMED,
    queued(
      NAMED,
      { tables: ["local"], note: "hidden-name" },
      { branch: "supabase", base: { tables: ["server"] }, sha: "pg:4" },
    ),
  );
  assert.deepEqual(await read(NAMED, { raw: true }), { tables: ["local"], note: "hidden-name" });
  await flushNow({ timeoutMs: 3000 });
  assert.ok(idb.get(NAMED)?.refused, "refused");
  assert.deepEqual(await read(NAMED, { raw: true }), { tables: ["server"] });
  assert.deepEqual(await readCollection("households/house-a", { raw: true }), [
    { tables: ["server"] },
  ]);
  const meta = await readMeta(NAMED, { raw: true });
  assert.deepEqual(meta, { data: { tables: ["server"] }, sha: "pg:4", dirty: false });
  // the server moves on; the refused record learns the new server copy
  sb.docs.set(NAMED, { path: NAMED, data: { tables: ["newer"] }, rev: 5, legacy_sha: null });
  resetFileChecks();
  await read(NAMED, { raw: true });
  await settle();
  assert.deepEqual(await read(NAMED, { raw: true }), { tables: ["newer"] });
  assert.equal(idb.get(NAMED)?.refused?.reason, "name", "still listed until discarded");
  // a fresh edit is new data and gets its own try
  await write(NAMED, { tables: ["newer", "mine"] }, { raw: true });
  await flushNow({ timeoutMs: 3000 });
  assert.deepEqual(sb.docs.get(NAMED)?.data, { tables: ["newer", "mine"] });
  assert.equal(idb.get(NAMED)?.refused, undefined);
  installBackend(null);
});

test("DISCARD removes it", async () => {
  rig();
  idb.set(OTHER_HOUSE, queued(OTHER_HOUSE, { items: ["x"] }, { branch: "supabase" }));
  await flushNow({ timeoutMs: 3000 });
  assert.equal((await refusedRecords()).length, 1);
  assert.equal(await discardRefused("households/house-a/pantry.json"), false, "not a refused one");
  assert.equal(await discardRefused(OTHER_HOUSE), true);
  assert.equal(idb.has(OTHER_HOUSE), false);
  assert.equal(getSyncStatus().refused, 0);
  assert.equal(getSyncStatus().pending, 0);
  installBackend(null);
});

test("auth stops the pass and keeps the queue; it is said in words", async () => {
  const sb = rig({
    failWith: (op) => (op === "write_doc" ? { code: "PGRST301", message: "JWT expired" } : null),
  });
  const a = "households/house-a/pantry.json";
  const b = "households/house-a/ledger.json";
  idb.set(a, queued(a, { items: [] }, { queuedAt: 1, branch: "supabase" }));
  idb.set(b, queued(b, { entries: [] }, { queuedAt: 2, branch: "supabase" }));
  const res = await flushNow({ timeoutMs: 3000 });
  assert.equal(res.pending, 2);
  assert.equal(getSyncStatus().refused, 0, "auth is not a refusal");
  assert.match(String(res.error), /sign in again/);
  assert.equal(
    sb.log.filter((l) => l.table === "write_doc").length,
    1,
    "the second record was not tried",
  );
  installBackend(null);
});

test("a network failure keeps everything queued for the retry", async () => {
  rig({ failWith: (op) => (op === "write_doc" ? { code: "", message: "Failed to fetch" } : null) });
  const a = "households/house-a/pantry.json";
  idb.set(a, queued(a, { items: [] }, { branch: "supabase" }));
  const res = await flushNow({ timeoutMs: 3000 });
  assert.equal(res.pending, 1);
  assert.equal(idb.get(a)?.refused, undefined);
  assert.equal(res.error, "can't reach the server right now (auto-retrying)");
  installBackend(null);
});

test("on GitHub the error words are 1.95's", () => {
  installBackend(null);
  assert.equal(
    writeErrorMessage("write x: HTTP 500"),
    "can't reach GitHub right now (auto-retrying)",
  );
});
