// Mise 2.0, seam fix loop 1, items 3 and 4 (Red Team 3 and 4). A refused
// profiles.json write reads as the server copy, like every other refused
// record. With a session, the sync scope is chosen from the pinned profile,
// never from an old localStorage value, and SWITCH PROFILE is the admin's.
// Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv, settle } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { readProfiles, inSyncScope, setSyncScope, canSwitchProfile, resetFileChecks } =
  await import("../app/lib/store.js");
const { ADMIN_DEVICE_KEY } = await import("../app/lib/privacy.js");

const ROSTER = [
  { id: "admin-1", household: "house-b", admin: true },
  { id: "housemate-1", household: "house-a" },
  { id: "housemate-2", household: "house-a" },
];

/** @param {{ slug: string, admin: boolean, home: string }} me */
function signIn(me) {
  const sb = fakeSupabase();
  sb.roster.profiles = ROSTER.map((p) => ({
    id: p.id,
    roster: {},
    household: p.household,
    family: null,
    admin: Boolean(p.admin),
  }));
  installBackend(createSupabaseAdapter({ client: sb.client, session: () => me }));
  return sb;
}

test("a refused profiles.json write reads as the server copy", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  signIn({ slug: "housemate-1", admin: false, home: "house-a" });
  const server = { profiles: ROSTER };
  const forged = { profiles: ROSTER.map((p) => ({ ...p, admin: true })) };
  idb.set("profiles.json", {
    path: "profiles.json",
    data: forged,
    base: server,
    sha: "pg:1",
    dirty: true,
    queuedAt: 1,
    rev: 2,
    branch: "supabase",
    refused: { reason: "forbidden", at: 1 },
  });
  const got = await readProfiles();
  assert.deepEqual(got.profiles, ROSTER, "the refused local roster is not the truth");
  await settle();
  installBackend(null);
  await setSyncScope(null);
});

test("with a session the scope follows the pinned profile, not localStorage", async () => {
  idb.clear();
  kv.clear();
  resetFileChecks();
  signIn({ slug: "housemate-1", admin: false, home: "house-a" });
  // an old 1.8 phone: the admin was picked once and the device flag is set
  kv.set("mise.activeProfile", "admin-1");
  kv.set(ADMIN_DEVICE_KEY, "1");
  idb.set("profiles.json", {
    path: "profiles.json",
    data: { profiles: ROSTER },
    base: { profiles: ROSTER },
    sha: "pg:1",
    dirty: false,
    queuedAt: null,
    rev: 1,
    branch: "supabase",
  });
  await readProfiles();
  assert.equal(inSyncScope("households/house-a/events.json"), true, "my house syncs");
  assert.equal(inSyncScope("households/house-b/events.json"), false, "the admin's house does not");
  await settle();
  installBackend(null);
  await setSyncScope(null);
});

test("SWITCH PROFILE is the signed-in admin's on Supabase, and 1.95 on GitHub", () => {
  installBackend(null);
  assert.equal(canSwitchProfile(), true, "GitHub: unchanged");
  signIn({ slug: "housemate-1", admin: false, home: "house-a" });
  assert.equal(canSwitchProfile(), false);
  signIn({ slug: "admin-1", admin: true, home: "house-b" });
  assert.equal(canSwitchProfile(), true);
  installBackend(null);
});
