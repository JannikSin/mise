// Test-only PGlite harness for the Mise 2.0 database (plan section 8, the
// PGlite go/no-go). Not a test file itself: `node --test tests/*.test.js`
// matches only *.test.js. The Supabase stand-in lives in
// tools/pglite-standin.mjs, shared with the migration's local dry run.
//
// PGlite is a dev dependency. When it is missing, `PGLITE` is false and every
// suite that needs it skips cleanly.
import { loadPglite, openStandin, migrationFiles } from "../tools/pglite-standin.mjs";

export { migrationFiles };
export const PGLITE = (await loadPglite()) !== null;
export const SKIP = PGLITE ? false : "@electric-sql/pglite is not installed";

/**
 * A fresh database with the stand-in and every migration applied.
 * @param {{ upTo?: string }} [opts]
 * @returns {Promise<any>} a PGlite instance
 */
export function freshDb(opts = {}) {
  return openStandin(opts);
}

/**
 * Run `fn` as a signed-in user: SET ROLE authenticated with auth.uid() =
 * `uid`. Always resets, so a failing assertion cannot leave the role set.
 * @template T
 * @param {any} db
 * @param {string | null} uid
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function asUser(db, uid, fn) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid ?? ""]);
  await db.exec("set role authenticated");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

/**
 * Run `fn` as another API role (anon, service_role) with no session.
 * @template T
 * @param {any} db
 * @param {string} role
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function asRole(db, role, fn) {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

/**
 * The error a query raises, or null. For asserting refusals.
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<{ message: string, code?: string } | null>}
 */
export async function errorOf(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { message: String(err?.message ?? err), code: err?.code };
  }
}
