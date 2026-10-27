// THE SIGN-IN SIDE OF THE SEAM (Mise 2.0, D1 and D2; the seam gate's fix
// list, "Goes to the sign-in lane": ENG F3 and RT9; P3 knows-you).
//
// On a Supabase shell this is the one place that turns a supabase-js session
// into a working store, and back:
//   1. Boot installs the LOCKED backend first, so nothing is read or sent
//      before there is a session (writes stay queued, the flush stops on the
//      locked backend's AuthError and keeps the queue).
//   2. A session is turned into who-is-asking by `whoami` (slug, admin, home).
//      The store's `onSessionChange(prev, next)` runs on EVERY account change,
//      so the store purges what the previous account cached and holds what it
//      queued (seam fix 1).
//   3. The Supabase adapter is installed (composite with GitHub for the admin,
//      whose daily log and the Anvil mirror stay on GitHub). After EVERY
//      installBackend: file checks are reset, then the queue is flushed.
//   4. purgeEverything runs ONLY on a CONFIRMED revoke (the account is signed
//      in but has no profile any more), never on an AuthError, an expired
//      token or no signal.
//   5. Sign-out installs the locked backend again.
//
// Every store and backend function arrives INJECTED (`seam`), so this file
// imports nothing from the seam lane and is tested with fakes here; the same
// test file runs once more against the real modules on wip-2.0
// (tests/session-boot.test.js, the "real seam" block).
//
// Settings reads the signed-in facts through `accountSource()`, which this
// module fills; on the GitHub backend it stays null and Settings is 1.95.

/**
 * @typedef {{ slug: string, admin: boolean, home: string | null }} WhoAmI
 * @typedef {{
 *   installBackend: (b: any) => void,
 *   lockedBackend: () => any,
 *   createSupabaseAdapter: (o: { client: any, session: () => WhoAmI | null, accessToken?: () => string | null, stamp?: string }) => any,
 *   createCompositeBackend?: (o: { primary: any, github: any }) => any,
 *   createGithubAdapter?: () => any,
 *   onSessionChange: (prev: string | null, next: string | null) => Promise<void> | void,
 *   resetFileChecks: () => void,
 *   flushNow: () => Promise<unknown>,
 *   purgeEverything: () => Promise<unknown>,
 *   refusedRecords?: () => Promise<{ path: string, reason: string, at: number }[]>,
 *   discardRefused?: (path: string) => Promise<boolean>,
 *   canSwitchProfile?: () => boolean,
 * }} Seam
 */

const LAST_SLUG = "mise.signedInSlug";

/** @type {null | (() => any)} */
let source = null;

/**
 * What Settings needs about the account, or null on the GitHub backend.
 * @returns {null | {
 *   account: { email: string, slug: string, admin: boolean, project: "live" | "sandbox" },
 *   roster: () => Promise<any[]>,
 *   refused: () => Promise<{ path: string, reason: string, at: number }[]>,
 *   discard: (path: string) => Promise<boolean>,
 *   signOut: () => Promise<void>,
 * }}
 */
export function accountSource() {
  try {
    return source ? source() : null;
  } catch {
    return null;
  }
}

/** @param {null | (() => any)} f */
export function setAccountSource(f) {
  source = f;
}

/** @type {() => boolean} */
let switchRule = () => true;

/**
 * May this phone show SWITCH PROFILE? 1.95 (GitHub): yes. Signed in on
 * Supabase: only the admin (seam canSwitchProfile).
 */
export function canSwitchHere() {
  try {
    return switchRule();
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   client: any,
 *   seam: Seam,
 *   project: { stamp: string, label: "live" | "sandbox" },
 *   rootProfile?: string,
 *   storage?: { getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void } | null,
 * }} o
 */
export function createSessionBoot({
  client,
  seam,
  project,
  rootProfile = "david",
  storage = null,
}) {
  /** @type {WhoAmI | null} */
  let who = null;
  let email = "";
  let token = "";
  /** the auth user this boot last adopted, so a repeated SIGNED_IN is a no-op */
  let lastUser = "";
  const store = storage ?? safeStorage();
  const lastSlug = () => {
    try {
      return store?.getItem(LAST_SLUG) ?? null;
    } catch {
      return null;
    }
  };
  const rememberSlug = (/** @type {string | null} */ s) => {
    try {
      if (s) store?.setItem(LAST_SLUG, s);
      else store?.removeItem(LAST_SLUG);
    } catch {
      // storage refused: the store's own record of the slug still guards it
    }
  };

  /** @param {any} b */
  const install = async (b) => {
    seam.installBackend(b);
    seam.resetFileChecks();
    await seam.flushNow();
  };

  const lock = async () => {
    seam.installBackend(seam.lockedBackend());
    seam.resetFileChecks();
  };

  const dropSession = async () => {
    const prev = lastSlug();
    who = null;
    token = "";
    await lock();
    await seam.onSessionChange(prev, null);
    rememberSlug(null);
    setAccountSource(null);
    switchRule = () => false;
  };

  /** sign out: the server session ends, the store goes back to locked */
  const signOut = async () => {
    await Promise.resolve(client.auth?.signOut?.()).catch(() => {});
    await dropSession();
  };

  /**
   * Turn a session into a store. Returns what happened.
   * @param {any} session supabase-js session
   * @returns {Promise<"signed-in" | "revoked" | "offline">}
   */
  const adopt = async (session) => {
    const r = await Promise.resolve(client.rpc("whoami")).catch((/** @type {any} */ e) => ({
      data: null,
      error: e ?? { message: "network" },
    }));
    if (r?.error) {
      // an auth error, an expired token or no signal: keep the queue and the
      // cache, stay locked, never purge
      await lock();
      return "offline";
    }
    const me = r?.data;
    if (!me || typeof me.slug !== "string" || !me.slug) {
      // signed in, but the account no longer has a profile: a CONFIRMED revoke
      const prev = lastSlug();
      await lock();
      await seam.purgeEverything();
      await seam.onSessionChange(prev, null);
      rememberSlug(null);
      who = null;
      return "revoked";
    }
    const next = {
      slug: me.slug,
      admin: me.admin === true,
      home: typeof me.home === "string" ? me.home : null,
    };
    const prev = lastSlug();
    if (prev !== next.slug) await seam.onSessionChange(prev, next.slug);
    rememberSlug(next.slug);
    who = next;
    email = String(session?.user?.email ?? "");
    token = String(session?.access_token ?? "");
    const primary = seam.createSupabaseAdapter({
      client,
      session: () => who,
      accessToken: () => token || null,
      stamp: project.stamp,
    });
    const useGithub =
      next.slug === rootProfile && seam.createCompositeBackend && seam.createGithubAdapter;
    const backend = useGithub
      ? /** @type {NonNullable<Seam["createCompositeBackend"]>} */ (seam.createCompositeBackend)({
          primary,
          github: /** @type {NonNullable<Seam["createGithubAdapter"]>} */ (
            seam.createGithubAdapter
          )(),
        })
      : primary;
    await install(backend);
    switchRule = seam.canSwitchProfile ?? (() => next.admin);
    setAccountSource(() =>
      who
        ? {
            account: { email, slug: who.slug, admin: who.admin, project: project.label },
            roster: async () => {
              const rr = await client.rpc("roster");
              return Array.isArray(rr?.data?.profiles) ? rr.data.profiles : [];
            },
            refused: seam.refusedRecords ?? (async () => []),
            discard: seam.discardRefused ?? (async () => false),
            signOut,
          }
        : null,
    );
    return "signed-in";
  };

  /**
   * Boot: locked first, then the persisted session if there is one, and
   * follow later changes (another tab signing out, a refreshed token).
   * @returns {Promise<"signed-in" | "signed-out" | "revoked" | "offline">}
   */
  const boot = async () => {
    await lock();
    switchRule = () => false;
    client.auth?.onAuthStateChange?.((/** @type {string} */ event, /** @type {any} */ session) => {
      if (event === "SIGNED_OUT") void dropSession();
      else if (event === "TOKEN_REFRESHED" && session?.access_token) token = session.access_token;
      else if (
        event === "SIGNED_IN" &&
        session &&
        session.user?.id &&
        session.user.id !== lastUser
      ) {
        lastUser = session.user.id;
        void adopt(session);
      }
    });
    const g = await Promise.resolve(client.auth.getSession()).catch(() => ({
      data: { session: null },
    }));
    const session = g?.data?.session ?? null;
    if (!session) return "signed-out";
    lastUser = String(session.user?.id ?? "");
    return adopt(session);
  };

  return { boot, adopt, signOut, whoNow: () => who };
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
