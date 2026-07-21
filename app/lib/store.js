// Offline-first store (CLAUDE.md Part 2, rule 3). Views read and write HERE,
// never against the network directly.
//
//   read:  cache answers instantly; a background revalidate refreshes clean
//          files from GitHub and notifies subscribers.
//   write: lands in the cache immediately (dirty + queuedAt), then flush()
//          pushes queued files in order — with sha, merging on conflict —
//          whenever we're online. Offline writes simply stay queued.

import { dbDeleteIfClean, dbGet, dbGetAll, dbUpdate } from "./db.js";
import { listDir, readFile, writeFile } from "./github.js";
import { pushFile, afterPushRecord, ConflictError } from "./sync.js";

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
 * The one scoping chokepoint: David stays at the data-repo root (his live
 * synced mise-data repo is never migrated); every other profile's files
 * live under `profiles/<id>/`. `profiles.json` itself is the one path that
 * is NEVER scoped — it has to be readable before a profile is even chosen.
 * Exported only so tests can exercise it directly — views never call this;
 * they always go through read/write/readCollection below.
 * @param {string} path
 * @returns {string}
 */
export function scoped(path) {
  if (path === "profiles.json") return path;
  const p = activeProfile();
  return p === "david" ? path : `profiles/${p}/${path}`;
}

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
  if (rec) return { data: rec.data, sha: rec.sha ?? "" };
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

/** @type {{ loading: boolean, pending: number, conflicts: number, lastSyncAt: string | null, flushing: boolean, lastError: string | null }} */
const status = {
  loading: true,
  pending: 0,
  conflicts: 0,
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
  const rec = await dbGet(finalPath);
  void revalidate(finalPath);
  return rec ? rec.data : null;
}

/**
 * @param {string} scopedPath already-final path (caller applied scoping)
 * @returns {Promise<void>}
 */
async function revalidate(scopedPath) {
  if (!navigator.onLine) return;
  const rec = await dbGet(scopedPath);
  if (rec?.dirty) return; // local edits win until flushed
  try {
    const remote = await readFile(scopedPath);
    if (!remote) return;
    if (rec && remote.sha === rec.sha) return;
    await cacheRemote(scopedPath, remote.data, remote.sha);
    emit();
  } catch {
    // offline or no token — cache already served the read
  }
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
      : { path, data, base: data, sha, dirty: false, queuedAt: null, rev: cur?.rev ?? 0 },
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
  const prefix = `${scopedDir}/`;
  const cached = (await dbGetAll())
    .filter((r) => r.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
  void revalidateCollection(scopedDir);
  return cached.map((r) => r.data);
}

/**
 * @param {string} scopedDir already-final dir (caller applied scoping)
 * @returns {Promise<void>}
 */
async function revalidateCollection(scopedDir) {
  if (!navigator.onLine) return;
  const prefix = `${scopedDir}/`;
  try {
    const listing = await listDir(scopedDir);
    const cached = (await dbGetAll()).filter((r) => r.path.startsWith(prefix));
    const cachedByPath = new Map(cached.map((r) => [r.path, r]));
    const listed = new Set(listing.map((e) => e.path));
    let changed = false;
    for (const entry of listing) {
      const rec = cachedByPath.get(entry.path);
      if (rec && (rec.sha === entry.sha || rec.dirty)) continue;
      /** @type {Awaited<ReturnType<typeof readFile>>} */
      let remote;
      try {
        remote = await readFile(entry.path);
      } catch {
        continue; // one unreadable/corrupt file must not sink the whole collection
      }
      if (!remote) continue;
      // store the LISTING's sha — it's what the next revalidate compares
      // against, so a listing/content sha disagreement can never cause an
      // endless refetch-emit loop (they're the same blob sha on GitHub)
      await cacheRemote(entry.path, remote.data, entry.sha);
      changed = true;
    }
    for (const rec of cached) {
      if (!listed.has(rec.path) && !rec.dirty) {
        // atomic re-check inside: a write landing after our snapshot survives
        await dbDeleteIfClean(rec.path);
        changed = true;
      }
    }
    if (changed) emit();
  } catch {
    // offline or no token — cache already served the read
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
  await dbUpdate(scopedPath, (cur) => ({
    path: scopedPath,
    data,
    base: cur?.base ?? null,
    sha: cur?.sha ?? null,
    dirty: true,
    queuedAt: cur?.dirty && cur.queuedAt ? cur.queuedAt : Date.now(),
    rev: (cur?.rev ?? 0) + 1,
  }));
  await recount();
  void flush();
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
    for (const rec of queued) {
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
        // (A5): a 401/403 means the token is the problem and waiting won't
        // fix it; anything else is reachability and the heartbeat retries.
        const msg = e instanceof Error ? e.message : String(e);
        status.lastError = /HTTP 40[13]/.test(msg)
          ? "GitHub rejected the token (renew it in SYS)"
          : "can't reach GitHub right now (auto-retrying)";
        break;
      }
    }
  } finally {
    status.flushing = false;
    await recount();
  }
}
