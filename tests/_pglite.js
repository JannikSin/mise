// Test-only PGlite harness for the Mise 2.0 database (plan section 8, the
// PGlite go/no-go). Not a test file itself: `node --test tests/*.test.js`
// matches only *.test.js.
//
// It stands in for a fresh Supabase project: the three API roles, an `auth`
// schema with `auth.users` and `auth.uid()` read from the request claim, and
// Supabase's GENEROUS default grants on the public schema, so a revoke the
// migrations forget shows up here as a leak instead of passing by accident.
// Then it applies every file in supabase/migrations/ in name order.
//
// PGlite is a dev dependency. When it is missing, `PGLITE` is false and every
// suite that needs it skips cleanly.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** @type {any} */
let PGliteCtor = null;
try {
  PGliteCtor = (await import("@electric-sql/pglite")).PGlite;
} catch {
  PGliteCtor = null;
}

export const PGLITE = PGliteCtor !== null;
export const SKIP = PGLITE ? false : "@electric-sql/pglite is not installed";

const MIGRATIONS = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

/** The migration files, in apply order. */
export function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(MIGRATIONS + f, "utf8") }));
}

const SUPABASE_STANDIN = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;
`;

/**
 * A fresh database with the stand-in and every migration applied.
 * @param {{ upTo?: string }} [opts] apply only files whose name sorts at or before this
 * @returns {Promise<any>} a PGlite instance
 */
export async function freshDb(opts = {}) {
  if (!PGliteCtor) throw new Error("PGlite missing");
  const db = new PGliteCtor();
  await db.exec(SUPABASE_STANDIN);
  for (const m of migrationFiles()) {
    if (opts.upTo && m.name > opts.upTo) break;
    await db.exec(m.sql);
  }
  return db;
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
