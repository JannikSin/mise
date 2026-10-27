// Mise 2.0 (plan section 4.2, Worker): which Supabase project serves which
// origin, and whether that origin has been switched to Supabase at all.
//
// THE SWITCH IS ONE PLAIN VAR, `SUPABASE_BACKEND`, a comma list of data
// branches ("sandbox", later "sandbox,main"). Absent, the Worker is 1.95
// exactly: every route reads GitHub and only the PAT is accepted. The sandbox
// origin goes first (David's step 12, Sat 10/31); the live origin follows on
// the switch morning.
//
// Each project needs its URL (a plain var, public by design) and its secret
// key (a Worker secret, never committed):
//   main:    SUPABASE_URL,         SUPABASE_SECRET_KEY,         SUPABASE_PUBLISHABLE_KEY
//   sandbox: SUPABASE_SANDBOX_URL, SUPABASE_SANDBOX_SECRET_KEY, SUPABASE_SANDBOX_PUBLISHABLE_KEY
// A branch named in SUPABASE_BACKEND without its URL and secret is NOT
// quietly sent back to GitHub (after the freeze GitHub is stale): the routes
// answer 503 until the config is whole.

/**
 * @typedef {{
 *   branch: "main" | "sandbox",
 *   url: string,
 *   ref: string,
 *   iss: string,
 *   jwksUrl: string,
 *   secret: string,
 *   publishable: string,
 * }} SupabaseProject
 */

/** a project URL is exactly https://<ref>.supabase.co, nothing after it */
const PROJECT_URL_RE = /^https:\/\/([a-z0-9]{6,40})\.supabase\.co\/?$/;

/**
 * The branches switched to Supabase.
 * @param {any} env
 * @returns {Set<string>}
 */
export function supabaseBranches(env) {
  return new Set(
    String(env?.SUPABASE_BACKEND ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s === "main" || s === "sandbox"),
  );
}

/**
 * Is this data branch on Supabase (switched, whether or not its config is whole)?
 * @param {string | null} branch
 * @param {any} env
 */
export function onSupabase(branch, env) {
  return Boolean(branch) && supabaseBranches(env).has(/** @type {string} */ (branch));
}

/**
 * The project for a branch, or null when the branch is not switched or its
 * config is incomplete or malformed.
 * @param {string | null} branch
 * @param {any} env
 * @returns {SupabaseProject | null}
 */
export function projectFor(branch, env) {
  if (!onSupabase(branch, env)) return null;
  const sandbox = branch === "sandbox";
  const rawUrl = String((sandbox ? env?.SUPABASE_SANDBOX_URL : env?.SUPABASE_URL) ?? "").trim();
  const secret = String(
    (sandbox ? env?.SUPABASE_SANDBOX_SECRET_KEY : env?.SUPABASE_SECRET_KEY) ?? "",
  ).trim();
  const publishable = String(
    (sandbox ? env?.SUPABASE_SANDBOX_PUBLISHABLE_KEY : env?.SUPABASE_PUBLISHABLE_KEY) ?? "",
  ).trim();
  const m = rawUrl.match(PROJECT_URL_RE);
  if (!m || !secret) return null;
  const url = `https://${m[1]}.supabase.co`;
  return {
    branch: sandbox ? "sandbox" : "main",
    url,
    ref: /** @type {string} */ (m[1]),
    iss: `${url}/auth/v1`,
    jwksUrl: `${url}/auth/v1/.well-known/jwks.json`,
    secret,
    publishable,
  };
}
