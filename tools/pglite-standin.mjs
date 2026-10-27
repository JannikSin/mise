// Mise 2.0: a local PGlite database that stands in for a fresh Supabase
// project, used by the PGlite test suite (tests/_pglite.js) and by
// `migrate-to-supabase.mjs --target pglite` for a dry run on David's laptop.
// Never a real project: nothing here talks to the network.
//
// The stand-in creates the three API roles, an `auth` schema with
// `auth.users` and `auth.uid()` read from the request claim, and Supabase's
// GENEROUS default grants on the public schema, so a revoke the migrations
// forget shows up as a leak instead of passing by accident. Then it applies
// every file in supabase/migrations/ in name order.
//
// PGlite (@electric-sql/pglite) is a dev dependency. `loadPglite()` returns
// null when it is not installed, so callers can skip cleanly.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIGRATIONS = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

export const SUPABASE_STANDIN = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;
`;

/** The migration files, in apply order. */
export function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(MIGRATIONS + f, "utf8") }));
}

/** @returns {Promise<any>} the PGlite constructor, or null when not installed */
export async function loadPglite() {
  try {
    return (await import("@electric-sql/pglite")).PGlite;
  } catch {
    return null;
  }
}

/**
 * A fresh in-memory database with the stand-in and the migrations applied.
 * @param {{ upTo?: string }} [opts] apply only files whose name sorts at or before this
 * @returns {Promise<any>} a PGlite instance
 */
export async function openStandin(opts = {}) {
  const PGlite = await loadPglite();
  if (!PGlite) throw new Error("@electric-sql/pglite is not installed (npm i -D @electric-sql/pglite)");
  const db = new PGlite();
  await db.exec(SUPABASE_STANDIN);
  for (const m of migrationFiles()) {
    if (opts.upTo && m.name > opts.upTo) break;
    await db.exec(m.sql);
  }
  return db;
}
