// THE STORAGE SEAM (Mise 2.0, plan section 5). store.js reads and writes
// through `backend()`, never through a particular store. Two adapters fill it:
//   backend/github-adapter.js    the 1.95 GitHub Contents API, unchanged
//   backend/supabase-adapter.js  Supabase docs, recipes, plates and roster
// Which one runs is backend/config.js's call (shell meta plus origin). A
// Supabase build boots with a LOCKED backend that refuses everything until
// the sign-in installs the real adapter (installBackend), so nothing is ever
// sent to GitHub by a build meant for Supabase, and nothing is sent anywhere
// before there is a session.

import { createGithubAdapter } from "./backend/github-adapter.js";
import { backendChoice, supabaseProject, LEGACY_STAMP_OF } from "./backend/config.js";
import { AuthError } from "./backend/errors.js";

/**
 * @typedef {{
 *   privacy: "private" | "PUBLIC" | "unknown",
 *   auth: "ok" | "invalid" | "norepo" | "throttled" | "missing" | "unknown",
 *   reachable: boolean
 * }} BackendStatus
 */

/**
 * Who is asking, for a backend that knows (Supabase). null on GitHub, where
 * one shared key reads everything and the phone's sync scope does the hiding.
 * @typedef {{ slug: string, admin: boolean, home: string | null }} BackendSession
 */

/**
 * The plan's interface, plus three fields the seam needs that the plan's
 * typedef left implicit (noted in the lane notes):
 *   stamp()       the tag every cached and queued record carries (the 1.95
 *                 `branch` field): the data branch on GitHub, the project on
 *                 Supabase
 *   laneOf(path)  which store a path really goes to; the composite backend
 *                 sends root fitness/ and health/ to GitHub, so one failing
 *                 lane never stops the other's queue
 *   session()     who is asking (BackendSession), or null
 * @typedef {{
 *   name: "github" | "supabase",
 *   read(path: string): Promise<{ data: Record<string, unknown>, sha: string, fingerprint?: string | null } | null>,
 *   write(path: string, data: Record<string, unknown>, sha?: string | null): Promise<{ sha: string }>,
 *   list(dir: string): Promise<{ name: string, path: string, sha: string, data?: Record<string, unknown> }[]>,
 *   readMeta(path: string): Promise<{ sha: string } | null>,
 *   authHeader(): Promise<string | null>,
 *   status(): Promise<BackendStatus>,
 *   authBroken(status?: string): boolean,
 *   stamp(): string | null,
 *   laneOf(path: string): string,
 *   session(): BackendSession | null,
 * }} Backend
 */

/** @type {Backend | null} */
let current = null;

/**
 * A Supabase build before sign-in: every call refuses with AuthError, which
 * the flush treats as "stop and keep the queue".
 * @returns {Backend}
 */
export function lockedBackend() {
  const project = supabaseProject();
  const refuse = async () => {
    throw new AuthError(project ? "not signed in" : "no Supabase project for this origin");
  };
  return {
    name: "supabase",
    read: refuse,
    write: refuse,
    list: refuse,
    readMeta: refuse,
    authHeader: async () => null,
    status: async () => ({ privacy: "private", auth: "missing", reachable: true }),
    authBroken: (status) => status === "invalid",
    stamp: () => (project ? project.stamp : null),
    laneOf: () => "supabase",
    session: () => null,
  };
}

/** @returns {Backend} the backend every store read and write goes through */
export function backend() {
  if (!current) current = backendChoice() === "github" ? createGithubAdapter() : lockedBackend();
  return current;
}

/**
 * Put a backend in place: the sign-in installs the Supabase adapter, a
 * sign-out installs `lockedBackend()`, tests install fakes. null goes back to
 * the config's choice on the next call.
 * @param {Backend | null} b
 */
export function installBackend(b) {
  current = b;
}

/** @returns {string | null} the stamp new records get on this install */
export function stampHere() {
  return backend().stamp();
}

/**
 * May a queued record stamped `stamp` be pushed from here? Its own stamp
 * always; on Supabase, also the 1.95 data branch that project took over
 * (config LEGACY_STAMP_OF), which replays through the conflict path. On
 * GitHub this is exactly 1.95's `rec.branch === here`.
 * @param {string | null | undefined} stamp
 * @param {string | null} here
 */
export function replaysHere(stamp, here) {
  if (stamp === here) return true;
  return here !== null && LEGACY_STAMP_OF[here] !== undefined && LEGACY_STAMP_OF[here] === stamp;
}

/**
 * A credential that cannot reach the data, whatever the backend. Views gate
 * on this; on GitHub it is github.js tokenBroken, unchanged.
 * @param {string | undefined} auth
 */
export function tokenBroken(auth) {
  return backend().authBroken(auth);
}
