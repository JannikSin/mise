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
 *   onSessionChange: (prev: string | null, next: string | null) => Promise<unknown> | void,
 *   resetFileChecks: () => void,
 *   flushNow: () => Promise<unknown>,
 *   purgeEverything: () => Promise<unknown>,
 *   refusedRecords?: () => Promise<{ path: string, id?: string, reason: string, at: number }[]>,
 *   discardRefused?: (id: string) => Promise<boolean>,
 *   canSwitchProfile?: () => boolean,
 *   acquireStoreLock?: () => Promise<() => void>,
 * }} Seam
 */

const LAST_SLUG = "mise.signedInSlug";
/** the auth user id last adopted on this phone (seam Red Team S4) */
const LAST_USER = "mise.signedInUser";

/** @type {null | (() => any)} */
let source = null;

/**
 * What Settings needs about the account, or null on the GitHub backend.
 * @returns {null | {
 *   account: { email: string, slug: string, admin: boolean, project: "live" | "sandbox" },
 *   roster: () => Promise<any[]>,
 *   refused: () => Promise<{ path: string, id?: string, reason: string, at: number }[]>,
 *   discard: (id: string) => Promise<boolean>,
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
  // C3: from the moment a Supabase boot exists, SWITCH PROFILE stays hidden
  // until a whoami has said who this is
  switchRule = () => false;
  /** @param {string} key */
  const recall = (key) => {
    try {
      return store?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  /** @param {string} key @param {string | null} v */
  const remember = (key, v) => {
    try {
      if (v) store?.setItem(key, v);
      else store?.removeItem(key);
    } catch {
      // storage refused: the store's own record of the account still guards it
    }
  };
  const lastSlug = () => recall(LAST_SLUG);
  const rememberSlug = (/** @type {string | null} */ s) => remember(LAST_SLUG, s);

  // THE STORE LOCK (worker gate E4, seam fix 15): every account switch runs
  // holding it, so a push that started under one account has finished
  // before the next account's session goes in, and none starts mid-switch.
  // The flush after an install runs once the lock is released.
  const acquire = async () => (seam.acquireStoreLock ? await seam.acquireStoreLock() : () => {});
  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const switching = async (fn) => {
    const release = await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const lock = async () => {
    seam.installBackend(seam.lockedBackend());
    seam.resetFileChecks();
  };

  /** forget the account on this phone; the caller holds the store lock */
  const forget = async () => {
    const prev = lastSlug();
    who = null;
    token = "";
    await lock();
    await seam.onSessionChange(prev, null);
    rememberSlug(null);
    remember(LAST_USER, null);
    setAccountSource(null);
    switchRule = () => false;
  };

  const dropSession = () => switching(forget);

  /** sign out: the server session ends, the store goes back to locked */
  const signOut = async () => {
    await Promise.resolve(client.auth?.signOut?.()).catch(() => {});
    lastUser = "";
    await dropSession();
  };

  /**
   * Turn a session into a store. Returns what happened.
   *
   * A DIFFERENT auth user than the one last adopted on this phone (an invite
   * link opened on a signed-in phone, no sign-out first) is switched away
   * BEFORE whoami, holding the store lock until the new backend is in (seam
   * Red Team N3, R1b, S4): the locked backend goes in and the previous
   * account is dropped (onSessionChange(prev, null) holds its queue and
   * purges its cache). So a flush in the whoami window cannot push A's queue
   * under B's token, and if whoami fails, nothing of A's reads and B's
   * offline writes are made before sign-in, never stamped as A's.
   * @param {any} session supabase-js session
   * @returns {Promise<"signed-in" | "revoked" | "offline" | "expired">}
   */
  const adopt = async (session) => {
    const uid = String(session?.user?.id ?? "");
    const prevUser = recall(LAST_USER);
    /** @type {null | (() => void)} */
    let held = null;
    if (uid && prevUser && prevUser !== uid) {
      held = await acquire();
      await forget();
    }
    /** run under the lock, taking it only if this adopt does not hold it already
     * @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
    const locked = (fn) => (held ? fn() : switching(fn));
    try {
      const r = await Promise.resolve(client.rpc("whoami")).catch((/** @type {any} */ e) => ({
        data: null,
        error: e ?? { message: "network" },
      }));
      if (r?.error) {
        // an auth error, an expired token or no signal: keep the queue and
        // the cache, stay locked, never purge, never onSessionChange (the
        // store keeps its remembered account). A 401 or 403 means the stored
        // session is dead (fix loop 1, E5): "expired" sends the phone back to
        // SIGN IN; anything else is no signal and the app stays on its cache.
        await lock();
        const status = Number(r.error?.status ?? r.error?.code ?? 0);
        return status === 401 || status === 403 ? "expired" : "offline";
      }
      const me = r?.data;
      if (!me || typeof me.slug !== "string" || !me.slug) {
        // signed in, but the account no longer has a profile: a CONFIRMED revoke
        return await locked(async () => {
          const prev = lastSlug();
          await lock();
          await seam.purgeEverything();
          await seam.onSessionChange(prev, null);
          rememberSlug(null);
          remember(LAST_USER, null);
          who = null;
          return /** @type {const} */ ("revoked");
        });
      }
      const next = {
        slug: me.slug,
        admin: me.admin === true,
        home: typeof me.home === "string" ? me.home : null,
      };
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
      await locked(async () => {
        // the seam's order: locked backend in, onSessionChange on EVERY good
        // whoami (it is idempotent), then the new adapter
        const prev = lastSlug();
        await lock();
        await seam.onSessionChange(prev, next.slug);
        rememberSlug(next.slug);
        if (uid) remember(LAST_USER, uid);
        who = next;
        email = String(session?.user?.email ?? "");
        token = String(session?.access_token ?? "");
        seam.installBackend(backend);
        seam.resetFileChecks();
      });
      if (held) {
        held();
        held = null;
      }
      await seam.flushNow();
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
    } finally {
      if (held) held();
    }
  };

  /**
   * Boot: locked first, then the persisted session if there is one, and
   * follow later changes (another tab signing out, a refreshed token).
   * @returns {Promise<"signed-in" | "signed-out" | "revoked" | "offline" | "expired">}
   */
  const boot = async () => {
    await lock();
    switchRule = () => false;
    client.auth?.onAuthStateChange?.((/** @type {string} */ event, /** @type {any} */ session) => {
      if (event === "SIGNED_OUT") {
        lastUser = "";
        void dropSession();
      } else if (event === "TOKEN_REFRESHED" && session?.access_token) token = session.access_token;
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
