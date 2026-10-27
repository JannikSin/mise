// Mise 2.0, seam fix loop 3, item 6 (ENG 3 T1; P4 store): SYS "discard
// mismatched" drops queued writes stamped with another data branch, and
// never another account's held writes, whose branch is "held" by design.
// Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, queued } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const store = await import("../app/lib/store.js");

test("discard mismatched keeps every held row and drops only the other branch's writes", async () => {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  installBackend(
    createSupabaseAdapter({
      client: fakeSupabase({}).client,
      session: () => ({ slug: "housemate-2", admin: false, home: "house-a" }),
    }),
  );
  kv.set("mise.storeAccount", "housemate-2");
  const heldA = "#held/housemate-1/5/pins.json";
  idb.set(heldA, {
    ...queued(heldA, { pins: { lentils: 4 } }),
    account: "housemate-1",
    branch: "held",
    held: { path: "pins.json", account: "housemate-1", branch: "supabase" },
  });
  // a held row whose own branch is another one: still discarded only from its own row
  const heldOld = "#held/housemate-1/6/plans/2026-W44.json";
  idb.set(heldOld, {
    ...queued(heldOld, { days: [] }),
    account: "housemate-1",
    branch: "held",
    held: { path: "plans/2026-W44.json", account: "housemate-1", branch: "sandbox" },
  });
  idb.set("occasions.json", { ...queued("occasions.json", { n: 1 }), branch: "sandbox" });
  idb.set("shopping.json", { ...queued("shopping.json", { items: [] }), branch: "supabase", account: "housemate-2" });

  const n = await store.discardMismatched();
  assert.equal(n, 1);
  assert.deepEqual([...idb.keys()].sort(), [heldA, heldOld, "shopping.json"].sort());
  // the held rows are still listed for their own DISCARD
  const ids = (await store.refusedRecords()).map((r) => r.id).sort();
  assert.deepEqual(ids, [heldA, heldOld].sort());
  installBackend(null);
});
