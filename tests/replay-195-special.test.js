// Mise 2.0, seam fix loop 1, item 12 (ENG F7): a 1.95 AI special still
// queued for the bank (recipes/special-<name>-<date>.json, stamped with the
// GitHub branch) replays on Supabase into the signed-in person's house under
// an opaque id, never into the bank, and the plan entry that names its old
// id still resolves. Synthetic 1.95 queue; made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, queued } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { flushNow, refusedRecords, resetFileChecks } = await import("../app/lib/store.js");
const { withHouseRecipes } = await import("../app/lib/house-recipes.js");
const { recipesById } = await import("../app/lib/plan.js");

const OLD = "special-quick-curry-2026-10-20";
const special = {
  id: OLD,
  name: "Quick curry",
  tags: ["ai-special"],
  ingredients: [{ food: "chickpeas", qty: 200, unit: "g" }],
  nutrition: { calories: 600, protein: 30 },
};

test("a queued 1.95 special replays to the house, not the bank, and its id still resolves", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  const sb = fakeSupabase({ isAdmin: () => false });
  installBackend(
    createSupabaseAdapter({
      client: sb.client,
      session: () => ({ slug: "housemate-1", admin: false, home: "house-a" }),
    }),
  );
  // the 1.95 queue: a special stamped with the GitHub branch it was made on
  idb.set(`recipes/${OLD}.json`, queued(`recipes/${OLD}.json`, special, { branch: "main" }));
  const res = await flushNow({ timeoutMs: 3000 });
  assert.equal(res.landed, true, "nothing refused");
  assert.deepEqual(await refusedRecords(), []);
  assert.equal(sb.recipes.size, 0, "nothing reached the shared bank");
  const rows = [...sb.docs.values()].filter((r) =>
    r.path.startsWith("households/house-a/recipes/"),
  );
  assert.equal(rows.length, 1);
  const row = /** @type {any} */ (rows[0]);
  assert.match(row.path, /^households\/house-a\/recipes\/house-[0-9a-f]{12}\.json$/);
  assert.equal(row.data.id, row.path.slice("households/house-a/recipes/".length, -".json".length));
  assert.equal(row.data.legacyId, OLD);
  assert.equal(
    idb.has(`recipes/${OLD}.json`),
    false,
    "the bank-path record is gone from the phone",
  );
  assert.equal(idb.get(row.path)?.branch, "supabase", "stamped once it landed");
  // the plan entry that names the old id resolves through the pool
  const byId = recipesById(withHouseRecipes([], [[row.data]]));
  assert.equal(byId.get(OLD)?.name, "Quick curry");
  installBackend(null);
});
