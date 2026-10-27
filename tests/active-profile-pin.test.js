// Mise 2.0, plan section 5 (ENG L2-2): SWITCH PROFILE is the admin's alone.
// On Supabase a non-admin's activeProfile() is their own slug whatever
// localStorage says, so a stale or typed value can never point their writes
// (a partial targets file, someone else's plan) at another person's files.
import test from "node:test";
import assert from "node:assert/strict";
import { kv } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");
const { installBackend } = await import("../app/lib/backend.js");
const { activeProfile, scoped } = await import("../app/lib/store.js");
const { ROOT_PROFILE } = await import("../app/lib/backend/config.js");

/** @param {{ slug: string, admin: boolean, home: string | null } | null} who */
const signIn = (who) =>
  installBackend(createSupabaseAdapter({ client: fakeSupabase().client, session: () => who }));

test("a non-admin is always themselves, whatever localStorage says", () => {
  kv.set("mise.activeProfile", "housemate-2");
  signIn({ slug: "housemate-1", admin: false, home: "house-a" });
  assert.equal(activeProfile(), "housemate-1");
  assert.equal(scoped("shopping.json"), "profiles/housemate-1/shopping.json");
  kv.delete("mise.activeProfile");
  assert.equal(activeProfile(), "housemate-1", "and with nothing stored");
  kv.set("mise.activeProfile", ROOT_PROFILE);
  assert.equal(activeProfile(), "housemate-1", "the admin's slug is not a way in");
});

test("the admin may switch", () => {
  signIn({ slug: ROOT_PROFILE, admin: true, home: "house-a" });
  kv.set("mise.activeProfile", "housemate-2");
  assert.equal(activeProfile(), "housemate-2");
  kv.delete("mise.activeProfile");
  assert.equal(activeProfile(), ROOT_PROFILE);
});

test("signed out on Supabase, and on GitHub, the 1.95 rule stands", () => {
  signIn(null);
  kv.set("mise.activeProfile", "housemate-2");
  assert.equal(activeProfile(), "housemate-2");
  installBackend(null);
  assert.equal(activeProfile(), "housemate-2");
  kv.delete("mise.activeProfile");
  assert.equal(activeProfile(), ROOT_PROFILE);
});
