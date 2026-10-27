// Offline-first store (CLAUDE.md Part 2, rule 3). Views read and write HERE,
// never against the network directly.
//
//   read:  cache answers instantly; a background revalidate refreshes clean
//          files from GitHub and notifies subscribers.
//   write: lands in the cache immediately (dirty + queuedAt), then flush()
//          pushes queued files in order — with sha, merging on conflict —
//          whenever we're online. Offline writes simply stay queued.

import { dbDeleteIfClean, dbGet, dbGetAll, dbUpdate, dbDelete } from "./db.js";
import { backend, stampHere, replaysHere, installBackend, lockedBackend } from "./backend.js";
import { ForbiddenError, NameGuardError } from "./backend/errors.js";
import { pushFile, afterPushRecord, ConflictError } from "./sync.js";
import { avoidTermsFromAllergens, typedAvoidTerms } from "./targets.js";
import { syncScopeFor, verifiedKey, ADMIN_DEVICE_KEY, keyOf, isAdmin } from "./privacy.js";
import { stricterTargets } from "./stricter-targets.js";
import { holdWrite, FREEZE_PATH, moveOn } from "./freeze.js";
import { specialTarget } from "./house-special.js";

const io = {
  /** @param {string} path */
  read: (path) => backend().read(path),
  /** @param {string} path @param {Record<string, unknown>} data @param {string | null} [sha] */
  write: (path, data, sha) => backend().write(path, data, sha),
};

// THE PURGE EPOCH (2.0, Red Team 8 / ENG F4): bumped by every purge. A fetch
// or a push that started before the purge finds it moved and stores nothing,
// so revoked data can never land back on the phone after it was wiped.
let epoch = 0;

// ONE PHONE, MORE THAN ONE ACCOUNT (2.0, seam fixes 1, 14 and 15; Red Team 1,
// ENG F3; worker gate E4). The sign-in side (session-boot.js) calls
// onSessionChange(prev, next) on every account change and holds the store
// lock (acquireStoreLock) across the switch, so no push that started under
// one account is still in flight when the next one's session goes in.
const ACCOUNT_KEY = "mise.storeAccount";
// how many holders keep the queue from flushing (acquireStoreLock)
let storeLocks = 0;

/**
 * Whose phone this is, for the hold (2.0, seam fix loop 2, item 2; ENG 2 N2):
 * the account the STORE remembers (onSessionChange writes it), never the live
 * session, which is null on an offline reload while the locked backend is in
 * and for one whoami round trip on every boot. The live session counts only
 * when the store has never been told an account. On GitHub: null, 1.95.
 * @returns {string | null}
 */
function accountNow() {
  const b = backend();
  if (b.name !== "supabase") return null;
  return rememberedAccount() ?? b.session()?.slug ?? null;
}

// HELD RECORDS (2.0, seam fix loop 2, item 1; Red Team 2 N1, ENG 2 N1). On an
// account change the last account's queued writes MOVE out of their path's
// slot to a held key, so the path is free: the next account reads,
// revalidates and writes from its own server copy, never on top of a write
// it cannot see. The held key never starts like a real data path, so no
// read, collection or flush ever lists it. Its `branch` is set to one no
// build replays, so even a rollback to 1.95 counts it as mismatched and
// never pushes it. When its account signs in again it moves back, and the
// flush pushes it through the normal conflict path.
const HELD_PREFIX = "#held/";
const HELD_BRANCH = "held";
// WRITES BEFORE ANY SIGN-IN (item 3, Red Team 2 N2): a Supabase build with no
// account remembered stamps them with this, which no slug can equal. They
// read on the phone while nobody is signed in, are never pushed, and are
// held (listed "made before sign-in", with DISCARD) once anyone signs in,
// so they never go out under whoever happens to sign in first.
const PRE_SIGN_IN = "#before-sign-in";

/** @param {{ path: string }} rec */
function isHeld(rec) {
  return rec.path.startsWith(HELD_PREFIX);
}

/** Fallback the app boots into when profiles.json is missing (fresh
 *  install) or unreachable — a legacy/pre-multi-profile install still opens
 *  straight into David's data at the root, unscoped. */
const DEFAULT_PROFILES = {
  profiles: [{ id: "david", name: "David", emoji: "🏋️", phase: "gain" }],
};

/**
 * The signed-in profile id (Phase: multi-profile). Defaults to "david" so an
 * unset key (pre-feature localStorage) reads exactly as David always has.
 * @returns {string}
 */
export function activeProfile() {
  // PINNED FOR NON-ADMINS (2.0, ENG L2-2): on a backend that knows who is
  // signed in, anyone but the admin is always themselves, whatever an old
  // localStorage value says. GitHub has no session, so this is 1.95 there.
  const s = backend().session();
  if (s && !s.admin) return s.slug;
  return localStorage.getItem("mise.activeProfile") || "david";
}

/**
 * May this phone offer SWITCH PROFILE? (2.0, plan section 5, Red Team 4.)
 * On Supabase only the signed-in admin may; on GitHub it is 1.95, always.
 * @returns {boolean}
 */
export function canSwitchProfile() {
  const b = backend();
  if (b.name !== "supabase") return true;
  return b.session()?.admin === true;
}

/**
 * THE ONE PLACE THE SCOPING RULE EXISTS. David stays at the data-repo root
 * (his live synced mise-data repo is never migrated); every other profile's
 * files live under `profiles/<id>/`. `profiles.json` is the one path that is
 * NEVER scoped — it has to be readable before a profile is even chosen.
 *
 * The comment above `scoped()` used to call itself "the one scoping
 * chokepoint" while SEVENTEEN open-coded copies of this same ternary lived in
 * main.js, each rebuilding a cross-profile path by hand. That is why this
 * takes the profile id as an argument: cross-profile reads are the majority
 * of the call sites, and a chokepoint only the active profile can pass
 * through is not one.
 * @param {string} id
 * @param {string} path
 * @returns {string}
 */
export function pathFor(id, path) {
  if (path === "profiles.json") return path;
  return id === "david" ? path : `profiles/${id}/${path}`;
}

/**
 * `pathFor` bound to whoever is signed in.
 * Exported only so tests can exercise it directly — views never call this;
 * they always go through read/write/readCollection below.
 * @param {string} path
 * @returns {string}
 */
export function scoped(path) {
  return pathFor(activeProfile(), path);
}

/**
 * Does this profile keep recipe overrides separate from the shared bank?
 *
 * False for david, and NOT as an optimization: `pathFor("david", "recipes")`
 * resolves to `"recipes"`, which IS the shared bank root. Reading that as his
 * "own" recipes would merge all 126 bank recipes into the per-profile pool a
 * second time. This is a semantic predicate, which is why it cannot be
 * absorbed into the path helper.
 * @param {string} id
 * @returns {boolean}
 */
export function hasOwnRecipes(id) {
  return id !== "david";
}

// ---------------------------------------------------------------------------
// THE FOOD PROFILE IS NOT FITNESS DATA (David, 2026-08-22)
//
// Mise and Anvil are separate apps. Everything Mise needs to plan food —
// macros, calorie floor and ceiling, protein band, phase, meal slots, food
// groups, avoided ingredients, weekly budget — has been living in a file
// called `fitness/targets.json` since before the split, next to genuinely
// fitness-owned fields. The path is a leftover, and it is the wrong shape for
// two apps that no longer share a purpose.
//
// The canonical home is now `profile/targets.json`. The migration is
// deliberately boring, because this is the most load-bearing file in the app
// (P1 numbers, P3 knows-you, P8 plates all read it) and four people use Mise
// daily:
//   - reads try the new path and FALL BACK to the legacy one, so a profile
//     that has not been migrated behaves exactly as it did yesterday;
//   - writes go to the new path AND mirror to the legacy one, because Anvil
//     still reads `fitness/targets.json` as its calorie and protein spine
//     (anvil/app/lib/github.js, MISE_TARGETS) and refuses in code to write it.
//     Mise is the only writer of both, so the mirror cannot diverge.
// The mirror is removed, and the legacy file deleted, once Anvil is repointed.
// Until then, deleting `fitness/targets.json` breaks Anvil.
//
// `fitness/daily.json` is NOT touched and is not the same problem: both apps
// write it on purpose, through one sha-and-merge path, and merge.js resolves
// it field-wise. That is a designed sharing, not leftover mixing.
// ---------------------------------------------------------------------------

/** Where a profile's food targets live now. */
export const TARGETS_PATH = "profile/targets.json";
/** Where they used to live, still mirrored for Anvil. */
export const LEGACY_TARGETS_PATH = "fitness/targets.json";

/**
 * One profile's food targets, wherever they currently live.
 * @param {string} id
 * @param {typeof read} [readFn] injectable for tests
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function readTargetsOf(id, readFn = read) {
  const fresh = await readFn(pathFor(id, TARGETS_PATH), { raw: true }).catch(() => null);
  if (fresh) return /** @type {any} */ (withCurrentAllergenTerms(fresh));
  return /** @type {any} */ (
    withCurrentAllergenTerms(
      await readFn(pathFor(id, LEGACY_TARGETS_PATH), { raw: true }).catch(() => null),
    )
  );
}

/**
 * A stored profile's avoid list, widened to today's allergen terms (Tribunal
 * Engineer + Red Team, 2026-10-18): the terms behind an allergy chip are
 * copied into avoidIngredients only when the survey is saved, so a profile
 * saved before the chip learned "mozzarella" never got it. Every read adds
 * the current terms for its stored `allergens` ids. Only ever ADDS terms
 * (stricter), keeps the stored order first, and returns the input untouched
 * when there is nothing to add.
 * @param {any} t
 * @returns {any}
 */
export function withCurrentAllergenTerms(t) {
  if (!t || typeof t !== "object") return t;
  const have = Array.isArray(t.avoidIngredients) ? t.avoidIngredients : [];
  const chips = Array.isArray(t.allergens) ? t.allergens : [];
  if (chips.length === 0 && have.length === 0) return t;
  const seen = new Set(have.map((/** @type {unknown} */ x) => String(x).toLowerCase()));
  // a stored typed word ("cheese") brings its family too (2.0, I-02 / A-09)
  const typed = have.flatMap((/** @type {unknown} */ x) => typedAvoidTerms(String(x)));
  const extra = [...new Set([...avoidTermsFromAllergens(chips, ""), ...typed])].filter(
    (x) => !seen.has(x),
  );
  return extra.length === 0 ? t : { ...t, avoidIngredients: [...have, ...extra] };
}

/**
 * Same as readTargetsOf, but keeps the sha/dirty envelope the SYS house-
 * targets panel renders.
 * @param {string} id
 * @returns {Promise<{ data: any, sha: string | null, dirty: boolean }>}
 */
export async function readTargetsMetaOf(id) {
  const miss = { data: null, sha: null, dirty: false };
  const fresh = await readMeta(pathFor(id, TARGETS_PATH), { raw: true }).catch(() => miss);
  if (fresh?.data) {
    return /** @type {any} */ ({ ...fresh, data: withCurrentAllergenTerms(fresh.data) });
  }
  const legacy = await readMeta(pathFor(id, LEGACY_TARGETS_PATH), { raw: true }).catch(() => miss);
  return /** @type {any} */ (
    legacy?.data ? { ...legacy, data: withCurrentAllergenTerms(legacy.data) } : legacy
  );
}

/**
 * Write one profile's food targets to the canonical path, and mirror to the
 * legacy path so Anvil keeps seeing the calorie and protein spine.
 * @param {string} id
 * @param {Record<string, unknown>} data
 * @param {typeof write} [writeFn] injectable for tests
 * @returns {Promise<void>}
 */
export async function writeTargetsOf(id, data, writeFn = write) {
  await writeFn(pathFor(id, TARGETS_PATH), data, { raw: true });
  await writeFn(pathFor(id, LEGACY_TARGETS_PATH), data, { raw: true });
}

/**
 * One profile's plan for a week.
 * @param {string} id
 * @param {string} week
 */
export const readPlanOf = (id, week) =>
  read(pathFor(id, `plans/${week}.json`), { raw: true }).catch(() => null);

/**
 * @param {string} id
 * @param {string} week
 * @param {Record<string, unknown>} data
 */
export const writePlanOf = (id, week, data) =>
  write(pathFor(id, `plans/${week}.json`), data, { raw: true });

/** @param {string} id */
export const readShoppingOf = (id) =>
  read(pathFor(id, "shopping.json"), { raw: true }).catch(() => null);

/** @param {string} id */
export const readOccasionsOf = (id) =>
  read(pathFor(id, "occasions.json"), { raw: true }).catch(() => null);

/**
 * @param {string} id
 * @param {Record<string, unknown>} data
 */
export const writeOccasionsOf = (id, data) =>
  write(pathFor(id, "occasions.json"), data, { raw: true });

/**
 * Cache-first read of profiles.json used by readProfiles. Offline-first: the
 * cached file is the source of truth for the gate (it must list every profile
 * even with no token / no signal). Falls back to the network only when nothing
 * is cached yet, and caches that result.
 * @param {string} path
 * @returns {Promise<{ data: Record<string, unknown>, sha: string } | null>}
 */
async function defaultProfilesRead(path) {
  const key = scoped(path);
  const rec = await dbGet(key);
  // a refused roster write reads as the server copy (2.0, Red Team 3), and a
  // refused one with no server copy asks the network
  const view = rec ? localView(rec) : null;
  if (rec && view) {
    // A CACHED PROFILE LIST IS NOT A FROZEN ONE (David, 2026-08-28).
    //
    // This return used to be bare, which made profiles.json the ONE file in
    // the app that never refreshed: every other read goes through `read()`,
    // which fires `revalidate` on the way past. So a device that had cached
    // the list once kept serving that version forever. The symptom that found
    // it: David moved into the Wayne house and Elliot was added, both landing
    // in profiles.json — and his laptop went on reporting him in "thornton"
    // with no Elliot anywhere, which silently pointed the whole app (pantry,
    // ledger, events, the shopping trip) at the wrong kitchen and left the
    // "add housemate" picker with nobody to offer.
    //
    // `revalidate` skips dirty records, so an unflushed local profile edit
    // still wins, and it emits on change, so the views listening to
    // onSyncChange re-read and repaint.
    void revalidate(key);
    return { data: view, sha: rec.sha ?? "" };
  }
  try {
    const started = epoch;
    const remote = await io.read(path);
    if (remote) {
      await cacheRemote(key, remote.data, remote.sha, undefined, started);
      return remote;
    }
  } catch {
    // offline or no token — fall through to the David-only default
  }
  return null;
}

/**
 * Reads the ROOT profiles.json — every profile chooser (the gate, System's
 * "switch profile") calls this. Cache-first via defaultProfilesRead. Falls
 * back to a single default David profile when the file is missing (fresh
 * install) or unreachable, so a fresh or pre-multi-profile install still boots.
 * @param {(path: string) => Promise<{ data: Record<string, unknown>, sha: string } | null>} [readFn]
 * @returns {Promise<{ profiles: Record<string, any>[] }>}
 */
export async function readProfiles(readFn = defaultProfilesRead) {
  try {
    const remote = await readFn("profiles.json");
    const profiles = /** @type {any} */ (remote)?.data?.profiles;
    if (Array.isArray(profiles) && profiles.length > 0) {
      // the scope is set before any caller reads another profile's files
      // (2.0, A-03); only the real roster sets it, never the fallback
      if (readFn === defaultProfilesRead) {
        // no profile chosen yet syncs nothing personal (activeProfile's
        // "david" default is the admin, which would sync everything)
        // with a session the choice is the pinned one (2.0, Red Team 4): a
        // non-admin's old localStorage value never picks the scope
        const chosen = backend().session()
          ? activeProfile()
          : localStorage.getItem("mise.activeProfile");
        // v1.8 set mise.adminDevice with no check, so it counts only while the
        // admin has no passkey; once he sets one, only a verified open does
        // (Tribunal Red Team, 2.0 loop 2)
        const adminHasKey = Boolean(keyOf(profiles.find(isAdmin)));
        const trusted =
          Boolean(chosen) &&
          (localStorage.getItem(verifiedKey(String(chosen))) === "1" ||
            (!adminHasKey && localStorage.getItem(ADMIN_DEVICE_KEY) === "1"));
        await setSyncScope(
          chosen ? syncScopeFor(profiles, chosen, trusted) : { profileIds: [], houses: [] },
        );
      }
      return /** @type {any} */ (remote).data;
    }
  } catch {
    // offline, no token, or read failure — fall back to David-only below
  }
  // fallback: true tells choosers this is the built-in default, NOT the real
  // list — they must say so ("your other profiles are safe, reconnect") and
  // must never write a whole-array replacement built from it (see
  // patchProfiles; that write is what erased a profile on 2026-07-20).
  return /** @type {{ profiles: Record<string, any>[], fallback?: boolean }} */ ({
    ...DEFAULT_PROFILES,
    fallback: true,
  });
}

/**
 * The one safe WRITE path for profiles.json (G2). Loads the REAL list
 * (cache first, then network), applies `fn`, writes the result — so a
 * mutation can only ever be expressed against the true current profiles,
 * never against the David-only fallback. Returns false (writing nothing)
 * when the real list cannot be established:
 *  - network error / no token and nothing cached → refuse (the file may
 *    hold profiles this device has never seen);
 *  - confirmed 404 (fresh data repo) → allowed only with allowSeed, which
 *    the profile-creation flows pass — creating the first profile on a
 *    brand-new repo is the one legitimate from-scratch write.
 * The io params exist for tests only; views call it bare.
 * @param {(profiles: Record<string, any>[]) => Record<string, any>[]} fn
 * @param {{
 *   allowSeed?: boolean,
 *   readCached?: (path: string) => Promise<{ data: Record<string, unknown>, sha: string } | null>,
 *   readRemote?: (path: string) => Promise<{ data: Record<string, unknown>, sha: string } | null>,
 *   writeFn?: (path: string, data: Record<string, unknown>) => Promise<unknown>
 * }} [opts]
 * @returns {Promise<boolean>} true = written (or queued), false = refused
 */
export async function patchProfiles(
  fn,
  {
    allowSeed = false,
    readCached = defaultProfilesRead,
    readRemote = io.read,
    writeFn = write,
  } = {},
) {
  const cached = await readCached("profiles.json");
  const cachedList = /** @type {any} */ (cached)?.data?.profiles;
  if (Array.isArray(cachedList) && cachedList.length > 0) {
    await writeFn("profiles.json", { profiles: fn([...cachedList]) });
    return true;
  }
  // nothing usable cached: ask the network directly so "file absent" (safe
  // to seed) is distinguishable from "unreachable" (refuse)
  try {
    const remote = await readRemote("profiles.json");
    const remoteList = /** @type {any} */ (remote)?.data?.profiles;
    if (Array.isArray(remoteList) && remoteList.length > 0) {
      await writeFn("profiles.json", { profiles: fn([...remoteList]) });
      return true;
    }
    if (!allowSeed) return false;
    await writeFn("profiles.json", { profiles: fn([]) });
    return true;
  } catch {
    return false;
  }
}

/** @type {Set<() => void>} */
const listeners = new Set();

/** @type {{ loading: boolean, pending: number, conflicts: number, mismatched: number, refused: number, lastSyncAt: string | null, flushing: boolean, lastError: string | null }} */
const status = {
  loading: true,
  pending: 0,
  // queued writes the server refused for good (2.0, ENG L2-8): still counted
  // in pending, listed by refusedRecords(), gone only on DISCARD
  refused: 0,
  conflicts: 0,
  mismatched: 0,
  lastSyncAt: null,
  flushing: false,
  // A5: why the last flush stopped, in words a user can act on. null = the
  // last pass pushed clean. Queued-but-failing writes used to be invisible
  // unless you opened SYS and read the pending count.
  lastError: null,
};

export function getSyncStatus() {
  return { ...status };
}

/** @param {() => void} fn */
export function onSyncChange(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit() {
  for (const fn of listeners) fn();
}

async function recount() {
  const all = await dbGetAll();
  status.pending = all.filter((r) => r.dirty).length;
  status.refused = all.filter((r) => r.dirty && (r.refused || fromAnotherAccount(r))).length;
  status.loading = false;
  emit();
}

/** Call once at startup: wires reconnect-flush and reports queue state. */
export function initStore() {
  window.addEventListener("online", () => {
    void flush();
  });
  // A5: a flush that died on a transient error used to leave writes queued
  // until the NEXT user write happened to retrigger it — retry on a slow
  // heartbeat instead so "queued forever while online" can't happen silently
  setInterval(() => {
    if (status.pending > 0 && !status.flushing) void flush();
  }, 60_000);
  void purgeForeignRecords().then(() => recount());
  void flush();
}

// when each file was last checked against GitHub (revalidateFile, I-03), and
// when each directory's last full pass ended (revalidateCollection); declared
// here because the sync scope's purge forgets the paths it removes
/** @type {Map<string, { at: number, missing: boolean }>} */
const fileCheckedAt = new Map();
/** @type {Map<string, number>} */
const passDoneAt = new Map();

// THE SYNC SCOPE (Mise 2.0, A-03; David, 2026-10-18: "Nobody in West
// Lafayette should be able to see my family"). A phone that has not verified
// the admin syncs only its own household: a path under another household, or
// under a profile outside its house and the guests at its tables (guests:
// their targets files only, GUEST_FILES; guests.json and invites.json: the
// admin's phone only), reads as
// missing without asking GitHub, is never cached, and is purged from the
// phone when the scope is set. The shared GitHub key can still reach those
// files from devtools; a Worker or a split repo is the full fix (2.1).
/** @type {((path: string) => boolean) | null} */
let syncScope = null;
/** @type {{ profileIds: string[], houses: string[] } | null} */
let scopeBase = null;
// guests seated at this phone's own tables, kept across launches so a cold
// start never purges their targets before the events load (Tribunal
// Engineer, 2.0 loop 1: offline, SET then skipped a guest as unreadable)
const SCOPE_GUESTS_KEY = "mise.scopeGuests";
/** @type {Set<string>} */
let scopeGuests = new Set(
  (() => {
    try {
      const v = JSON.parse(localStorage.getItem(SCOPE_GUESTS_KEY) ?? "[]");
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  })(),
);
let scopeKey = "all";
// David's own files sit at the data root (pathFor): they belong to the scope
// only when he does. The shared bank, prices and the roster stay readable.
// Keep in step with pathFor and docs/SCHEMAS.md: an unlisted root file is
// readable by every phone. `david` is hard-coded exactly as in pathFor.
const ROOT_PROFILE_FILES = /^(plans\/|fitness\/|profile\/|health\/|shopping\.json$|occasions\.json$|pantry\.json$)/;
// guest passkey hashes and live invite codes: the admin's phone only
const ADMIN_ONLY_FILES = /^(guests\.json|invites\.json)$/;
// a guest is in scope only through their targets: the plate screen needs
// those, nothing else of theirs (Tribunal Red Team, 2.0 loop 1)
const GUEST_FILES = /^profiles\/[^/]+\/(profile|fitness)\/targets\.json$/;

/**
 * Is this path inside the phone's sync scope?
 * @param {string} path
 */
export function inSyncScope(path) {
  return syncScope === null || syncScope(path);
}

/** @returns {Promise<number>} cached files removed */
async function applySyncScope() {
  const members = scopeBase ? [...new Set(scopeBase.profileIds)].sort() : [];
  const guests = [...scopeGuests].filter((g) => !members.includes(g)).sort();
  // "all" is the unscoped state (the admin's phone, or no admin yet)
  const key = scopeBase
    ? `${members.join(",")}|${guests.join(",")}|${[...scopeBase.houses].sort().join(",")}`
    : "all";
  if (key === scopeKey) return 0;
  scopeKey = key;
  if (!scopeBase) {
    syncScope = null;
    return 0;
  }
  const idSet = new Set(members);
  const guestSet = new Set(guests);
  const houses = new Set(scopeBase.houses);
  syncScope = (path) => {
    if (ADMIN_ONLY_FILES.test(path)) return false;
    const pm = /^profiles\/([^/]+)\//.exec(path);
    if (pm) {
      const id = String(pm[1]);
      return idSet.has(id) || (guestSet.has(id) && GUEST_FILES.test(path));
    }
    const hm = /^households\/([^/]+)\//.exec(path);
    if (hm) return houses.has(String(hm[1]));
    if (ROOT_PROFILE_FILES.test(path)) return idSet.has("david");
    return true;
  };
  // no profile chosen yet: reads are blocked, but nothing is purged, so a
  // phone that only switched profile keeps its cache for the next open
  if (members.length === 0 && houses.size === 0) return 0;
  let removed = 0;
  try {
    for (const rec of await dbGetAll()) {
      if (!syncScope(rec.path) && !rec.dirty) {
        await dbDeleteIfClean(rec.path);
        fileCheckedAt.delete(rec.path);
        removed++;
      }
    }
  } catch {
    // storage unavailable: the scope still applies to every read below
  }
  if (removed > 0) emit();
  return removed;
}

/**
 * Limit this phone to some profiles and households and remove what it
 * already holds outside them; `null` lifts the limit (the admin's phone, or
 * a roster with no admin yet). Set by readProfiles on every read.
 * @param {{ profileIds: string[], houses: string[] } | null} scope
 * @returns {Promise<number>} how many cached files were removed
 */
export function setSyncScope(scope) {
  scopeBase = scope;
  return applySyncScope();
}

/**
 * The guests seated at this phone's own tables: their targets must stay
 * readable, or the plate screen (which fails closed) skips them.
 * @param {string[]} ids
 */
export function setScopeGuests(ids) {
  scopeGuests = new Set(ids);
  try {
    localStorage.setItem(SCOPE_GUESTS_KEY, JSON.stringify([...scopeGuests]));
  } catch {
    // storage refused: this launch still uses them
  }
  return applySyncScope();
}

/**
 * The targets of the ONE person being seated, read for real before the plate
 * screen runs (Mise 2.0, D-01, schelkin 10/23). A guest not yet seated is
 * outside this phone's SYNC SCOPE, so every read of her answered null and the
 * screen could only refuse her; seating is the deliberate act that admits
 * her, so it admits her targets files (GUEST_FILES, nothing else of hers)
 * first, then waits for GitHub (readNow). Not remembered across launches: the
 * next setScopeGuests, from the house's tables, keeps her if she was seated
 * and drops her again if she was not. The admin's phone has no scope, so
 * this is only the wait.
 *
 * Only someone this phone may already show is admitted (Tribunal Red Team,
 * 10/24, F5): an id from `mayShow` (the phone's visible profiles) or a guest
 * already seated at this household's tables (scopeGuests). Any other id
 * answers null before anything is fetched or the scope widens, so a typed or
 * stale id cannot pull a stranger's allergies onto this phone; the caller
 * fails closed on the null.
 * @param {string} id
 * @param {Iterable<string>} mayShow the profile ids this phone's screens show
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function readTargetsForSeat(id, mayShow) {
  if (!new Set(mayShow).has(id) && !scopeGuests.has(id)) return null;
  if (syncScope !== null && !scopeGuests.has(id)) {
    scopeGuests = new Set([...scopeGuests, id]);
    await applySyncScope();
  }
  return readTargetsOf(id, readNow).catch(() => null);
}

/**
 * Cached-first read. Returns the local record immediately (null if never
 * fetched); kicks off a background refresh for clean files when online,
 * at most once per file per 30 s (5 minutes for a missing file). A path
 * outside this phone's SYNC SCOPE reads as null and is never fetched.
 * `raw: true` skips profile scoping — the path is used verbatim. Cross-profile
 * features (combined shopping list, the shared recipe bank) read other
 * profiles' files this way; everything else stays scoped.
 * @param {string} path
 * @param {{ raw?: boolean }} [opts]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function read(path, opts) {
  const finalPath = opts?.raw ? path : scoped(path);
  if (!inSyncScope(finalPath)) return null;
  const rec = await dbGet(finalPath);
  void revalidate(finalPath);
  return rec ? localView(rec) : null;
}

/**
 * What a cached record reads as: the local data, except for a record the
 * server refused (2.0, ENG L2-8), which reads as the server's copy so a
 * write that will never land cannot pass for the truth.
 * @param {import("./db.js").FileRecord} rec
 * @returns {Record<string, unknown> | null}
 */
function localView(rec) {
  // another account's queued write: nothing of it reads on this session,
  // not even its base, which that account could see and this one may not
  if (fromAnotherAccount(rec)) return null;
  if (!rec.refused) return rec.data;
  // the person's own targets keep every restriction of the refused edit
  // (2.0, Red Team 5): stricter only, never looser
  if (isOwnTargetsPath(rec.path)) return stricterTargets(rec.base, rec.data);
  return rec.base;
}

/**
 * A queued write made under a different signed-in account than the one on
 * the phone now (2.0, seam fix 1, Red Team 1 / ENG F3). It is held: never
 * pushed under this session, never read, listed as refused "made by another
 * account" with DISCARD. On GitHub no record carries an account, so never.
 * @param {import("./db.js").FileRecord} rec
 */
function fromAnotherAccount(rec) {
  if (!rec.dirty) return false;
  if (isHeld(rec)) return true;
  if (typeof rec.account !== "string") return false;
  return rec.account !== (accountNow() ?? PRE_SIGN_IN);
}

/** @param {string} path */
function isOwnTargetsPath(path) {
  const me = activeProfile();
  return path === pathFor(me, TARGETS_PATH) || path === pathFor(me, LEGACY_TARGETS_PATH);
}

/**
 * A read that WAITS for GitHub before it answers, for a decision that cannot
 * be taken on a guess. Seating a guest is one (Mise 2.0, D-01; David's live
 * guest test, Sun 10/18 about 10 pm: a guest signed up and he added her to
 * that night's curry from People, and "it doesn't work"). Her targets had just
 * been written from her own phone, so his phone had never cached them: the
 * cached-first read answered null, the plate screen refused her as
 * unreadable, and only a second tap, after the background fetch had landed,
 * seated her. Here the check runs first (joining one already in flight, and
 * within the usual 30 s window answering from the cache); a file remembered
 * as missing is asked for again when nothing is cached, because a profile
 * made minutes ago is exactly the case. Offline, out of scope, or a failed
 * fetch with nothing cached: null, and the caller fails closed.
 * @param {string} path
 * @param {{ raw?: boolean }} [opts]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function readNow(path, opts) {
  const finalPath = opts?.raw ? path : scoped(path);
  if (!inSyncScope(finalPath)) return null;
  if (!(await dbGet(finalPath))) fileCheckedAt.delete(finalPath);
  await revalidate(finalPath);
  const rec = await dbGet(finalPath);
  return rec ? localView(rec) : null;
}

/**
 * Cached-first read that also reports PROVENANCE, for the frozen-pot input
 * fingerprint (per-person-plates-design §10, Red Team R1/N5): `sha` is the
 * GitHub blob sha — content-addressed and identical on every device that
 * has fetched the same bytes, unlike the local `rev` write counter, which
 * would report skew that does not exist. A dirty (locally-edited,
 * unflushed) record stamps dirty: its sha is stale by construction.
 * @param {string} path
 * @param {{ raw?: boolean }} [opts]
 * @returns {Promise<{ data: Record<string, unknown> | null, sha: string | null, dirty: boolean }>}
 */
export async function readMeta(path, opts) {
  const finalPath = opts?.raw ? path : scoped(path);
  if (!inSyncScope(finalPath)) return { data: null, sha: null, dirty: false };
  const rec = await dbGet(finalPath);
  void revalidate(finalPath);
  if (!rec || fromAnotherAccount(rec)) return { data: null, sha: null, dirty: false };
  if (rec.refused) {
    return { data: localView(rec), sha: rec.fingerprint ?? rec.sha ?? null, dirty: false };
  }
  // a targets file on Supabase fingerprints by its plate (2.0, ENG L2-3)
  return {
    data: rec.data,
    sha: rec.fingerprint ?? rec.sha ?? null,
    dirty: Boolean(rec.dirty || rec.fingerprintStale),
  };
}

// ONE FETCH PER FILE, AND A MISSING FILE IS REMEMBERED (Mise 2.0, A-02 /
// I-03: a new phone asked GitHub for Elliot's absent week plan 2,113 times,
// because every emit re-reads and every read refetched, and a 404 left no
// trace). A read joins the fetch already in flight; a file checked in the
// last 30 s is not asked for again, a missing one not for 5 minutes. A local
// write forgets the path, so the next read after it checks again.
/** @type {Map<string, Promise<void>>} */
const fileChecks = new Map();
// also the rest after a collection's full pass (revalidateCollection, I-03)
const FILE_RECHECK_MS = 30_000;
const MISSING_RECHECK_MS = 5 * 60_000;

/**
 * @param {string} scopedPath already-final path (caller applied scoping)
 * @returns {Promise<void>}
 */
function revalidate(scopedPath) {
  const running = fileChecks.get(scopedPath);
  if (running) return running;
  const last = fileCheckedAt.get(scopedPath);
  if (last && Date.now() - last.at < (last.missing ? MISSING_RECHECK_MS : FILE_RECHECK_MS)) {
    return Promise.resolve();
  }
  const check = revalidateFile(scopedPath).finally(() => fileChecks.delete(scopedPath));
  fileChecks.set(scopedPath, check);
  return check;
}

/**
 * @param {string} scopedPath
 * @returns {Promise<void>}
 */
async function revalidateFile(scopedPath) {
  if (!navigator.onLine || !inSyncScope(scopedPath)) return;
  const rec = await dbGet(scopedPath);
  // local edits win until flushed; a refused one still learns the server copy
  if (rec?.dirty && !rec.refused) return;
  try {
    const started = epoch;
    const remote = await backend().read(scopedPath);
    if (started !== epoch) return;
    fileCheckedAt.set(scopedPath, { at: Date.now(), missing: !remote });
    if (!remote) {
      // HIDDEN NOW (2.0, Red Team 2): on Supabase a row the policies no
      // longer show reads as null, so the clean copy goes; a queued edit
      // stays. On GitHub a missing file keeps 1.95's behaviour.
      if (rec && !rec.dirty && backend().name === "supabase") {
        await dbDeleteIfClean(scopedPath);
        emit();
      }
      return;
    }
    if (
      rec &&
      remote.sha === rec.sha &&
      rec.fingerprint === remote.fingerprint &&
      !rec.fingerprintStale
    ) {
      return;
    }
    await cacheRemote(scopedPath, remote.data, remote.sha, remote.fingerprint, started);
    emit();
  } catch {
    // offline, no token or rate-limited: the cache already served the read,
    // and nothing is remembered, so the next read tries again
  }
}

/** Forget every per-file check (tests; and a phone that switches data repo). */
export function resetFileChecks() {
  fileChecks.clear();
  fileCheckedAt.clear();
  passDoneAt.clear();
}

/**
 * Store a freshly-fetched remote file as clean cache, atomically skipping
 * if a local write landed mid-fetch (that write's flush will reconcile).
 * @param {string} path
 * @param {Record<string, unknown>} data
 * @param {string} sha
 * @param {string | null} [fingerprint] the plate's sha for a targets file on
 *   Supabase (2.0, ENG L2-3); never set on GitHub, so 1.95 records keep their shape
 * @param {number} [started] the purge epoch when the fetch began
 * @returns {Promise<void>}
 */
function cacheRemote(path, data, sha, fingerprint, started = epoch) {
  // a fetch that started before the scope was set never lands (2.0, A-03),
  // nor one that started before a purge (Red Team 8)
  if (!inSyncScope(path) || started !== epoch) return Promise.resolve();
  return dbUpdate(path, (cur) =>
    started !== epoch
      ? null
      : cur?.dirty
      ? cur.refused
        ? { ...cur, base: data, sha, ...(fingerprint !== undefined ? { fingerprint } : {}) }
        : null
      : {
          path,
          data,
          base: data,
          sha,
          dirty: false,
          queuedAt: null,
          rev: cur?.rev ?? 0,
          branch: stampHere(),
          ...(fingerprint !== undefined ? { fingerprint } : {}),
        },
  );
}

/**
 * Cached-first collection read (e.g. "recipes"). Returns everything cached
 * under the directory immediately; kicks off a background listing that
 * fetches new/changed files by sha and drops files deleted upstream.
 * @param {string} dir
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function readCollection(
  dir,
  /** @type {{ raw?: boolean } | undefined} */ opts = undefined,
) {
  const scopedDir = opts?.raw ? dir : scoped(dir);
  if (!inSyncScope(`${scopedDir}/`)) return [];
  const prefix = `${scopedDir}/`;
  const cached = (await dbGetAll())
    .filter((r) => r.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
  void revalidateCollection(scopedDir);
  return /** @type {Record<string, unknown>[]} */ (
    cached.map(localView).filter((d) => d !== null)
  );
}

// ONE PASS PER DIRECTORY (audit 2026-10-18: a first launch made about
// 94,000 GitHub requests). Every emit() re-reads collections, and each read
// used to start a fresh pass while earlier ones were still fetching. Now a
// read joins the pass already running, and `freshDirs` records a directory
// that has finished one full pass, so screens can wait for the real bank.
/** @type {Map<string, Promise<void>>} */
const passes = new Map();
/** @type {Set<string>} */
const freshDirs = new Set();
// a pass that could not finish (offline, no token, rate-limited, a file that
// would not download): the cache is all this launch has, and a phone in a
// store with no signal must still plan from it (Tribunal loop 1)
/** @type {Set<string>} */
const stalledDirs = new Set();

/**
 * Has this collection finished at least one full sync on this launch?
 * (The cache alone can be partial on a new or cleared phone.)
 * @param {string} dir as passed to readCollection
 * @param {{ raw?: boolean }} [opts]
 */
export function collectionFresh(dir, opts) {
  return freshDirs.has(opts?.raw ? dir : scoped(dir));
}

/**
 * Did this launch's last sync of the collection fail to finish? Then the
 * cache is the best there is: callers may plan from it when it is not empty.
 * @param {string} dir as passed to readCollection
 * @param {{ raw?: boolean }} [opts]
 */
export function collectionStalled(dir, opts) {
  return stalledDirs.has(opts?.raw ? dir : scoped(dir));
}

/**
 * @param {string} scopedDir already-final dir (caller applied scoping)
 * @returns {Promise<void>}
 */
function revalidateCollection(scopedDir) {
  const running = passes.get(scopedDir);
  if (running) return running;
  // a full pass in the last 30 s is current enough: each emit used to start
  // another listing the moment the last one ended (2.0, I-03)
  const done = passDoneAt.get(scopedDir);
  if (done && freshDirs.has(scopedDir) && Date.now() - done < FILE_RECHECK_MS) {
    return Promise.resolve();
  }
  const pass = revalidatePass(scopedDir).finally(() => {
    passes.delete(scopedDir);
    passDoneAt.set(scopedDir, Date.now());
  });
  passes.set(scopedDir, pass);
  return pass;
}

/**
 * @param {string} scopedDir
 * @returns {Promise<void>}
 */
async function revalidatePass(scopedDir) {
  if (!navigator.onLine) {
    if (!stalledDirs.has(scopedDir)) {
      stalledDirs.add(scopedDir);
      emit();
    }
    return;
  }
  const prefix = `${scopedDir}/`;
  const started = epoch;
  try {
    const listing = await backend().list(scopedDir);
    const cached = (await dbGetAll()).filter((r) => r.path.startsWith(prefix));
    const cachedByPath = new Map(cached.map((r) => [r.path, r]));
    const listed = new Set(listing.map((e) => e.path));
    let changed = false;
    const todo = listing.filter((entry) => {
      const rec = cachedByPath.get(entry.path);
      return !(rec && (rec.sha === entry.sha || (rec.dirty && !rec.refused)));
    });
    // eight at a time: a cold bank of ~180 recipes was 180 serial round trips
    let next = 0;
    let failed = 0;
    const worker = async () => {
      while (next < todo.length) {
        const entry = /** @type {{ path: string, sha: string, data?: Record<string, unknown> }} */ (
          todo[next++]
        );
        /** @type {Awaited<ReturnType<ReturnType<typeof backend>["read"]>>} */
        let remote;
        try {
          // a listing that carries the rows (Supabase, ENG 10) needs no
          // second fetch per file; the GitHub listing never does
          remote = entry.data
            ? { data: entry.data, sha: entry.sha }
            : await backend().read(entry.path);
        } catch {
          failed++;
          continue; // one unreadable/corrupt file must not sink the whole collection
        }
        if (!remote) continue;
        // store the LISTING's sha — it's what the next revalidate compares
        // against, so a listing/content sha disagreement can never cause an
        // endless refetch-emit loop (they're the same blob sha on GitHub)
        await cacheRemote(entry.path, remote.data, entry.sha, undefined, started);
        changed = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker));
    for (const rec of cached) {
      if (!listed.has(rec.path) && !rec.dirty) {
        // atomic re-check inside: a write landing after our snapshot survives
        await dbDeleteIfClean(rec.path);
        changed = true;
      }
    }
    // fresh only when EVERY file came down (Tribunal loop 1: a rate-limited
    // cold phone was marked ready with a partial bank); a short pass is
    // stalled, and the next emit tries again
    const first = !freshDirs.has(scopedDir) && failed === 0;
    if (failed === 0) {
      freshDirs.add(scopedDir);
      stalledDirs.delete(scopedDir);
    } else {
      stalledDirs.add(scopedDir);
    }
    // the first full pass always tells the screens, even with nothing new:
    // that is how a waiting SET MY WEEK learns the bank is real
    if (changed || first || failed > 0) emit();
  } catch {
    // offline or no token — cache already served the read
    if (!stalledDirs.has(scopedDir)) {
      stalledDirs.add(scopedDir);
      emit();
    }
  }
}

/**
 * Optimistic local write: cached instantly, queued, flushed when possible.
 * `raw: true` skips profile scoping (see read) — combined-list write-through
 * ticks update OTHER profiles' shopping files by their full path.
 * @param {string} path
 * @param {Record<string, unknown>} data
 * @param {{ raw?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function write(path, data, opts) {
  const scopedPath = opts?.raw ? path : scoped(path);
  fileCheckedAt.delete(scopedPath);
  await dbUpdate(scopedPath, (cur) => ({
    path: scopedPath,
    data,
    base: cur?.base ?? null,
    sha: cur?.sha ?? null,
    dirty: true,
    queuedAt: cur?.dirty && cur.queuedAt ? cur.queuedAt : Date.now(),
    rev: (cur?.rev ?? 0) + 1,
    // stamped with the branch it was written under (release train): a queued
    // sandbox edit must never be pushed to main, and vice versa
    branch: cur?.dirty && cur.branch !== undefined ? cur.branch : stampHere(),
    // the plate fingerprint rides along (2.0, ENG F1); a dirty record reads
    // as dirty anyway, so a stale value is never reported
    ...(cur && "fingerprint" in cur ? { fingerprint: cur.fingerprint } : {}),
    // who made it (seam fix 1): a later account on this phone holds it
    // with no account at all on a Supabase build, it was made before sign-in
    ...(accountNow()
      ? { account: /** @type {string} */ (accountNow()) }
      : backend().name === "supabase"
      ? { account: PRE_SIGN_IN }
      : {}),
  }));
  await recount();
  void flush();
}

/**
 * Turn a failed write into something the person holding the phone can ACT on.
 *
 * The three real cases, and they need three different actions:
 *  - 404: the token is valid but cannot see the data repo. Renewing it is the
 *    one thing that cannot help. Say so, and name the two things that can.
 *  - 401/403 with a rate-limit message: nothing is wrong. Wait.
 *  - 401/403 otherwise: the token really was rejected.
 * Anything else is reachability, which the heartbeat retries on its own.
 * @param {string} msg
 * @returns {string}
 */
export function writeErrorMessage(msg) {
  if (/^auth: /.test(msg)) {
    return "signed out: sign in again and everything waiting will save";
  }
  if (/unknown data branch for this origin/.test(msg)) {
    return "this origin has no data branch, so nothing saves from here (the live app and the sandbox each have theirs)";
  }
  if (/HTTP 404/.test(msg) && stampHere() === "sandbox") {
    // a missing sandbox branch answers 404 to a PUT; sending someone to audit
    // token scopes over it is the wrong instruction (Red Team, 2026-09-07)
    return "the sandbox data branch is gone: re-seed it (tools/seed-sandbox-data.ps1)";
  }
  if (/HTTP 404/.test(msg)) {
    return "this token can't see the data repo, check the token's repository access, and the data repo in SYS (do NOT create a new token)";
  }
  if (/HTTP 40[13]/.test(msg)) {
    // GitHub answers a secondary rate limit with 403 and says so in the body,
    // which writeFile now carries. Telling someone to renew a perfectly good
    // token because they wrote too fast is the same wrong instruction.
    if (/rate limit|abuse|secondary/i.test(msg)) {
      return "GitHub is rate-limiting writes (auto-retrying shortly)";
    }
    return "GitHub rejected the token (renew it in SYS)";
  }
  if (backend().name === "supabase") return "can't reach the server right now (auto-retrying)";
  return "can't reach GitHub right now (auto-retrying)";
}

/**
 * FLUSH, AND TELL ME THE TRUTH.
 *
 * Every write in this app is queued and optimistic, which is right for a
 * shopping list in a basement with no signal and WRONG for the moment someone
 * finishes a sign-up survey. `write()` and `patchProfiles()` resolve as soon
 * as the write is QUEUED, so an onboarding flow could say "you're all set"
 * while nothing had left the phone. That is exactly how a roommate's profile
 * came to exist only in his own IndexedDB.
 *
 * This forces a push pass and reports what actually happened, so a caller
 * that NEEDS durability can say so honestly instead of assuming.
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ landed: boolean, pending: number, conflicts: number, error: string | null }>}
 */
export async function flushNow({ timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // a pass already in flight would make flush() return immediately, so wait
  // for it rather than reporting on somebody else's half-finished push
  while (status.flushing && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
  }
  await flush();
  while (status.flushing && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
  }
  await recount();
  return {
    landed: status.pending === 0 && !status.lastError,
    pending: status.pending,
    conflicts: status.conflicts,
    error: status.lastError,
  };
}

/**
 * Push every queued write, oldest first. Network failure stops the pass
 * (writes stay queued for the next reconnect); a conflict that survives
 * merge retries is counted and skipped so one bad file can't block the rest.
 * @returns {Promise<void>}
 */
async function flush() {
  if (status.flushing || storeLocks > 0 || !navigator.onLine) return;
  // a Supabase build before sign-in can only fail every push, and must not
  // tell a phone that never signed in that it was signed out (2.0, ENG F2)
  if (backend().name === "supabase" && !backend().session()) return;
  status.flushing = true;
  status.conflicts = 0;
  emit();
  try {
    const queued = (await dbGetAll())
      .filter((r) => r.dirty)
      .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
    const here = stampHere();
    const started = epoch;
    status.mismatched = 0;
    // a 1.95 AI special still queued for the bank goes to its house instead
    // (seam fix 12, ENG F7): on Supabase the bank is the admin's
    for (let i = 0; i < queued.length; i++) {
      const moved = await rehomeLegacySpecial(/** @type {any} */ (queued[i]), here);
      if (moved) queued[i] = moved;
    }
    // THE MOVE FREEZE (seam fix 13): while the kitchen's store is frozen for
    // the migration, every queued change waits on the phone, except the
    // freeze file itself (UNFREEZE must land). Read from the store the
    // kitchen is still on; a missing or malformed file never holds anything.
    // Only the switch-morning shell reads it (moveOn, loop 2 item 4): every
    // other GitHub-lane flush sends exactly the requests 1.95 sent.
    const freeze =
      backend().name === "github" && moveOn()
        ? await readNow(FREEZE_PATH, { raw: true }).catch(() => null)
        : null;
    // a failure stops its LANE, not the pass (2.0 composite: a GitHub outage
    // must not hold back the Supabase queue); with one lane this is the
    // 1.95 stop-on-first-error exactly
    /** @type {Set<string>} */
    const stopped = new Set();
    for (const rec of queued) {
      const lane = backend().laneOf(rec.path);
      if (stopped.has(lane) || rec.refused || fromAnotherAccount(rec)) continue;
      // and only ever under its own account's session: the store's memory
      // decides what is held, the live session decides what may be sent
      if (typeof rec.account === "string" && rec.account !== backend().session()?.slug) continue;
      if (holdWrite(freeze, rec.path)) continue;
      // BRANCH GUARD (release train). A record with no stamp predates the
      // train: it was written on this install, so it belongs to this install's
      // branch, and is stamped on the way past (a read-time heal, never a
      // refusal, or every write queued before the release would be stranded).
      // A record stamped with ANOTHER branch is refused and counted; SYS
      // offers to discard it. Nothing crosses branches on its own.
      if (rec.branch === undefined) {
        rec.branch = here;
        await dbUpdate(rec.path, (cur) => (cur ? { ...cur, branch: here } : null));
      } else if (rec.branch !== here) {
        if (!replaysHere(rec.branch, here)) {
          status.mismatched++;
          continue;
        }
        // a 1.95 record on the build that took over its branch (2.0, plan
        // section 5): replayed through the conflict path, and stamped with
        // this install only once it has landed (ENG F2), so a record that
        // fails, conflicts or is refused stays a GitHub-era write and a
        // rollback still pushes it
      }
      try {
        const pushed = await pushFile(io, {
          path: rec.path,
          data: rec.data,
          base: rec.base,
          sha: rec.sha,
        });
        // atomic: an edit that landed while the push was in flight stays
        // dirty; only base/sha advance (afterPushRecord decides)
        await dbUpdate(rec.path, (cur) => {
          // a record purged while its push was in flight stays gone (ENG F4)
          if (!cur || started !== epoch) return null;
          const landed = afterPushRecord(cur, pushed, rec.rev);
          const next = rec.branch === here ? landed : { ...landed, branch: here };
          // a targets push may have moved the plate: the old fingerprint is
          // kept but marked stale, and reads as dirty until the next fetch
          // brings the plate's (2.0, ENG F1 / Red Team 7)
          return "fingerprint" in cur
            ? { ...next, fingerprint: cur.fingerprint, fingerprintStale: true }
            : next;
        });
        fileCheckedAt.delete(rec.path);
        status.lastSyncAt = new Date().toISOString();
        if (stopped.size === 0) status.lastError = null;
      } catch (e) {
        if (e instanceof ConflictError) {
          status.conflicts++;
          continue; // stays dirty; next flush retries the merge
        }
        if (e instanceof ForbiddenError || e instanceof NameGuardError) {
          // REFUSED (2.0, ENG 2 / L2-8): retrying can never help. Kept so the
          // person can see what did not save, but it stops overriding reads,
          // and the pass goes on to the next record. An edit made while the
          // push was in flight is newer data and gets its own try.
          /** @type {"forbidden" | "name"} */
          const reason = e instanceof NameGuardError ? "name" : "forbidden";
          await dbUpdate(rec.path, (cur) =>
            cur && cur.dirty && cur.rev === rec.rev
              ? { ...cur, refused: { reason, at: Date.now() } }
              : null,
          );
          continue;
        }
        // network/auth failure — stop, everything stays queued, and SAY WHY
        // (A5). THREE states, not two (2026-08-22). A 404 on a write means
        // the token authenticates fine but cannot SEE the data repo, which is
        // what a fine-grained PAT left on GitHub's default "Public
        // repositories" radio does — the trap that cost David five tokens on
        // 2026-08-16. That case used to fall through to "can't reach GitHub
        // right now (auto-retrying)" and retry forever, while the cache-first
        // read made the app look like it had saved. `checkDataRepo` was given
        // a distinct `norepo` state for exactly this on the READ path; the
        // write path never got it. Telling someone to renew a working token
        // is the one instruction that can never work, so it gets its own line.
        const msg = e instanceof Error ? e.message : String(e);
        status.lastError = writeErrorMessage(msg);
        stopped.add(lane);
      }
    }
  } finally {
    status.flushing = false;
    await recount();
  }
}

/**
 * Drop every queued write stamped with a data branch other than this
 * install's (release train). Only ever called from SYS on the person's word,
 * after the count has been shown; the records are disposable by definition
 * (a sandbox edit on the live install, or the reverse).
 * @returns {Promise<number>} how many were dropped
 */
export async function discardMismatched() {
  const here = stampHere();
  const all = await dbGetAll();
  let n = 0;
  for (const rec of all) {
    if (!rec.dirty || rec.branch === undefined || replaysHere(rec.branch, here)) continue;
    // a held write is another account's, discarded only from its own row
    if (isHeld(rec)) continue;
    await dbDelete(rec.path);
    n++;
  }
  status.mismatched = 0;
  await recount();
  return n;
}

/**
 * FIRST BOOT ON SUPABASE (2.0, plan section 5): every clean record not
 * stamped with this install's project is a GitHub-era copy, and goes. Queued
 * (dirty) records stay, to replay or be discarded on the person's word.
 * Idempotent, so it runs on every boot; on GitHub it does nothing.
 * @returns {Promise<number>} records removed
 */
export async function purgeForeignRecords() {
  if (backend().name !== "supabase") return 0;
  const here = stampHere();
  let removed = 0;
  try {
    for (const rec of await dbGetAll()) {
      if (rec.dirty || rec.branch === here) continue;
      await dbDeleteIfClean(rec.path);
      fileCheckedAt.delete(rec.path);
      removed++;
    }
  } catch {
    // storage unavailable: nothing cached to leak either
  }
  if (removed > 0) emit();
  return removed;
}

/**
 * THE ACCOUNT WAS REVOKED (2.0, plan section 5): the phone forgets
 * everything, queued writes included. Called by the sign-in layer ONLY on a
 * confirmed revoke (the server says this account no longer exists or may not
 * read), never on an AuthError, which is an expired session whose queue must
 * survive. The locked backend goes in and the scope is emptied first, and the
 * purge epoch moves, so nothing in flight lands back (Red Team 8, ENG F4).
 * @returns {Promise<number>} records removed
 */
export async function purgeEverything() {
  epoch++;
  installBackend(lockedBackend());
  await setSyncScope({ profileIds: [], houses: [] });
  let removed = 0;
  for (const rec of await dbGetAll()) {
    await dbDelete(rec.path);
    removed++;
  }
  resetFileChecks();
  freshDirs.clear();
  stalledDirs.clear();
  await recount();
  return removed;
}

/** What a refused record says in Settings, Sync (2.0, plan section 5). */
export const REFUSED_REASON = {
  forbidden: "not allowed",
  name: "would show a name to another house",
  account: "made by another account",
  presignin: "made before sign-in",
};

/**
 * @typedef {{ path: string, id: string, reason: "forbidden" | "name" | "account" | "presignin", at: number }} RefusedRow
 *   `path` is the file, for the person to read; `id` is what discardRefused
 *   takes to drop exactly this row (a held write's key differs from its path)
 */

/**
 * Every queued write the server refused, and every one another account made
 * on this phone (seam fix 1, held since loop 2 item 1), for the Settings list.
 * @returns {Promise<RefusedRow[]>}
 */
export async function refusedRecords() {
  /** @type {RefusedRow[]} */
  const out = [];
  for (const r of await dbGetAll()) {
    if (r.dirty && fromAnotherAccount(r)) {
      const path = r.held ? r.held.path : r.path;
      const by = r.held ? r.held.account : r.account;
      const reason = by === PRE_SIGN_IN ? "presignin" : "account";
      out.push({ path, id: r.path, reason, at: r.queuedAt ?? 0 });
    } else if (r.dirty && r.refused) {
      out.push({ path: r.path, id: r.path, reason: r.refused.reason, at: r.refused.at });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
}

/**
 * DISCARD: drop one refused write, on the person's word. The file then reads
 * as the server has it, fetched fresh. Takes a row's `id`; a file path also
 * works, and drops that file's refused write, or else its first held one.
 * @param {string} idOrPath
 * @returns {Promise<boolean>} false when nothing refused matched
 */
export async function discardRefused(idOrPath) {
  const rec = await dbGet(idOrPath);
  let key = rec?.dirty && (rec.refused || fromAnotherAccount(rec)) ? idOrPath : null;
  if (!key) {
    const held = (await dbGetAll())
      .filter((r) => r.dirty && isHeld(r) && r.held?.path === idOrPath)
      .sort((a, b) => a.path.localeCompare(b.path));
    key = held[0]?.path ?? null;
  }
  if (!key) return false;
  await dbDelete(key);
  fileCheckedAt.delete(idOrPath);
  await recount();
  return true;
}

const LEGACY_SPECIAL = /^recipes\/(special-[a-z0-9-]+)\.json$/;

/**
 * A queued 1.95 AI special (`recipes/special-<name>-<date>.json`) replaying
 * on Supabase is moved to the signed-in person's house, under an opaque id,
 * before it is pushed (seam fix 12, ENG F7). The old id rides along as
 * `legacyId`, so the plan entry that names it still resolves (house-recipes.js).
 * Anything else, or no home house: null, and the record replays as it is.
 * @param {import("./db.js").FileRecord} rec
 * @param {string | null} here
 * @returns {Promise<import("./db.js").FileRecord | null>}
 */
async function rehomeLegacySpecial(rec, here) {
  const b = backend();
  if (b.name !== "supabase" || !rec.dirty || rec.branch === here) return null;
  if (!replaysHere(rec.branch, here)) return null;
  const m = LEGACY_SPECIAL.exec(rec.path);
  const home = b.session()?.home;
  if (!m || !home) return null;
  const legacyId = String(m[1]);
  const t = specialTarget("supabase", home, legacyId);
  const moved = {
    ...rec,
    path: t.path,
    data: { ...rec.data, id: t.id, legacyId },
    base: null,
    sha: null,
  };
  await dbUpdate(t.path, () => moved);
  await dbDelete(rec.path);
  return moved;
}

/** @returns {string | null} the account this phone's cache last belonged to */
function rememberedAccount() {
  try {
    return localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return null;
  }
}

/**
 * The phone changed account (a sign-in as someone else, or a sign-out).
 * Every clean cached record goes, so nothing the last account could read
 * serves this one; every queued write stays, held as "made by another
 * account" until that account signs in again or the person DISCARDs it.
 * (purgeEverything is the confirmed-revoke purge and would delete the queue
 * this must keep.) The slug is remembered in the store too, so a change is
 * seen even when the caller's own memory was lost. No change: nothing done.
 * @param {string | null} prevSlug
 * @param {string | null} nextSlug
 * @returns {Promise<number>} cached records removed
 */
export async function onSessionChange(prevSlug, nextSlug) {
  const remembered = rememberedAccount();
  try {
    if (nextSlug) localStorage.setItem(ACCOUNT_KEY, nextSlug);
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // storage refused: the caller's prev still decides
  }
  const changed =
    (prevSlug ?? null) !== (nextSlug ?? null) ||
    (remembered !== null && remembered !== (nextSlug ?? null));
  let removed = 0;
  if (changed) {
    epoch++;
    for (const rec of await dbGetAll()) {
      if (rec.dirty) continue;
      await dbDeleteIfClean(rec.path);
      removed++;
    }
  }
  // the hold runs on every call, so a queue is never left in a path's slot
  // under the wrong account, even when the caller's memory said no change
  const moved = await holdAndRestore(nextSlug ?? null);
  if (changed || moved > 0) {
    resetFileChecks();
    freshDirs.clear();
    stalledDirs.clear();
    await recount();
  }
  return removed;
}

/**
 * Move every queued write made by an account other than `next` out to a held
 * key, then move `next`'s own held writes back into their slots (item 1). A
 * record with no account (a 1.95 queue) stays where it is and replays under
 * the first account, as plan section 5 says. A held write whose slot is
 * taken stays held, listed, until the slot is free or it is discarded.
 * `next` null (signed out) counts as "before sign-in" (item 3).
 * @param {string | null} next
 * @returns {Promise<number>} records moved either way
 */
async function holdAndRestore(next) {
  // signed out, the slots belong to "before sign-in" (item 3)
  const who = next ?? PRE_SIGN_IN;
  let moved = 0;
  for (const rec of await dbGetAll()) {
    if (!rec.dirty || isHeld(rec) || typeof rec.account !== "string") continue;
    if (rec.account === who) continue;
    const key = `${HELD_PREFIX}${rec.account}/${rec.queuedAt ?? 0}/${rec.path}`;
    /** @type {import("./db.js").FileRecord} */
    const held = {
      ...rec,
      path: key,
      branch: HELD_BRANCH,
      held: {
        path: rec.path,
        account: rec.account,
        ...(rec.branch !== undefined ? { branch: rec.branch } : {}),
      },
    };
    await dbUpdate(key, () => held);
    await dbDelete(rec.path);
    fileCheckedAt.delete(rec.path);
    moved++;
  }
  const mine = (await dbGetAll())
    .filter((r) => r.dirty && isHeld(r) && r.held?.account === who)
    .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
  for (const rec of mine) {
    const h = /** @type {NonNullable<typeof rec.held>} */ (rec.held);
    /** @type {import("./db.js").FileRecord} */
    const back = { ...rec, path: h.path };
    delete back.held;
    delete back.branch;
    if (h.branch !== undefined) back.branch = h.branch;
    let put = false;
    await dbUpdate(h.path, (cur) => {
      if (cur) return null;
      put = true;
      return back;
    });
    if (!put) continue;
    await dbDelete(rec.path);
    fileCheckedAt.delete(h.path);
    moved++;
  }
  return moved;
}

/**
 * Hold the queue: no new flush starts until the returned release is called,
 * and this resolves only once a flush already in flight has finished. The
 * sign-in side takes it before an account switch (worker gate E4).
 * @returns {Promise<() => void>} release (idempotent)
 */
export async function acquireStoreLock() {
  storeLocks++;
  while (status.flushing) await new Promise((r) => setTimeout(r, 25));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    storeLocks--;
  };
}
