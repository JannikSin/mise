// Mise 2.0 D1/D2, the seam gate's sign-in conditions (ENG F3, RT9): the
// order of operations when a phone signs in, changes account, signs out or
// is revoked. Part 1 drives createSessionBoot against a recording fake of
// the seam; part 2 runs the same flow against the REAL seam modules once
// they are on the same branch (wip-2.0), and is a named todo until then.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createSessionBoot,
  accountSource,
  canSwitchHere,
  setAccountSource,
} from "../app/lib/session-boot.js";

/** a recording seam: every call appended to `log` */
function fakeSeam() {
  /** @type {string[]} */
  const log = [];
  /** @type {any} */
  let installed = null;
  const seam = {
    installBackend: (/** @type {any} */ b) => {
      installed = b;
      log.push(`install:${b.name}`);
    },
    lockedBackend: () => ({ name: "locked" }),
    createSupabaseAdapter: (/** @type {any} */ o) => ({ name: "supabase", session: o.session }),
    createCompositeBackend: (/** @type {any} */ o) => ({
      name: `composite(${o.primary.name}+${o.github.name})`,
      session: o.primary.session,
    }),
    createGithubAdapter: () => ({ name: "github" }),
    onSessionChange: async (/** @type {any} */ a, /** @type {any} */ b) => {
      log.push(`session:${a}->${b}`);
    },
    resetFileChecks: () => log.push("reset"),
    flushNow: async () => log.push("flush"),
    purgeEverything: async () => log.push("PURGE"),
    refusedRecords: async () => [{ path: "plans/2026-W44.json", reason: "name", at: 1 }],
    discardRefused: async (/** @type {string} */ p) => (log.push(`discard:${p}`), true),
  };
  return { seam, log, installed: () => installed };
}

/** @param {Record<string, string>} [init] */
function mem(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (/** @type {string} */ k) => m.get(k) ?? null,
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => void m.set(k, v),
    removeItem: (/** @type {string} */ k) => void m.delete(k),
    m,
  };
}

/**
 * @param {{ session?: any, whoami?: any }} o
 */
function fakeClient(o) {
  /** @type {any[]} */
  const listeners = [];
  return {
    auth: {
      getSession: async () => ({ data: { session: o.session ?? null } }),
      onAuthStateChange: (/** @type {any} */ f) => listeners.push(f),
      signOut: async () => {},
    },
    rpc: async (/** @type {string} */ name) =>
      name === "whoami"
        ? typeof o.whoami === "function"
          ? o.whoami()
          : o.whoami
        : { data: { profiles: [{ id: "housemate-1", household: "house-w" }] }, error: null },
    fire: (/** @type {string} */ e, /** @type {any} */ s) => listeners.forEach((f) => f(e, s)),
  };
}

const SESSION = { access_token: "t", user: { id: "u1", email: "housemate-1@example.test" } };
const PROJECT = { stamp: "supabase-sandbox", label: /** @type {const} */ ("sandbox") };

test("no session: locked, nothing flushed, no switch, no account in Settings", async () => {
  setAccountSource(null);
  const { seam, log } = fakeSeam();
  const boot = createSessionBoot({
    client: fakeClient({}),
    seam,
    project: PROJECT,
    storage: mem(),
  });
  assert.equal(await boot.boot(), "signed-out");
  assert.deepEqual(log, ["install:locked", "reset"], "writes blocked: only the locked backend");
  assert.equal(canSwitchHere(), false);
  assert.equal(accountSource(), null);
});

test("a session: locked first, then onSessionChange, install, reset checks, THEN flush", async () => {
  const { seam, log, installed } = fakeSeam();
  const store = mem();
  const client = fakeClient({
    session: SESSION,
    whoami: { data: { slug: "housemate-1", admin: false, home: "house-w" }, error: null },
  });
  const boot = createSessionBoot({ client, seam, project: PROJECT, storage: store });
  assert.equal(await boot.boot(), "signed-in");
  // the seam's order (loop 2): the locked backend is in when onSessionChange runs
  assert.deepEqual(log, [
    "install:locked",
    "reset",
    "install:locked",
    "reset",
    "session:null->housemate-1",
    "install:supabase",
    "reset",
    "flush",
  ]);
  assert.equal(installed().session().slug, "housemate-1");
  assert.equal(store.m.get("mise.signedInSlug"), "housemate-1");
  assert.equal(canSwitchHere(), false, "a non-admin never switches profile");
  const src = accountSource();
  assert.equal(src?.account.slug, "housemate-1");
  assert.equal(src?.account.email, "housemate-1@example.test");
  assert.deepEqual(
    (await src?.refused())?.map((r) => r.reason),
    ["name"],
  );
  assert.equal(await src?.discard("plans/2026-W44.json"), true);
  assert.ok(log.includes("discard:plans/2026-W44.json"));
});

test("onSessionChange runs on every good whoami (idempotent in the store); a different account is a change", async () => {
  const { seam, log } = fakeSeam();
  const store = mem({ "mise.signedInSlug": "housemate-1" });
  const same = createSessionBoot({
    client: fakeClient({
      session: SESSION,
      whoami: { data: { slug: "housemate-1", admin: false }, error: null },
    }),
    seam,
    project: PROJECT,
    storage: store,
  });
  await same.boot();
  assert.ok(log.includes("session:housemate-1->housemate-1"), "the same account is still reported (seam loop 2)");
  log.length = 0;
  const other = createSessionBoot({
    client: fakeClient({
      session: SESSION,
      whoami: { data: { slug: "guest-a", admin: false }, error: null },
    }),
    seam,
    project: PROJECT,
    storage: store,
  });
  await other.boot();
  assert.ok(
    log.includes("session:housemate-1->guest-a"),
    "account change goes through the store hook",
  );
  assert.ok(
    log.indexOf("session:housemate-1->guest-a") < log.indexOf("install:supabase"),
    "purged before the new backend reads",
  );
});

test("the admin (root profile) gets the composite lane and may switch profile", async () => {
  const { seam, log } = fakeSeam();
  const client = fakeClient({
    session: SESSION,
    whoami: { data: { slug: "david", admin: true, home: "house-w" }, error: null },
  });
  await createSessionBoot({ client, seam, project: PROJECT, storage: mem() }).boot();
  assert.ok(log.includes("install:composite(supabase+github)"));
  assert.equal(canSwitchHere(), true);
});

test("an auth error or no signal never purges: locked, queue kept (a 401 or 403 is 'expired', E5)", async () => {
  for (const [whoami, want] of /** @type {const} */ ([
    [{ data: null, error: { status: 401, code: "PGRST301" } }, "expired"],
    [{ data: null, error: { status: 403, code: "42501" } }, "expired"],
    [{ data: null, error: { status: 503, message: "upstream" } }, "offline"],
    [() => Promise.reject(new TypeError("Failed to fetch")), "offline"],
  ])) {
    const { seam, log } = fakeSeam();
    const r = await createSessionBoot({
      client: fakeClient({ session: SESSION, whoami }),
      seam,
      project: PROJECT,
      storage: mem({ "mise.signedInSlug": "housemate-1" }),
    }).boot();
    assert.equal(r, want);
    assert.equal(log.includes("PURGE"), false);
    assert.equal(log.includes("flush"), false);
    assert.equal(log.at(-2), "install:locked");
  }
});

test("a CONFIRMED revoke (signed in, no profile) purges everything and signs the store out", async () => {
  const { seam, log } = fakeSeam();
  const store = mem({ "mise.signedInSlug": "housemate-1" });
  const r = await createSessionBoot({
    client: fakeClient({ session: SESSION, whoami: { data: null, error: null } }),
    seam,
    project: PROJECT,
    storage: store,
  }).boot();
  assert.equal(r, "revoked");
  assert.ok(log.includes("PURGE"));
  assert.ok(log.indexOf("install:locked", 2) < log.indexOf("PURGE"), "locked before the purge");
  assert.ok(log.includes("session:housemate-1->null"));
  assert.equal(store.m.has("mise.signedInSlug"), false);
});

test("sign out (here or in another tab) locks the store and runs the hook", async () => {
  const { seam, log } = fakeSeam();
  const client = fakeClient({
    session: SESSION,
    whoami: { data: { slug: "housemate-1", admin: false }, error: null },
  });
  const store = mem();
  const boot = createSessionBoot({ client, seam, project: PROJECT, storage: store });
  await boot.boot();
  log.length = 0;
  client.fire("SIGNED_OUT", null);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(log, ["install:locked", "reset", "session:housemate-1->null"]);
  assert.equal(accountSource(), null);
  assert.equal(canSwitchHere(), false);
});

// ---- part 2: the real seam modules (wip-2.0) ------------------------------

const SEAM_FILES = [
  "../app/lib/backend.js",
  "../app/lib/backend/supabase-adapter.js",
  "../app/lib/backend/composite.js",
].map((p) => fileURLToPath(new URL(p, import.meta.url)));
const seamHere = SEAM_FILES.every((f) => existsSync(f));

test(
  "end to end on the real seam: sign-in installs the real adapter, which reads as the signed-in person",
  {
    todo: seamHere
      ? false
      : "OWNER schelkin: runs on wip-2.0 once the seam lane's backend.js, supabase-adapter.js and composite.js are merged with this lane",
  },
  async () => {
    if (!seamHere) return;
    const backendMod = /** @type {any} */ (await import("../app/lib/backend.js"));
    const adapterMod = /** @type {any} */ (await import("../app/lib/backend/supabase-adapter.js"));
    const compositeMod = /** @type {any} */ (await import("../app/lib/backend/composite.js"));
    /** @type {string[]} */
    const log = [];
    const client = fakeClient({
      session: SESSION,
      whoami: { data: { slug: "housemate-1", admin: false, home: "house-w" }, error: null },
    });
    const boot = createSessionBoot({
      client,
      project: PROJECT,
      storage: mem(),
      seam: {
        installBackend: backendMod.installBackend,
        lockedBackend: backendMod.lockedBackend,
        createSupabaseAdapter: adapterMod.createSupabaseAdapter,
        createCompositeBackend: compositeMod.createCompositeBackend,
        onSessionChange: async (/** @type {any} */ a, /** @type {any} */ b) =>
          void log.push(`${a}->${b}`),
        resetFileChecks: () => log.push("reset"),
        flushNow: async () => log.push("flush"),
        purgeEverything: async () => log.push("PURGE"),
      },
    });
    assert.equal(await boot.boot(), "signed-in");
    const b = backendMod.backend();
    assert.equal(b.name, "supabase");
    assert.equal(b.session()?.slug, "housemate-1");
    assert.deepEqual(log, ["reset", "reset", "null->housemate-1", "reset", "flush"]);
    backendMod.installBackend(null);
  },
);
