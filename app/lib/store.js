// Offline-first store (CLAUDE.md Part 2, rule 3). Views read and write HERE,
// never against the network directly.
//
//   read:  cache answers instantly; a background revalidate refreshes clean
//          files from GitHub and notifies subscribers.
//   write: lands in the cache immediately (dirty + queuedAt), then flush()
//          pushes queued files in order — with sha, merging on conflict —
//          whenever we're online. Offline writes simply stay queued.

import { dbDeleteIfClean, dbGet, dbGetAll, dbUpdate, dbDelete } from "./db.js";
import { listDir, readFile, writeFile, dataBranch } from "./github.js";
import { pushFile, afterPushRecord, ConflictError } from "./sync.js";
import { avoidTermsFromAllergens, typedAvoidTerms } from "./targets.js";
import { syncScopeFor } from "./privacy.js";

const io = { read: readFile, write: writeFile };

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
  return localStorage.getItem("mise.activeProfile") || "david";
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
  if (rec) {
    // A CACHED PROFILE LIST IS NOT A FROZEN ONE (David, 2026-08-28).
    //
    // This return used to be bare, which made profiles.json the ONE file in
    // the app that never refreshed: every other read goes through `read()`,
    // which fires `revalidate` on the way past. So a device that had cached
    // the list once kept serving that version forever. The symptom that found
    // it: David moved into the Wayne house and Elliot was added, both landing
    // in profiles.json — and his laptop went on reporting him in "taranowski"
    // with no Elliot anywhere, which silently pointed the whole app (pantry,
    // ledger, events, the shopping trip) at the wrong kitchen and left the
    // "add housemate" picker with nobody to offer.
    //
    // `revalidate` skips dirty records, so an unflushed local profile edit
    // still wins, and it emits on change, so the views listening to
    // onSyncChange re-read and repaint.
    void revalidate(key);
    return { data: rec.data, sha: rec.sha ?? "" };
  }
  try {
    const remote = await io.read(path);
    if (remote) {
      await cacheRemote(key, remote.data, remote.sha);
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
        const chosen = localStorage.getItem("mise.activeProfile");
        await setSyncScope(
          chosen ? syncScopeFor(profiles, chosen) : { profileIds: [], houses: [] },
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

/** @type {{ loading: boolean, pending: number, conflicts: number, mismatched: number, lastSyncAt: string | null, flushing: boolean, lastError: string | null }} */
const status = {
  loading: true,
  pending: 0,
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
  void recount();
  void flush();
}

// THE SYNC SCOPE (Mise 2.0, A-03; David, 2026-10-18: "Nobody in West
// Lafayette should be able to see my family"). A phone that is not the
// admin's syncs only its own household: a path under another household, or
// under a profile outside its house and the guests at its tables, reads as
// missing without asking GitHub, is never cached, and is purged from the
// phone when the scope is set. The shared GitHub key can still reach those
// files from devtools; a Worker or a split repo is the full fix (2.1).
/** @type {((path: string) => boolean) | null} */
let syncScope = null;
/** @type {{ profileIds: string[], houses: string[] } | null} */
let scopeBase = null;
/** @type {Set<string>} guests seated at this phone's own tables */
let scopeGuests = new Set();
let scopeKey = "all";
// David's own files sit at the data root (pathFor): they belong to the scope
// only when he does. The shared bank, prices and the roster stay readable.
const ROOT_PROFILE_FILES = /^(plans\/|fitness\/|profile\/|health\/|shopping\.json$|occasions\.json$)/;

/**
 * Is this path inside the phone's sync scope?
 * @param {string} path
 */
export function inSyncScope(path) {
  return syncScope === null || syncScope(path);
}

/** @returns {Promise<number>} cached files removed */
async function applySyncScope() {
  const ids = scopeBase ? [...new Set([...scopeBase.profileIds, ...scopeGuests])].sort() : [];
  const key = scopeBase ? `${ids.join(",")}|${[...scopeBase.houses].sort().join(",")}` : "all";
  if (key === scopeKey) return 0;
  scopeKey = key;
  if (!scopeBase) {
    syncScope = null;
    return 0;
  }
  const idSet = new Set(ids);
  const houses = new Set(scopeBase.houses);
  syncScope = (path) => {
    const pm = /^profiles\/([^/]+)\//.exec(path);
    if (pm) return idSet.has(String(pm[1]));
    const hm = /^households\/([^/]+)\//.exec(path);
    if (hm) return houses.has(String(hm[1]));
    if (ROOT_PROFILE_FILES.test(path)) return idSet.has("david");
    return true;
  };
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
  return applySyncScope();
}

/**
 * Cached-first read. Returns the local record immediately (null if never
 * fetched); kicks off a background refresh for clean files when online.
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
  return rec ? rec.data : null;
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
  if (!rec) return { data: null, sha: null, dirty: false };
  return { data: rec.data, sha: rec.sha ?? null, dirty: Boolean(rec.dirty) };
}

// ONE FETCH PER FILE, AND A MISSING FILE IS REMEMBERED (Mise 2.0, A-02 /
// I-03: a new phone asked GitHub for Elliot's absent week plan 2,113 times,
// because every emit re-reads and every read refetched, and a 404 left no
// trace). A read joins the fetch already in flight; a file checked in the
// last 30 s is not asked for again, a missing one not for 5 minutes. A local
// write forgets the path, so the next read after it checks again.
/** @type {Map<string, Promise<void>>} */
const fileChecks = new Map();
/** @type {Map<string, { at: number, missing: boolean }>} */
const fileCheckedAt = new Map();
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
  if (rec?.dirty) return; // local edits win until flushed
  try {
    const remote = await readFile(scopedPath);
    fileCheckedAt.set(scopedPath, { at: Date.now(), missing: !remote });
    if (!remote) return;
    if (rec && remote.sha === rec.sha) return;
    await cacheRemote(scopedPath, remote.data, remote.sha);
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
 * @returns {Promise<void>}
 */
function cacheRemote(path, data, sha) {
  return dbUpdate(path, (cur) =>
    cur?.dirty
      ? null
      : {
          path,
          data,
          base: data,
          sha,
          dirty: false,
          queuedAt: null,
          rev: cur?.rev ?? 0,
          branch: dataBranch(),
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
  return cached.map((r) => r.data);
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
/** @type {Map<string, number>} when each directory's last pass ended */
const passDoneAt = new Map();

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
  try {
    const listing = await listDir(scopedDir);
    const cached = (await dbGetAll()).filter((r) => r.path.startsWith(prefix));
    const cachedByPath = new Map(cached.map((r) => [r.path, r]));
    const listed = new Set(listing.map((e) => e.path));
    let changed = false;
    const todo = listing.filter((entry) => {
      const rec = cachedByPath.get(entry.path);
      return !(rec && (rec.sha === entry.sha || rec.dirty));
    });
    // eight at a time: a cold bank of ~180 recipes was 180 serial round trips
    let next = 0;
    let failed = 0;
    const worker = async () => {
      while (next < todo.length) {
        const entry = /** @type {{ path: string, sha: string }} */ (todo[next++]);
        /** @type {Awaited<ReturnType<typeof readFile>>} */
        let remote;
        try {
          remote = await readFile(entry.path);
        } catch {
          failed++;
          continue; // one unreadable/corrupt file must not sink the whole collection
        }
        if (!remote) continue;
        // store the LISTING's sha — it's what the next revalidate compares
        // against, so a listing/content sha disagreement can never cause an
        // endless refetch-emit loop (they're the same blob sha on GitHub)
        await cacheRemote(entry.path, remote.data, entry.sha);
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
    branch: cur?.dirty && cur.branch !== undefined ? cur.branch : dataBranch(),
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
  if (/unknown data branch for this origin/.test(msg)) {
    return "this origin has no data branch, so nothing saves from here (the live app and the sandbox each have theirs)";
  }
  if (/HTTP 404/.test(msg) && dataBranch() === "sandbox") {
    // a missing sandbox branch answers 404 to a PUT; sending someone to audit
    // token scopes over it is the wrong instruction (Red Team, 2026-09-07)
    return "the sandbox data branch is gone: re-seed it (tools/seed-sandbox-data.ps1)";
  }
  if (/HTTP 404/.test(msg)) {
    return "this token can't see the data repo — check the token's repository access, and the data repo in SYS (do NOT create a new token)";
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
  if (status.flushing || !navigator.onLine) return;
  status.flushing = true;
  status.conflicts = 0;
  emit();
  try {
    const queued = (await dbGetAll())
      .filter((r) => r.dirty)
      .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
    const here = dataBranch();
    status.mismatched = 0;
    for (const rec of queued) {
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
        status.mismatched++;
        continue;
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
        await dbUpdate(rec.path, (cur) => afterPushRecord(cur ?? rec, pushed, rec.rev));
        status.lastSyncAt = new Date().toISOString();
        status.lastError = null;
      } catch (e) {
        if (e instanceof ConflictError) {
          status.conflicts++;
          continue; // stays dirty; next flush retries the merge
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
        break;
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
  const here = dataBranch();
  const all = await dbGetAll();
  let n = 0;
  for (const rec of all) {
    if (!rec.dirty || rec.branch === undefined || rec.branch === here) continue;
    await dbDelete(rec.path);
    n++;
  }
  status.mismatched = 0;
  await recount();
  return n;
}
