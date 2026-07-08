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

/** @type {Set<() => void>} */
const listeners = new Set();

/** @type {{ loading: boolean, pending: number, conflicts: number, lastSyncAt: string | null, flushing: boolean }} */
const status = { loading: true, pending: 0, conflicts: 0, lastSyncAt: null, flushing: false };

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
  void recount();
  void flush();
}

/**
 * Cached-first read. Returns the local record immediately (null if never
 * fetched); kicks off a background refresh for clean files when online.
 * @param {string} path
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function read(path) {
  const rec = await dbGet(path);
  void revalidate(path);
  return rec ? rec.data : null;
}

/**
 * @param {string} path
 * @returns {Promise<void>}
 */
async function revalidate(path) {
  if (!navigator.onLine) return;
  const rec = await dbGet(path);
  if (rec?.dirty) return; // local edits win until flushed
  try {
    const remote = await readFile(path);
    if (!remote) return;
    if (rec && remote.sha === rec.sha) return;
    await cacheRemote(path, remote.data, remote.sha);
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
export async function readCollection(dir) {
  const prefix = `${dir}/`;
  const cached = (await dbGetAll())
    .filter((r) => r.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
  void revalidateCollection(dir);
  return cached.map((r) => r.data);
}

/**
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function revalidateCollection(dir) {
  if (!navigator.onLine) return;
  const prefix = `${dir}/`;
  try {
    const listing = await listDir(dir);
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
 * @param {string} path
 * @param {Record<string, unknown>} data
 * @returns {Promise<void>}
 */
export async function write(path, data) {
  await dbUpdate(path, (cur) => ({
    path,
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
      } catch (e) {
        if (e instanceof ConflictError) {
          status.conflicts++;
          continue; // stays dirty; next flush retries the merge
        }
        break; // network/auth failure — stop, everything stays queued
      }
    }
  } finally {
    status.flushing = false;
    await recount();
  }
}
