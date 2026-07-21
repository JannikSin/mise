// 3-way field-wise merge for Mise data files (CLAUDE.md Part 2, rule 2).
// base = last version both devices knew, local = this device's write,
// remote = what's on GitHub now. Per field: the side that changed wins;
// both changed → recurse into objects / keyed arrays, otherwise local wins
// (the device performing the write is the one the user is holding).

/** @typedef {Record<string, unknown>} Obj */

/**
 * @param {Obj | null | undefined} base
 * @param {Obj | null | undefined} local
 * @param {Obj | null | undefined} remote
 * @returns {Obj}
 */
export function mergeFieldWise(base, local, remote) {
  return mergeObjects(base ?? {}, local ?? {}, remote ?? {});
}

/**
 * @param {Obj} base
 * @param {Obj} local
 * @param {Obj} remote
 * @returns {Obj}
 */
function mergeObjects(base, local, remote) {
  /** @type {Obj} */
  const out = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);
  for (const k of keys) {
    // remote JSON is untrusted input: never merge prototype-polluting keys
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const v = mergeValue(base[k], local[k], remote[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * @param {unknown} bv
 * @param {unknown} lv
 * @param {unknown} rv
 * @returns {unknown}
 */
function mergeValue(bv, lv, rv) {
  const localChanged = !deepEqual(lv, bv);
  const remoteChanged = !deepEqual(rv, bv);
  if (!localChanged) return rv;
  if (!remoteChanged) return lv;
  if (deepEqual(lv, rv)) return lv;
  // both sides changed the same field differently
  // delete-vs-edit: the edit wins, both directions (matches keyed-array rule)
  if (lv === undefined) return rv;
  if (rv === undefined) return lv;
  // base may not have the field at all (two devices CREATING the same keyed
  // array concurrently, e.g. the first writes to a fresh household pantry) —
  // an empty base means nothing was ever deleted, so the union is correct.
  // Requiring Array.isArray(bv) here once dropped a whole side's perishables.
  if (Array.isArray(lv) && Array.isArray(rv)) {
    const merged = mergeKeyedArrays(Array.isArray(bv) ? bv : [], lv, rv);
    if (merged !== null) return merged;
  }
  if (isPlainObject(lv) && isPlainObject(rv)) {
    return mergeObjects(isPlainObject(bv) ? bv : {}, lv, rv);
  }
  return lv; // atomic conflict: local wins
}

/**
 * Element-wise merge for arrays whose elements all carry a stable key
 * (`id`, or `date` + optional `slot` — see docs/SCHEMAS.md conventions).
 * Returns null when any element is unkeyed (caller treats array atomically).
 *
 * @param {unknown[]} base
 * @param {unknown[]} local
 * @param {unknown[]} remote
 * @returns {unknown[] | null}
 */
function mergeKeyedArrays(base, local, remote) {
  const bm = keyedMap(base);
  const lm = keyedMap(local);
  const rm = keyedMap(remote);
  if (!bm || !lm || !rm) return null;

  /** @type {unknown[]} */
  const out = [];
  for (const [k, lv] of lm) {
    const bv = bm.get(k);
    const rv = rm.get(k);
    if (rm.has(k)) {
      out.push(mergeValue(bv, lv, rv));
    } else if (bv === undefined || !deepEqual(lv, bv)) {
      // added locally, or remote deleted an element local had edited: keep it
      out.push(lv);
    }
    // else: deleted remotely and untouched locally → stays deleted
  }
  for (const [k, rv] of rm) {
    if (lm.has(k)) continue;
    const bv = bm.get(k);
    if (bv === undefined || !deepEqual(rv, bv)) {
      // added remotely, or local deleted an element remote had edited: keep it
      out.push(rv);
    }
    // else: deleted locally and untouched remotely → stays deleted
  }
  return out;
}

/**
 * @param {unknown[]} arr
 * @returns {Map<string, unknown> | null}
 */
function keyedMap(arr) {
  /** @type {Map<string, unknown>} */
  const m = new Map();
  for (const el of arr) {
    const k = keyOf(el);
    if (k === null) return null;
    m.set(k, el);
  }
  return m;
}

/**
 * @param {unknown} el
 * @returns {string | null}
 */
function keyOf(el) {
  if (!isPlainObject(el)) return null;
  if (typeof el.id === "string") return `id:${el.id}`;
  if (typeof el.date === "string") {
    return typeof el.slot === "string" ? `date:${el.date}|${el.slot}` : `date:${el.date}`;
  }
  return null;
}

/**
 * @param {unknown} v
 * @returns {v is Obj}
 */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}
