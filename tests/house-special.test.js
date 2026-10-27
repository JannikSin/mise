// Mise 2.0, plan item E1 (ENG 3, ENG L2-4): an AI dinner special on
// Supabase is written to the inventing house's recipes under an opaque
// house-<12 hex> id, never to the shared bank; on GitHub it is the 1.95
// bank write, unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { idb } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { specialTarget, isHouseRecipeId } = await import("../app/lib/house-special.js");
const { createSupabaseAdapter, classifyPath } =
  await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { write, flushNow, resetFileChecks } = await import("../app/lib/store.js");

test("on GitHub the special keeps its 1.95 bank id and path", () => {
  assert.deepEqual(specialTarget("github", "house-a", "special-quick-curry-2026-10-27"), {
    id: "special-quick-curry-2026-10-27",
    path: "recipes/special-quick-curry-2026-10-27.json",
  });
});

test("on Supabase it is the house's, under an opaque id that names nothing", () => {
  const t = specialTarget("supabase", "house-a", "special-guest-a-curry-2026-10-27");
  assert.match(t.id, /^house-[0-9a-f]{12}$/);
  assert.equal(t.path, `households/house-a/recipes/${t.id}.json`);
  assert.ok(!t.id.includes("curry") && !t.id.includes("guest"), "the dish name is not in the id");
  assert.equal(isHouseRecipeId(t.id), true);
  assert.equal(classifyPath(t.path).kind, "doc", "a house row, not a bank row");
  const ids = new Set(
    Array.from({ length: 50 }, () => specialTarget("supabase", "house-a", "x").id),
  );
  assert.equal(ids.size, 50, "two specials on one night never share an id");
  assert.throws(() => specialTarget("supabase", "", "x"), /no house/);
  assert.throws(() => specialTarget("supabase", "../bank", "x"), /no house/);
  assert.equal(
    specialTarget("supabase", "house-a", "x", () => "abcdef012345").id,
    "house-abcdef012345",
  );
});

test("the special lands in the house's recipes on the server, not the bank", async () => {
  idb.clear();
  resetFileChecks();
  const sb = fakeSupabase({ isAdmin: () => false });
  installBackend(
    createSupabaseAdapter({
      client: sb.client,
      session: () => ({ slug: "housemate-1", admin: false, home: "house-a" }),
    }),
  );
  const t = specialTarget("supabase", "house-a", "special-x-2026-10-27");
  await write(t.path, { id: t.id, name: "Quick curry", tags: ["ai-special"] }, { raw: true });
  assert.equal((await flushNow({ timeoutMs: 3000 })).landed, true);
  assert.equal(sb.docs.get(t.path)?.data.id, t.id, "the id matches the file name");
  assert.equal(sb.recipes.size, 0, "nothing reached the shared bank");
  installBackend(null);
});

test("main.js writes the special through specialTarget (spelling check)", () => {
  const src = readFileSync(new URL("../app/main.js", import.meta.url), "utf8");
  assert.match(src, /specialTarget\(\s*backend\(\)\.name,\s*myHouseOf\(\),/);
  assert.match(src, /await write\(target\.path, /);
  assert.ok(!src.includes("await write(`recipes/${recipeId}.json`"));
});
