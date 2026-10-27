// Mise 2.0, seam fix loop 1, item 9 (Red Team 8, ENG F4): a revoke purge
// cannot be undone by a fetch or a push that was in flight when it ran. The
// purge installs the locked backend and empties the sync scope first. Made-up
// data only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, settle } from "./helpers/fake-browser.js";

const { installBackend, backend } = await import("../app/lib/backend.js");
const { read, write, purgeEverything, setSyncScope, inSyncScope, resetFileChecks } =
  await import("../app/lib/store.js");

/** a signed-in Supabase stand-in whose reads and writes wait for a release */
function heldBackend() {
  /** @type {(() => void)[]} */
  const releases = [];
  const hold = () => new Promise((r) => releases.push(() => r(undefined)));
  /** @type {import("../app/lib/backend.js").Backend} */
  const b = {
    name: "supabase",
    read: async () => {
      await hold();
      return { data: { secret: "revoked" }, sha: "pg:5" };
    },
    write: async () => {
      await hold();
      return { sha: "pg:6" };
    },
    list: async () => [],
    readMeta: async () => null,
    authHeader: async () => null,
    status: async () => ({ privacy: "private", auth: "ok", reachable: true }),
    authBroken: () => false,
    stamp: () => "supabase",
    laneOf: () => "supabase",
    session: () => ({ slug: "housemate-1", admin: false, home: "house-a" }),
  };
  return { b, release: () => releases.splice(0).forEach((r) => r()) };
}

const P = "profiles/housemate-1/occasions.json";

test("a fetch in flight when the purge runs never lands", async () => {
  idb.clear();
  resetFileChecks();
  await setSyncScope(null);
  const { b, release } = heldBackend();
  installBackend(b);
  // a profile file, and a shared root file the emptied scope still allows
  await read(P, { raw: true }); // starts the background fetches
  await read("prices.json", { raw: true });
  await settle();
  await purgeEverything();
  release();
  await settle();
  assert.equal(idb.has(P), false, "the revoked copy stays gone");
  assert.equal(idb.has("prices.json"), false, "even where the scope would allow it");
  assert.equal(backend().session(), null, "the locked backend is in");
  assert.equal(
    inSyncScope("profiles/housemate-1/plans/2026-W45.json"),
    false,
    "the scope is empty",
  );
  installBackend(null);
  await setSyncScope(null);
});

test("a push in flight when the purge runs never writes the record back", async () => {
  idb.clear();
  resetFileChecks();
  await setSyncScope(null);
  const { b, release } = heldBackend();
  installBackend(b);
  await write(P, { note: "queued" }, { raw: true }); // starts the flush
  await settle();
  await purgeEverything();
  release();
  await settle();
  assert.equal(idb.has(P), false, "the purged record is not re-created clean");
  installBackend(null);
  await setSyncScope(null);
});
