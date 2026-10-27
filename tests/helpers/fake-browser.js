// The browser boundary store.js touches, faked in memory: localStorage, the
// handful of IndexedDB calls db.js makes, navigator.onLine and window events.
// Import this BEFORE importing store.js. Shared by the 2.0 seam tests.

/** @type {Map<string, string>} */
export const kv = new Map();
globalThis.localStorage = /** @type {any} */ ({
  getItem: (/** @type {string} */ k) => kv.get(k) ?? null,
  setItem: (/** @type {string} */ k, /** @type {string} */ v) => kv.set(k, String(v)),
  removeItem: (/** @type {string} */ k) => kv.delete(k),
});

/** what the phone's IndexedDB holds, by path */
/** @type {Map<string, any>} */
export const idb = new Map();
const req = (/** @type {() => any} */ fn) => {
  /** @type {any} */
  const r = { onsuccess: null, onerror: null, result: undefined };
  queueMicrotask(() => {
    r.result = fn();
    r.onsuccess?.();
  });
  return r;
};
const store = {
  get: (/** @type {string} */ k) =>
    req(() => (idb.has(k) ? structuredClone(idb.get(k)) : undefined)),
  getAll: () => req(() => [...idb.values()].map((v) => structuredClone(v))),
  put: (/** @type {any} */ v) => req(() => void idb.set(v.path, structuredClone(v))),
  delete: (/** @type {string} */ k) => req(() => void idb.delete(k)),
};
globalThis.indexedDB = /** @type {any} */ ({
  open: () => {
    const r = req(() => ({ transaction: () => ({ objectStore: () => store }) }));
    /** @type {any} */ (r).onupgradeneeded = null;
    return r;
  },
});
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
if (!(/** @type {any} */ (globalThis).window)) {
  /** @type {any} */ (globalThis).window = { addEventListener: () => {} };
}

/** let queued microtasks and fire-and-forget flushes settle */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * A queued record exactly as store.write() leaves it.
 * @param {string} path
 * @param {Record<string, unknown>} data
 * @param {Record<string, unknown>} [extra]
 */
export function queued(path, data, extra = {}) {
  return { path, data, base: null, sha: null, dirty: true, queuedAt: Date.now(), rev: 1, ...extra };
}
