// Mise 2.0, plan section 5 (composite lane): on the admin's phone the
// canonical targets land on Supabase and the mirror Anvil reads,
// `fitness/targets.json`, lands on GitHub. A GitHub failure queues the mirror
// without blocking anything bound for Supabase.
import test from "node:test";
import assert from "node:assert/strict";
import { idb } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";
import { fakeGithubLane } from "./helpers/fake-github-lane.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { createCompositeBackend, compositeLaneOf } = await import("../app/lib/backend/composite.js");
const { ROOT_PROFILE } = await import("../app/lib/backend/config.js");
const { installBackend } = await import("../app/lib/backend.js");
const { writeTargetsOf, write, flushNow, resetFileChecks } = await import("../app/lib/store.js");

const ADMIN = { slug: ROOT_PROFILE, admin: true, home: "house-a" };
const TARGETS = { diet: "omnivore", macros: { calories: 3000, protein: 180 } };

function rig() {
  idb.clear();
  resetFileChecks();
  const sb = fakeSupabase();
  const gh = fakeGithubLane();
  const primary = createSupabaseAdapter({ client: sb.client, session: () => ADMIN });
  installBackend(createCompositeBackend({ primary, github: gh.backend }));
  return { sb, gh };
}

test("root fitness/ and health/ go to GitHub, everything else to Supabase", () => {
  assert.equal(compositeLaneOf("fitness/targets.json"), "github");
  assert.equal(compositeLaneOf("fitness/daily.json"), "github");
  assert.equal(compositeLaneOf("health/log.json"), "github");
  assert.equal(compositeLaneOf("profile/targets.json"), "supabase");
  assert.equal(compositeLaneOf("profiles/housemate-1/fitness/targets.json"), "supabase");
  assert.equal(compositeLaneOf("fitnessplan.json"), "supabase");
});

test("both land: canonical on Supabase, the Anvil mirror on GitHub", async () => {
  const { sb, gh } = rig();
  await writeTargetsOf(ROOT_PROFILE, TARGETS);
  const res = await flushNow({ timeoutMs: 3000 });
  assert.equal(res.landed, true);
  assert.deepEqual(sb.docs.get("profile/targets.json")?.data, TARGETS);
  assert.equal(sb.docs.has("fitness/targets.json"), false, "the mirror is not a Supabase row");
  assert.deepEqual(gh.files.get("fitness/targets.json")?.data, TARGETS);
  installBackend(null);
});

test("GitHub down: the mirror queues, Supabase writes still land, then the mirror catches up", async () => {
  const { sb, gh } = rig();
  gh.down = true;
  // the mirror is queued FIRST, so a stop-on-first-error flush would strand
  // everything behind it
  await write("fitness/targets.json", TARGETS, { raw: true });
  await write("profile/targets.json", TARGETS, { raw: true });
  await write("households/house-a/pantry.json", { items: [] }, { raw: true });
  const res = await flushNow({ timeoutMs: 3000 });
  assert.equal(res.landed, false);
  assert.equal(res.pending, 1);
  assert.ok(res.error, "the failure is said, not swallowed");
  assert.deepEqual(sb.docs.get("profile/targets.json")?.data, TARGETS);
  assert.ok(sb.docs.has("households/house-a/pantry.json"));
  assert.equal(idb.get("fitness/targets.json")?.dirty, true);
  gh.down = false;
  const again = await flushNow({ timeoutMs: 3000 });
  assert.equal(again.landed, true);
  assert.deepEqual(gh.files.get("fitness/targets.json")?.data, TARGETS);
  installBackend(null);
});
