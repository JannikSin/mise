// Mise 2.0 (plan section 6 step 6 and RT N3, N5): the WEEKLY WAYNE PROBE.
//
// Once a week the Worker signs in as the probe account (a neutral
// `probe-<hex>` slug, kind 'probe', a member of the Wayne house only, its
// password a Worker secret set by tools/make-probe.mjs) and reads, with the
// PUBLISHABLE key and the probe's own session, exactly what a Wayne phone
// could read. It then asserts:
//   - zero `targets` and zero `health` docs rows of anyone (the probe has none);
//   - every plates row's keys are a subset of the plate fields;
//   - zero rows from profiles, households and memberships (no client grant);
//   - a roster() with no probe rows and `family` null on every row;
//   - svc.guard_hits() = 0 (whole-word guard terms in what each house can read).
// The result goes to David's phone by ntfy as CHECK NAMES AND COUNTS ONLY,
// never a row, a name or a path. It reports a pass too, so a probe that has
// stopped running is noticed (an automation is not done until it is seen
// firing).
//
// `assertReach` is pure so tools/probe-reach.mjs (the migration's verify
// step, DB lane) can share the same assertions.

import { PLATE_KEYS } from "./plate-keys.js";
import { guardHits } from "./svc.js";
import { supabaseBranches, projectFor } from "./supabase-env.js";

/**
 * @typedef {{
 *   docs: { kind?: string }[],
 *   plates: { data?: Record<string, unknown> }[],
 *   profiles: unknown[],
 *   households: unknown[],
 *   memberships: unknown[],
 *   roster: { id?: string, family?: unknown }[],
 *   guardHits: number,
 * }} ReachSnapshot
 */

/**
 * The failed checks, as `name: count`, never data. Empty means pass.
 * @param {ReachSnapshot} snap
 * @param {{ plateKeys?: readonly string[] }} [opts]
 * @returns {string[]}
 */
export function assertReach(snap, opts = {}) {
  const allowed = new Set(opts.plateKeys ?? PLATE_KEYS);
  /** @type {string[]} */
  const fails = [];
  const count = (/** @type {string} */ name, /** @type {number} */ n) => {
    if (n !== 0) fails.push(`${name}: ${n}`);
  };
  count("targets rows visible", snap.docs.filter((d) => d?.kind === "targets").length);
  count("health rows visible", snap.docs.filter((d) => d?.kind === "health").length);
  count(
    "plates with a non-plate key",
    snap.plates.filter((p) => Object.keys(p?.data ?? {}).some((k) => !allowed.has(k))).length,
  );
  count("profiles rows visible", snap.profiles.length);
  count("households rows visible", snap.households.length);
  count("memberships rows visible", snap.memberships.length);
  count(
    "probe rows in roster",
    snap.roster.filter((r) => typeof r?.id === "string" && r.id.startsWith("probe-")).length,
  );
  count("roster rows with family", snap.roster.filter((r) => r?.family != null).length);
  if (!Number.isFinite(snap.guardHits)) fails.push("guard hits: unreadable");
  else count("guard hits", snap.guardHits);
  return fails;
}

/**
 * @typedef {(input: string, init?: any) => Promise<Response>} FetchImpl
 */

/**
 * Sign in as the probe, read, assert.
 * @param {{ url: string, secret: string, publishable: string }} project
 * @param {{ email: string, password: string }} creds
 * @param {FetchImpl} [fetchImpl]
 * @returns {Promise<{ ok: boolean, fails: string[] }>}
 */
export async function runReachProbe(project, creds, fetchImpl) {
  const f = fetchImpl ?? ((i, n) => fetch(i, n));
  if (!project.publishable) return { ok: false, fails: ["publishable key: not set"] };
  const tok = await f(`${project.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: project.publishable, "content-type": "application/json" },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  });
  if (!tok.ok) return { ok: false, fails: [`probe sign-in: ${tok.status}`] };
  const access = String((await tok.json().catch(() => ({})))?.access_token ?? "");
  if (!access) return { ok: false, fails: ["probe sign-in: no session"] };
  const as = {
    apikey: project.publishable,
    authorization: `Bearer ${access}`,
    accept: "application/json",
  };
  /** @type {string[]} */
  const readFails = [];
  /**
   * A table read as the probe. No grant (401/403) is the right answer for
   * the people tables and counts as zero rows; anything else unexpected is
   * a failure in its own right.
   * @param {string} q
   * @returns {Promise<any[]>}
   */
  const table = async (q) => {
    const res = await f(`${project.url}/rest/v1/${q}`, { headers: as });
    if (res.status === 401 || res.status === 403) return [];
    if (!res.ok) {
      readFails.push(`read ${q.split("?")[0]}: ${res.status}`);
      return [];
    }
    const rows = await res.json().catch(() => null);
    return Array.isArray(rows) ? rows : [];
  };
  const docs = await table("docs?select=kind");
  const plates = await table("plates?select=data");
  const profiles = await table("profiles?select=id");
  const households = await table("households?select=id");
  const memberships = await table("memberships?select=profile_id");
  const rres = await f(`${project.url}/rest/v1/rpc/roster`, {
    method: "POST",
    headers: { ...as, "content-type": "application/json" },
    body: "{}",
  });
  /** @type {any[]} */
  let roster = [];
  if (rres.ok) {
    const r = await rres.json().catch(() => null);
    roster = Array.isArray(r?.profiles) ? r.profiles : [];
  } else {
    readFails.push(`read roster: ${rres.status}`);
  }
  let hits;
  try {
    hits = await guardHits(project, f);
  } catch {
    hits = Number.NaN;
  }
  const fails = [
    ...readFails,
    ...assertReach({ docs, plates, profiles, households, memberships, roster, guardHits: hits }),
  ];
  return { ok: fails.length === 0, fails };
}

/**
 * Is this the probe's hour? Mondays, 7 am Chicago.
 * @param {{ hour: number, weekday: string }} now
 */
export function probeDue(now) {
  return now.weekday === "Mon" && now.hour === 7;
}

/**
 * Run the probe for every switched project and report each result by ntfy.
 * Creds per project: PROBE_EMAIL / PROBE_PASSWORD (live) and
 * PROBE_SANDBOX_EMAIL / PROBE_SANDBOX_PASSWORD (sandbox), Worker secrets.
 * A switched project with no probe account is reported as a failure, so a
 * probe that was never set up cannot look like a quiet pass.
 * @param {any} env
 * @param {(n: { title: string, body: string, priority: string }) => Promise<void>} post
 * @param {FetchImpl} [fetchImpl]
 * @returns {Promise<{ branch: string, ok: boolean, fails: string[] }[]>}
 */
export async function weeklyProbes(env, post, fetchImpl) {
  const out = [];
  for (const branch of supabaseBranches(env)) {
    const label = branch === "main" ? "live" : "sandbox";
    const project = projectFor(branch, env);
    const email = String((branch === "main" ? env?.PROBE_EMAIL : env?.PROBE_SANDBOX_EMAIL) ?? "");
    const password = String(
      (branch === "main" ? env?.PROBE_PASSWORD : env?.PROBE_SANDBOX_PASSWORD) ?? "",
    );
    /** @type {{ ok: boolean, fails: string[] }} */
    let r;
    if (!project) r = { ok: false, fails: ["project config: incomplete"] };
    else if (!email || !password) r = { ok: false, fails: ["probe account: not set"] };
    else {
      try {
        r = await runReachProbe(project, { email, password }, fetchImpl);
      } catch {
        r = { ok: false, fails: ["probe: could not reach the project"] };
      }
    }
    await post(
      r.ok
        ? { title: `Mise privacy probe passed (${label})`, body: "Every check came back clean.", priority: "low" }
        : { title: `Mise privacy probe FAILED (${label})`, body: r.fails.join("; "), priority: "high" },
    );
    out.push({ branch, ...r });
  }
  return out;
}
