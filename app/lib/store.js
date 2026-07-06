// Offline-first store (CLAUDE.md Part 2, rule 3). Views read and write HERE,
// never against the network directly.
//
//   read:  cache answers instantly; a background revalidate refreshes clean
//          files from GitHub and notifies subscribers.
//   write: lands in the cache immediately (dirty + queuedAt), then flush()
//          pushes queued files in order — with sha, merging on conflict —
//          whenever we're online. Offline writes simply stay queued.

import { dbGet, dbGetAll, dbUpdate } from "./db.js";
import { readFile, writeFile } from "./github.js";
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
    // atomic: a write() landing after the fetch above must not be clobbered
    await dbUpdate(path, (cur) =>
      cur?.dirty
        ? null
        : {
            path,
            data: remote.data,
            base: remote.data,
            sha: remote.sha,
            dirty: false,
            queuedAt: null,
            rev: cur?.rev ?? 0,
          },
    );
    emit();
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
export async function flush() {
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
