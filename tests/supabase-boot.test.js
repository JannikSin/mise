// Mise 2.0 worker fix loop 1, item 15: the Supabase shell's boot
// (app/lib/supabase-boot.js) and its wiring in main.js. The client is a fake
// standing in for the vendored supabase-js; the store, the backend seam and
// the session boot are the real modules. The GitHub shell must not change.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kv, idb } from "./helpers/fake-browser.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const { startSupabase } = await import("../app/lib/supabase-boot.js");
const { authClient } = await import("../app/views/auth-gate.js");
const { canSwitchHere } = await import("../app/lib/session-boot.js");
const backendMod = await import("../app/lib/backend.js");

const PROJECT = { url: "https://placeholderref01.supabase.co", publishableKey: "sb_publishable_TESTONLY", stamp: "supabase" };

/** a supabase-js stand-in over the in-memory project @param {any} who @param {{ admin?: boolean }} [o] */
function fakeCreateClient(who) {
  /** @type {any[]} */
  const made = [];
  const sb = fakeSupabase({});
  const create = (/** @type {string} */ url, /** @type {string} */ key, /** @type {any} */ options) => {
    const client = {
      from: (/** @type {string} */ t) => sb.client.from(t),
      rpc: async (/** @type {string} */ name, /** @type {any} */ args) =>
        name === "whoami" ? { data: who, error: null } : sb.client.rpc(name, args),
      auth: {
        onAuthStateChange: () => {},
        getSession: async () => ({ data: { session: { user: { id: "u1", email: "x@example.test" }, access_token: "t1" } } }),
        signOut: async () => {},
        signInWithPassword: async () => ({}),
        verifyOtp: async () => ({}),
        updateUser: async () => ({}),
        resetPasswordForEmail: async () => ({}),
      },
    };
    made.push({ url, key, options, client });
    return client;
  };
  return { create, made };
}

function fresh() {
  kv.clear();
  idb.clear();
  backendMod.installBackend(null);
}

test("a placeholder project makes no client: the gate says sign-in is not set up", () => {
  fresh();
  assert.equal(startSupabase({ project: { url: "https://YOUR-PROJECT.supabase.co", publishableKey: "sb_publishable_PLACEHOLDER", stamp: "supabase" } }), null);
  assert.equal(authClient(), null);
  assert.equal(startSupabase({ project: null }), null);
});

test("a configured project: one client, URL detection off, the gate gets its auth, SWITCH hidden until boot answers", async () => {
  fresh();
  const f = fakeCreateClient({ slug: "housemate-1", admin: false, home: "house-a" });
  const s = startSupabase({ project: PROJECT, createClientImpl: f.create });
  assert.ok(s);
  assert.equal(f.made.length, 1);
  assert.equal(f.made[0].url, PROJECT.url);
  assert.equal(f.made[0].options.auth.detectSessionInUrl, false, "the SET PASSWORD tap spends the token, never supabase-js");
  assert.equal(authClient(), f.made[0].client.auth);
  assert.equal(canSwitchHere(), false, "C3: hidden before the boot resolves");
  assert.equal(await s?.boot(), "signed-in");
  assert.equal(backendMod.backend().session()?.slug, "housemate-1", "the real adapter is in");
  assert.equal(kv.get("mise.activeProfile"), "housemate-1", "a member always opens as themselves");
  assert.equal(canSwitchHere(), false, "a member never switches");
  backendMod.installBackend(null);
});

test("the admin keeps the profile already picked on this phone, and may switch", async () => {
  fresh();
  kv.set("mise.activeProfile", "housemate-1");
  const f = fakeCreateClient({ slug: "host-1", admin: true, home: "house-a" });
  const s = startSupabase({ project: PROJECT, createClientImpl: f.create });
  assert.equal(await s?.boot(), "signed-in");
  assert.equal(kv.get("mise.activeProfile"), "housemate-1");
  assert.equal(canSwitchHere(), true);
  backendMod.installBackend(null);
});

test("main.js: the GitHub shell renders as 1.95; the Supabase boot is a dynamic import on the Supabase branch only", () => {
  const src = readFileSync(new URL("../app/main.js", import.meta.url), "utf8");
  assert.equal(/^import[^;]*supabase-boot|^import[^;]*vendor\/supabase-js/m.test(src), false, "no static import");
  const block = src.slice(src.indexOf('const root = document.getElementById("app");'));
  assert.match(block, /if \(backendKind !== "supabase"\) \{\s*draw\(appNode\(\)\);\s*\} else \{/);
  const github = block.slice(0, block.indexOf("} else {"));
  assert.equal(/supabase-boot|startSupabase|boot\(\)/.test(github), false, "the GitHub branch never boots Supabase");
  assert.match(block, /await import\("\.\/lib\/supabase-boot\.js"\)\)\.startSupabase\(\)/);
  assert.match(block, /gateAfterBoot\(result\)/, "a dead session or a removed account goes back to the gate");
  // appNode is the 1.95 expression, unchanged
  assert.match(block, /localStorage\.getItem\("mise\.activeProfile"\)\s*\? html`<\$\{App\} \/>`\s*: guestLink\s*\? html`<\$\{GuestLinkRoot\} \/>`\s*: html`<\$\{ProfileGateView\} \/>`/);
});

test("the sandbox shell's meta is documented, and this shell carries none", () => {
  const doc = readFileSync(new URL("../docs/supabase-shell.md", import.meta.url), "utf8");
  assert.match(doc, /<meta name="mise-backend" content="supabase">/);
  assert.match(doc, /connect-src/);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(/name="mise-backend"/.test(html), false);
});
