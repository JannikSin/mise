// Mise 2.0, seam fix loop 3, item 4 (Red Team 3 S3; P4 store): an offline
// reload on a shared tablet. With no session, a housemate's paths come from
// the account the store remembers, never from a profile pick the admin left
// behind; only the remembered admin keeps the pick. Made-up people only.
import test from "node:test";
import assert from "node:assert/strict";
import { idb, kv } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend, lockedBackend } = await import("../app/lib/backend.js");
const store = await import("../app/lib/store.js");
const { write, read, flushNow, onSessionChange, activeProfile, refusedRecords } = store;

const H1 = { slug: "housemate-1", admin: false, home: "house-a" };
const ADMIN = { slug: "admin-1", admin: true, home: "house-a" };
const LIST = "profiles/housemate-1/shopping.json";

function setup() {
  idb.clear();
  kv.clear();
  store.resetFileChecks();
  const sb = fakeSupabase({
    canWrite: (path) => path.startsWith("profiles/housemate-1/") || path.startsWith("households/"),
  });
  const signIn = (/** @type {typeof H1} */ who) =>
    installBackend(createSupabaseAdapter({ client: sb.client, session: () => who }));
  return { sb, signIn };
}

test("Q5: offline, her milk tick lands on her own list, not the profile the admin left picked", async () => {
  const { sb, signIn } = setup();
  signIn(H1);
  await onSessionChange(null, H1.slug);
  kv.set("mise.activeProfile", "admin-1");
  assert.equal(activeProfile(), H1.slug);

  // offline reload: locked backend, no session
  installBackend(lockedBackend());
  store.resetFileChecks();
  assert.equal(activeProfile(), H1.slug, "still pinned to herself");
  await write("shopping.json", { items: [{ name: "milk", ticked: true }] });
  assert.ok(idb.has(LIST), "the tick is at her own path");
  assert.equal(idb.has("shopping.json"), false);
  assert.equal(idb.get(LIST).account, H1.slug);
  assert.deepEqual(await read("shopping.json"), { items: [{ name: "milk", ticked: true }] });

  // signal back: it lands, nothing refused
  signIn(H1);
  const r = await flushNow({ timeoutMs: 1000 });
  assert.equal(r.landed, true);
  assert.deepEqual(sb.docs.get(LIST)?.data, { items: [{ name: "milk", ticked: true }] });
  assert.deepEqual(await refusedRecords(), []);
  installBackend(null);
});

test("the admin, once seen with a live session, keeps the profile pick offline", async () => {
  const { signIn } = setup();
  signIn(ADMIN);
  await onSessionChange(null, ADMIN.slug);
  kv.set("mise.activeProfile", "housemate-1");
  assert.equal(activeProfile(), "housemate-1", "online, the admin may switch");
  installBackend(lockedBackend());
  assert.equal(activeProfile(), "housemate-1", "offline too");
  installBackend(null);
});

test("the admin flag can come from the caller, and goes with its account", async () => {
  setup();
  installBackend(lockedBackend());
  kv.set("mise.activeProfile", "housemate-1");
  await onSessionChange(null, ADMIN.slug, { admin: true });
  assert.equal(activeProfile(), "housemate-1", "a remembered admin keeps the pick");
  // the next account is not the admin: the flag does not carry over
  await onSessionChange(ADMIN.slug, "housemate-2");
  assert.equal(activeProfile(), "housemate-2");
  // told explicitly
  await onSessionChange("housemate-2", ADMIN.slug, { admin: true });
  await onSessionChange(ADMIN.slug, ADMIN.slug, { admin: false });
  assert.equal(activeProfile(), ADMIN.slug);
  installBackend(null);
});

test("an admin flag seen for a different account than the remembered one is not taken", async () => {
  setup();
  await onSessionChange(null, "housemate-2");
  kv.set("mise.activeProfile", "housemate-1");
  // a live admin session that is not the remembered account (a switch window)
  installBackend(/** @type {any} */ ({ ...lockedBackend(), session: () => ADMIN }));
  assert.equal(activeProfile(), "housemate-1", "the live admin session picks");
  installBackend(lockedBackend());
  assert.equal(activeProfile(), "housemate-2", "but the remembered non-admin stays pinned");
  installBackend(null);
});

test("a live non-admin session for another account never clears the remembered admin's flag", async () => {
  setup();
  await onSessionChange(null, ADMIN.slug, { admin: true });
  kv.set("mise.activeProfile", "housemate-1");
  installBackend(/** @type {any} */ ({ ...lockedBackend(), session: () => H1 }));
  assert.equal(activeProfile(), H1.slug);
  installBackend(lockedBackend());
  assert.equal(activeProfile(), "housemate-1", "the admin's pick still holds offline");
  installBackend(null);
});

test("never signed in on a Supabase build, or on GitHub: the 1.95 pick", async () => {
  setup();
  installBackend(lockedBackend());
  kv.set("mise.activeProfile", "housemate-1");
  assert.equal(activeProfile(), "housemate-1");
  // GitHub, even with an account left behind by a Supabase build
  installBackend(null);
  assert.equal(store.canSwitchProfile(), true, "the GitHub backend");
  kv.set("mise.storeAccount", "housemate-2");
  assert.equal(activeProfile(), "housemate-1");
});
