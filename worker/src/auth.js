// Mise 2.0 (plan section 1, B1 and E4; section 4.2 Worker token check): who
// is calling, and may they spend AI today.
//
// TWO CREDENTIALS, ONE HEADER. `x-mise-auth` carries either the 1.95 GitHub
// PAT or, from 2.0, the Supabase session JWT (three dot-separated base64url
// segments; a PAT never has a dot). No CORS change, no second header.
//
//  - A JWT is accepted only from an origin whose data branch is switched to
//    Supabase (SUPABASE_BACKEND), verified against THAT project's JWKS
//    (jwt.js), then `svc.entitled(sub)`, cached 5 minutes per isolate. Sign-up
//    and anonymous sign-in are off, so a valid token is an invited person; the
//    entitlement flag is what lets David switch one off without a deploy.
//  - The PAT on a branch still on GitHub is 1.95 exactly: every route.
//  - The PAT on a branch switched to Supabase is AI-ONLY dual-accept (E4): the
//    AI routes keep working for a phone that has not signed in yet, under ONE
//    shared quota, until PAT_AUTH_UNTIL (Sun 11/22). Every data route
//    (invites, annotate-save, notify-test, Kroger, the hall) needs the account.
//
// AI QUOTA. Every AI call by a JWT holder, and every AI call by a PAT on a
// switched branch, takes from a per-person daily allowance AND a global daily
// ceiling, counted in public.ai_usage through svc.ai_count (one atomic
// increment per call slot, the database's own current_date). Two reserved
// rows sit beside each person's: one shared by every PAT caller and one for
// the global total. A refused call still counts (the conservative side). A
// failed quota check fails CLOSED: no count, no model call.

import { looksLikeJwt, verifySupabaseJwt, pinnedAlg } from "./jwt.js";
import { onSupabase, projectFor } from "./supabase-env.js";
import { entitled, aiCount } from "./svc.js";

/** the routes that spend model money (or Workers AI) */
export const AI_ROUTES = new Set([
  "/scan",
  "/transcribe",
  "/receipt",
  "/onboard",
  "/remedy",
  "/menu",
  "/hallplate",
  "/tailor",
  "/dinner",
  "/ask",
  "/annotate",
]);

/** the last day the old PAT is accepted on a switched branch (plan section 8) */
export const PAT_AUTH_UNTIL_DEFAULT = "2026-11-22";
/** the shared quota row for every PAT caller */
export const PAT_QUOTA_USER = "00000000-0000-0000-0000-000000000000";
/** the global ceiling's row */
export const GLOBAL_QUOTA_USER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
export const AI_DAILY_PER_USER_DEFAULT = 80;
export const AI_DAILY_GLOBAL_DEFAULT = 600;
const ENTITLED_TTL_MS = 5 * 60 * 1000;

/** `${ref}|${sub}` -> { value, until } */
const entitledCache = new Map();

/** tests only */
export function resetAuthCachesForTests() {
  entitledCache.clear();
}

/**
 * The request weight on the quota: the same weights the per-token rate
 * limiter has always used (annotate is a transcribe plus up to two annotates).
 * @param {string} pathname
 */
export function aiWeight(pathname) {
  if (pathname === "/annotate") return 4;
  if (pathname === "/transcribe") return 2;
  return 1;
}

/**
 * Today in David's timezone, YYYY-MM-DD (the quota day and the PAT cutoff).
 * @param {number} nowMs
 */
export function chicagoDate(nowMs) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(nowMs));
}

/**
 * @param {any} env
 * @returns {string} YYYY-MM-DD
 */
export function patAuthUntil(env) {
  const v = String(env?.PAT_AUTH_UNTIL ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : PAT_AUTH_UNTIL_DEFAULT;
}

/**
 * @param {any} v @param {number} fallback
 */
function posInt(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * @typedef {{ kind: "pat", token: string }
 *   | { kind: "jwt", sub: string, jwt: string, project: import("./supabase-env.js").SupabaseProject }} Caller
 * @typedef {{ ok: true, who: Caller } | { ok: false, status: number, error: string }} AuthResult
 */

/**
 * Authenticate one request.
 * @param {{
 *   token: string | null,
 *   branch: "main" | "sandbox" | null,
 *   pathname: string,
 *   env: any,
 *   patCheck: (token: string | null) => Promise<string>,
 *   fetchImpl?: (input: string, init?: any) => Promise<Response>,
 *   nowMs?: number,
 * }} a
 * @returns {Promise<AuthResult>}
 */
export async function authenticate(a) {
  const nowMs = a.nowMs ?? Date.now();
  const fail = (/** @type {number} */ status, /** @type {string} */ error) => ({
    ok: /** @type {false} */ (false),
    status,
    error,
  });
  const switched = onSupabase(a.branch, a.env);

  if (looksLikeJwt(a.token)) {
    if (!switched) return fail(401, "unauthorized");
    const project = projectFor(a.branch, a.env);
    if (!project) return fail(503, "sign-in is not set up on the server yet");
    const v = await verifySupabaseJwt(a.token, project, {
      fetchImpl: a.fetchImpl,
      nowMs,
      alg: pinnedAlg(a.env),
    });
    if (!v.ok) {
      if (v.reason === "jwks") return fail(503, "could not check your sign-in, try again in a minute");
      return fail(401, "unauthorized");
    }
    const key = `${project.ref}|${v.sub}`;
    let hit = entitledCache.get(key);
    if (!hit || hit.until <= nowMs) {
      let value;
      try {
        value = await entitled(project, v.sub, a.fetchImpl);
      } catch {
        return fail(503, "could not check your account, try again in a minute");
      }
      hit = { value, until: nowMs + ENTITLED_TTL_MS };
      entitledCache.set(key, hit);
    }
    if (!hit.value) return fail(403, "this account is not switched on");
    return { ok: true, who: { kind: "jwt", sub: v.sub, jwt: /** @type {string} */ (a.token), project } };
  }

  if (switched) {
    if (!AI_ROUTES.has(a.pathname)) {
      return fail(401, "sign in to your account: the old key no longer works for this");
    }
    if (chicagoDate(nowMs) > patAuthUntil(a.env)) {
      return fail(401, "sign in to your account: the old key stopped working");
    }
  }
  const r = await a.patCheck(a.token);
  if (r === "retry") {
    return fail(
      503,
      "GitHub is rate-limiting right now (a burst of edits can do this), wait two minutes and try again. Your token is fine.",
    );
  }
  if (r !== "ok") return fail(401, "unauthorized");
  return { ok: true, who: { kind: "pat", token: /** @type {string} */ (a.token) } };
}

/**
 * Take this request's weight from today's AI allowance, when it applies.
 * Non-AI routes, and the PAT on a branch still on GitHub, are not metered here.
 * @param {{
 *   who: Caller,
 *   branch: "main" | "sandbox" | null,
 *   pathname: string,
 *   env: any,
 *   fetchImpl?: (input: string, init?: any) => Promise<Response>,
 *   nowMs?: number,
 * }} a
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
export async function takeAiQuota(a) {
  if (!AI_ROUTES.has(a.pathname)) return { ok: true };
  if (a.who.kind === "pat" && !onSupabase(a.branch, a.env)) return { ok: true };
  const project = a.who.kind === "jwt" ? a.who.project : projectFor(a.branch, a.env);
  if (!project) return { ok: false, status: 503, error: "sign-in is not set up on the server yet" };
  const user = a.who.kind === "jwt" ? a.who.sub : PAT_QUOTA_USER;
  const userCap = posInt(a.env?.AI_DAILY_PER_USER, AI_DAILY_PER_USER_DEFAULT);
  const globalCap = posInt(a.env?.AI_DAILY_GLOBAL, AI_DAILY_GLOBAL_DEFAULT);
  /** @type {"ok" | "user" | "global"} */
  let r = "ok";
  try {
    // one increment per weight slot; the person's row first, so a person
    // over their own allowance never spends the global one
    let mine = 0;
    for (let i = 0; i < aiWeight(a.pathname); i++) mine = await aiCount(project, user, a.fetchImpl);
    if (mine > userCap) r = "user";
    else {
      let all = 0;
      for (let i = 0; i < aiWeight(a.pathname); i++) {
        all = await aiCount(project, GLOBAL_QUOTA_USER, a.fetchImpl);
      }
      if (all > globalCap) r = "global";
    }
  } catch {
    return { ok: false, status: 503, error: "could not check today's AI allowance, try again in a minute" };
  }
  if (r === "ok") return { ok: true };
  return {
    ok: false,
    status: 429,
    error:
      r === "user"
        ? "you have used today's AI allowance; it resets overnight"
        : "the kitchen's AI allowance for today is used up; it resets overnight",
  };
}
