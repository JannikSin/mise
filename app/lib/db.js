// Thin promise wrapper over IndexedDB. One store: "files", keyed by repo path.
// Record shape: { path, data, base, sha, dirty, queuedAt }
//   data  = current local view (may include unsynced edits)
//   base  = last version known to be on GitHub (merge ancestor)
//   sha   = blob sha for the Contents API write
//   dirty = write queued, waiting for flush
//   queuedAt = ms timestamp for flush ordering

const DB_NAME = "mise";
const DB_VERSION = 1;

/**
 * @typedef {{
 *   path: string,
 *   data: Record<string, unknown>,
 *   base: Record<string, unknown> | null,
 *   sha: string | null,
 *   dirty: boolean,
 *   queuedAt: number | null,
 *   rev: number
 * }} FileRecord
 */

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

/** @returns {Promise<IDBDatabase>} */
function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("files", { keyPath: "path" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null; // transient open failure must not poison every later call
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

/**
 * @param {IDBRequest} req
 * @returns {Promise<any>}
 */
function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {string} path
 * @returns {Promise<FileRecord | undefined>}
 */
export async function dbGet(path) {
  const db = await open();
  return promisify(db.transaction("files").objectStore("files").get(path));
}

/** @returns {Promise<FileRecord[]>} */
export async function dbGetAll() {
  const db = await open();
  return promisify(db.transaction("files").objectStore("files").getAll());
}

/**
 * Delete a cached record ONLY if it has no unsynced local edits, checked
 * atomically in one transaction (a write landing mid-flight must never be
 * deleted out from under the queue).
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function dbDeleteIfClean(path) {
  const db = await open();
  const store = db.transaction("files", "readwrite").objectStore("files");
  await new Promise((resolve, reject) => {
    const getReq = store.get(path);
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      if (!getReq.result || getReq.result.dirty) return resolve(undefined);
      const delReq = store.delete(path);
      delReq.onsuccess = () => resolve(undefined);
      delReq.onerror = () => reject(delReq.error);
    };
  });
}

/**
 * Atomic read-modify-write in a single transaction — the only safe way to
 * finalize a record that a concurrent write() may have touched mid-flight.
 * The updater sees the CURRENT record and returns what to store, or null to
 * leave the record untouched.
 * @param {string} path
 * @param {(current: FileRecord | undefined) => FileRecord | null} updater
 * @returns {Promise<void>}
 */
export async function dbUpdate(path, updater) {
  const db = await open();
  const store = db.transaction("files", "readwrite").objectStore("files");
  await new Promise((resolve, reject) => {
    const getReq = store.get(path);
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      const next = updater(getReq.result);
      if (!next) return resolve(undefined);
      const putReq = store.put(next);
      putReq.onsuccess = () => resolve(undefined);
      putReq.onerror = () => reject(putReq.error);
    };
  });
}
