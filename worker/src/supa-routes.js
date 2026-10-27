// Mise 2.0 F2 (plan section 4.2, "Guests, invites, Worker" and the Worker
// readers table, ENG L2-5): the Worker routes on a branch switched to
// Supabase. Each 1.95 GitHub read or write is replaced by one typed svc
// call (svc.js), and the same guards stand in front of them as in 1.95:
// bounded bodies, the per-address and per-name limiters, a hash that always
// runs, the same words for an unknown name and a wrong passkey, and the
// code validated before any other field is looked at. Those guards live in
// index.js (shared with 1.95); this module starts after them.
//
// What changes on Supabase, and why:
//  - Guest sessions are signed with GUEST_SESSION_KEY, typed (guest-session.js).
//  - Invite codes are stored HASHED (SHA-256 hex): the database never holds a
//    usable code. The plaintext goes back once, to the host who minted it.
//  - A claim is ONE svc transaction (svc.claim_guest: spend, profile, grant,
//    both targets rows), so the 1.95 stamp-first-then-four-writes dance is
//    gone. Only the optional login row follows it, as in 1.95 (step 5).
//  - Invites are guest-only (B4): a member invite is refused here.
//  - annotate-save writes AS THE CALLER (their own JWT to write_doc): the
//    admin's save lands in the bank, anyone else's in their own recipes.
//  - notify-test previews the admin's own schedule, so it is admin-only.

import {
  allowRequest,
  firstNameOf,
  guestAfterFail,
  guestLocked,
  guestNameKey,
  guestProfileSummary,
  guestRecipe,
  hashGuestPin,
  inviteStatusRows,
  mintInviteCode,
  sanitizeInviteDinners,
  sanitizeInviteEntry,
  sanitizeInviteTargets,
  slugForName,
  slugOf,
  validGuestPin,
  verifyGuestPin,
  GUEST_DUMMY_SALT,
  GUEST_LOCK_MS,
  INVITE_TTL_MS,
} from "./lib.js";
import { projectFor } from "./supabase-env.js";
import {
  SvcError,
  claimGuest,
  guestLoginAdd,
  cronInputs,
  guestLoginRow,
  guestSummary,
  guestView,
  inviteGet,
  mintInvite,
  recipeFor,
  recipeNames,
  slugFree,
  whoami,
  writeDocAsUser,
} from "./svc.js";
import { guestSessionSecret, signGuestSessionV2, verifyGuestSessionV2 } from "./guest-session.js";

/**
 * What index.js lends this module: its response helper and its per-isolate
 * caches and limiter state.
 * @typedef {{
 *   json: (status: number, body: Record<string, any>) => Response,
 *   cacheGet: (key: string) => Promise<any>,
 *   cachePut: (key: string, value: any, seconds: number) => Promise<void>,
 *   cacheDelete: (key: string) => Promise<void>,
 *   rateState: Map<string, { count: number, windowStart: number }>,
 *   todayIso: string,
 *   nowMs: number,
 *   fetchImpl?: (input: string, init?: any) => Promise<Response>,
 * }} RouteCtx
 */

const ID_RE = /^[a-z0-9-]+$/;
/** a claimed guest's grant, and the status page, last 60 days (1.95 INVITE_STATUS_TTL_MS) */
const GUEST_GRANT_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * SHA-256 hex of an invite code: the only form the database ever holds.
 * @param {string} code
 */
export async function inviteCodeHash(code) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`mise-invite:${code}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Is a database timestamp in the past? Compared as instants, never as text
 * (fix loop 1, E12: Postgres may answer "2026-10-27 12:00:00+00" or another
 * zone). Unreadable counts as past, the safe side.
 * @param {string} ts @param {number} nowMs
 */
export function pastIso(ts, nowMs) {
  const t = Date.parse(String(ts).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return !(Number.isFinite(t) && t > nowMs);
}

/** @param {RouteCtx} ctx @param {unknown} e */
function unreachable(ctx, e) {
  console.log("supabase route failed", e instanceof Error ? e.message : String(e));
  return ctx.json(502, { error: "could not reach the kitchen's records, try again in a minute" });
}

// ---- guest log in --------------------------------------------------------

/**
 * /guest/login and /guest/me on a switched branch. Called after index.js
 * has applied the per-address budget, the body cap and the per-name limiter.
 * @param {string} pathname
 * @param {any} body
 * @param {"main" | "sandbox"} branch
 * @param {any} env
 * @param {RouteCtx} ctx
 */
export async function supaGuestRoute(pathname, body, branch, env, ctx) {
  const project = projectFor(branch, env);
  const secret = guestSessionSecret(env);
  if (!project || !secret) return ctx.json(503, { error: "guest log in is not switched on yet" });
  const f = ctx.fetchImpl;
  const nope = () =>
    ctx.json(401, {
      error:
        "That name and passkey don't match. Check the spelling, or ask your host for a new link.",
    });
  const paused = () =>
    ctx.json(429, {
      error:
        "Too many tries for that name. Log in is paused for a few minutes; wait, then try again.",
    });
  try {
    if (pathname === "/guest/login") {
      const nameKey = guestNameKey(body?.name);
      const pin = typeof body?.pin === "string" ? body.pin : "";
      const failKey = `https://mise-worker.internal/sb-guest-fail/${branch}/${nameKey ?? "invalid"}`;
      const fails = await ctx.cacheGet(failKey);
      const row = nameKey ? await guestLoginRow(project, nameKey, f) : null;
      // the hash always runs, so every answer costs the same
      const good =
        row && validGuestPin(pin) && !guestLocked(fails, ctx.nowMs)
          ? await verifyGuestPin(pin, row.salt, row.hash)
          : (await hashGuestPin(validGuestPin(pin) ? pin : "0000", GUEST_DUMMY_SALT), false);
      if (guestLocked(fails, ctx.nowMs)) return paused();
      if (!good || !row) {
        if (nameKey) {
          await ctx.cachePut(
            failKey,
            guestAfterFail(fails, ctx.nowMs),
            Math.ceil(GUEST_LOCK_MS / 1000),
          );
        }
        return nope();
      }
      // a live grant is part of being able to log in at all
      const view = await guestView(project, row.slug, f);
      if (!view || !view.hasLogin) return nope();
      await ctx.cacheDelete(failKey);
      const session = await signGuestSessionV2({ p: row.slug, b: branch }, secret, ctx.nowMs);
      return ctx.json(200, { session, name: firstNameOf(view.name) });
    }

    // /guest/me: the session, then the login row and the live grant (a
    // deleted login or a lapsed grant signs the guest out at once)
    const s = await verifyGuestSessionV2(body?.session, secret, branch, ctx.nowMs);
    const view = s ? await guestView(project, s.p, f) : null;
    if (!s || !view || !view.hasLogin) return ctx.json(401, { error: "signed out" });
    const first = firstNameOf(view.name);
    const rows = inviteStatusRows(
      view.tables,
      s.p,
      (id) => id,
      (id) => firstNameOf(view.names[id] ?? ""),
      ctx.todayIso,
    );
    /** @type {Record<string, any>} */
    const recipes = {};
    const ids = [...new Set(rows.map((r) => r.dish).filter((id) => ID_RE.test(id)))].slice(0, 6);
    for (const id of ids) {
      const key = `https://mise-worker.internal/sb-recipe-guest/${branch}/${view.hostHouse}/${id}`;
      let r = await ctx.cacheGet(key);
      if (!r) {
        r = guestRecipe(await recipeFor(project, view.hostHouse, id, f));
        if (r) await ctx.cachePut(key, r, 3600);
      }
      if (r && JSON.stringify(recipes).length < 120_000) recipes[id] = r;
    }
    const profile = view.profileId
      ? guestProfileSummary(await guestSummary(project, view.profileId, f).catch(() => null), first)
      : null;
    return ctx.json(200, {
      name: first,
      rows: rows.map((r) => ({
        ...r,
        recipeId: r.dish,
        dish: recipes[r.dish]?.name ?? r.dish.replace(/-/g, " "),
      })),
      recipes,
      ...(profile ? { profile } : {}),
    });
  } catch (e) {
    return unreachable(ctx, e);
  }
}

// ---- invite claim and status ---------------------------------------------

/**
 * /invite/claim and /invite/status on a switched branch. Called after
 * index.js has applied the per-address budget and the body cap and checked
 * the code's shape.
 * @param {string} pathname
 * @param {any} body
 * @param {string} code a well-formed code
 * @param {"main" | "sandbox"} branch
 * @param {any} env
 * @param {RouteCtx} ctx
 */
export async function supaInviteRoute(pathname, body, code, branch, env, ctx) {
  const project = projectFor(branch, env);
  if (!project) return ctx.json(503, { error: "invites are not switched on yet" });
  const f = ctx.fetchImpl;
  const nowIso = new Date(ctx.nowMs).toISOString();
  try {
    const codeHash = await inviteCodeHash(code);
    const inv = await inviteGet(project, codeHash, f);
    if (!inv) return ctx.json(404, { error: "that invite does not exist" });

    if (pathname === "/invite/status") {
      if (!inv.usedAt || !inv.claimed) {
        return pastIso(inv.expiresAt, ctx.nowMs)
          ? ctx.json(410, { error: "this invite has expired, ask for a new one" })
          : ctx.json(200, { state: "unclaimed" });
      }
      if (inv.statusUntil && pastIso(inv.statusUntil, ctx.nowMs)) {
        return ctx.json(410, { error: "this link has expired, ask for a new one" });
      }
      const view = await guestView(project, inv.claimed, f);
      if (!view) return ctx.json(410, { error: "this link has expired, ask for a new one" });
      const rows = inviteStatusRows(
        view.tables,
        inv.claimed,
        (id) => id,
        (id) => view.names[id] ?? "a guest",
        ctx.todayIso,
      );
      const ids = [...new Set(rows.map((r) => r.dish).filter((id) => ID_RE.test(id)))].slice(0, 4);
      const names = await recipeNames(project, view.hostHouse, ids, f);
      return ctx.json(200, {
        state: "claimed",
        name: view.name || "you",
        house: view.hostHouse,
        rows: rows.map((r) => ({
          ...r,
          dish:
            names[r.dish] ??
            r.dish
              .split("-")
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(" "),
        })),
      });
    }

    // /invite/claim
    if (inv.usedAt) return ctx.json(410, { error: "this invite was already used" });
    if (pastIso(inv.expiresAt, ctx.nowMs)) {
      return ctx.json(410, { error: "this invite has expired, ask for a new one" });
    }
    const entry = sanitizeInviteEntry(body?.entry);
    const targets = sanitizeInviteTargets(body?.targets);
    if (!entry) return ctx.json(400, { error: "a name and an emoji are required" });
    if (!targets) {
      return ctx.json(400, {
        error:
          "the profile could not be saved: check the numbers, and keep the allergy and avoid lists to a few hundred foods",
      });
    }
    // invites are guest-only on Supabase, so every claimant may pick dinners
    const dinners = sanitizeInviteDinners(body?.dinners, nowIso.slice(0, 10));

    /** @type {null | { name_key: string, salt: string, hash: string }} */
    let login = null;
    if (body?.login !== undefined) {
      const nameKey = guestNameKey(body.login?.name);
      if (!nameKey || !validGuestPin(body.login?.pin)) {
        return ctx.json(400, {
          error: "pick a login name of 2 to 30 letters and a 4-digit passkey",
        });
      }
      const { salt, hash } = await hashGuestPin(String(body.login.pin));
      login = { name_key: nameKey, salt, hash };
    }

    // a taken login name is refused HERE, before the code is spent
    if (login && (await guestLoginRow(project, login.name_key, f))) {
      if (!allowRequest(ctx.rateState, `claimname:${code}`, ctx.nowMs, 6)) {
        return ctx.json(429, {
          error: "Too many names tried. Wait a few minutes, or ask your host for help.",
        });
      }
      return ctx.json(409, { error: "that login name is taken; add your last initial" });
    }
    // family stays off Supabase claims: on 2.0 a guest's family is the
    // admin's to set (profiles.family), never something a link can claim
    const roster = {
      name: entry.name,
      emoji: entry.emoji,
      phase: targets.phase,
      capabilities: [],
      ...(dinners.length > 0 ? { wantsDinners: dinners } : {}),
    };
    // the grant runs as long as the status page does (60 days, as in 1.95)
    const until = new Date(ctx.nowMs + GUEST_GRANT_MS).toISOString().slice(0, 10);
    /** @type {Set<string>} */
    const taken = new Set();
    for (let tries = 0; tries < 5; tries++) {
      const slug = slugForName(entry.name, taken);
      taken.add(slug);
      if (!(await slugFree(project, slug, f))) continue;
      const r = await claimGuest(project, { codeHash, slug, roster, targets, until }, f);
      if (r.status === "slug_taken") continue;
      if (r.status === "invalid") return ctx.json(410, { error: "this invite was already used" });
      if (r.status === "guarded") {
        return ctx.json(422, {
          error:
            "Something you typed (your name or a note) can't be saved for this kitchen. Change it and try again; your link still works.",
        });
      }
      // from here the code is SPENT: a later failure must not invite a retry
      // that can only answer 410
      if (!login)
        return ctx.json(200, { ok: true, id: slug, name: entry.name, house: "guesthouse" });
      const added = await guestLoginAdd(
        project,
        { profileId: r.profileId, nameKey: login.name_key, salt: login.salt, hash: login.hash },
        f,
      ).catch(() => false);
      if (!added) {
        console.log("invite claim: login not saved after the claim");
        return ctx.json(502, {
          error: "something went wrong saving your login; ask for a new link",
        });
      }
      const secret = guestSessionSecret(env);
      const session = secret
        ? await signGuestSessionV2({ p: slug, b: branch }, secret, ctx.nowMs)
        : "";
      return ctx.json(200, { ok: true, id: slug, name: entry.name, house: "guesthouse", session });
    }
    return ctx.json(409, { error: "could not find a free name, try a different one" });
  } catch (e) {
    return unreachable(ctx, e);
  }
}

// ---- authenticated routes for a JWT caller --------------------------------

/**
 * @typedef {{ kind: "jwt", sub: string, jwt: string, project: import("./supabase-env.js").SupabaseProject }} JwtCaller
 */

/**
 * /invite/new for a signed-in member: a GUEST invite to a house they belong to.
 * @param {JwtCaller} who
 * @param {any} body
 * @param {RouteCtx} ctx
 */
export async function supaInviteNew(who, body, ctx) {
  if (body?.house === "member") {
    return ctx.json(400, { error: "only guests are invited by link; the admin adds members" });
  }
  const hostHouse = slugOf(body?.hostHouse);
  if (!hostHouse) return ctx.json(400, { error: "which house is the guest coming to?" });
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const code = mintInviteCode(bytes);
  const expiresAt = new Date(ctx.nowMs + INVITE_TTL_MS).toISOString();
  try {
    const r = await mintInvite(
      who.project,
      { user: who.sub, codeHash: await inviteCodeHash(code), hostHouse, expiresAt },
      ctx.fetchImpl,
    );
    if (r !== "ok") return ctx.json(403, { error: "you can invite guests only to your own house" });
    return ctx.json(200, { code, house: "guesthouse", expiresAt });
  } catch (e) {
    return unreachable(ctx, e);
  }
}

/**
 * The admin check for notify-test: the schedule it previews is the admin's.
 * @param {JwtCaller} who
 * @param {RouteCtx} ctx
 * @returns {Promise<Response | null>} a refusal, or null when the caller is the admin
 */
export async function requireAdmin(who, ctx) {
  try {
    const me = await whoami(who.project, who.sub, ctx.fetchImpl);
    if (me?.admin) return null;
    return ctx.json(403, { error: "notifications are set up for the admin's phone only" });
  } catch (e) {
    return unreachable(ctx, e);
  }
}

/**
 * The hourly cron's inputs from Supabase, in the shape runNotifications reads.
 * @param {{ url: string, secret: string }} project
 * @param {(input: string, init?: any) => Promise<Response>} [fetchImpl]
 * @returns {import("./cron-source.js").CronSource}
 */
export function supabaseCronSource(project, fetchImpl) {
  return {
    async read(weekId, wantsShopping) {
      const r = await cronInputs(project, weekId, wantsShopping, fetchImpl);
      return {
        me: r.profile,
        house: r.house,
        plan: r.plan,
        events: r.events,
        shopping: r.shopping,
      };
    },
    async names(house, ids) {
      return recipeNames(project, house, ids, fetchImpl);
    },
  };
}

/**
 * annotate-save's write for a signed-in caller: the admin's save goes to the
 * bank (recipes/<id>.json); anyone else's to their own recipes. The database
 * decides who may write where and refuses a person's name in the bank.
 * @param {JwtCaller} who
 * @param {string} id
 * @param {Record<string, unknown>} recipe
 * @param {RouteCtx} ctx
 */
export async function supaAnnotateSave(who, id, recipe, ctx) {
  try {
    const me = await whoami(who.project, who.sub, ctx.fetchImpl);
    if (!me) return ctx.json(403, { error: "this account has no profile yet" });
    const path = me.admin ? `recipes/${id}.json` : `profiles/${me.slug}/recipes/${id}.json`;
    await writeDocAsUser(who.project, who.jwt, path, recipe, null, ctx.fetchImpl);
    return ctx.json(200, { recipe, saved: me.admin ? "bank" : "mine" });
  } catch (e) {
    if (e instanceof SvcError) {
      if (e.code === "P0409") {
        return ctx.json(409, { error: "a recipe with this name was already saved today" });
      }
      if (e.code === "P0422") {
        return ctx.json(422, {
          error:
            "the recipe names a person, so it cannot go where others read it; take the name out",
        });
      }
      if (e.code === "P0403") return ctx.json(403, { error: "you cannot save to the cookbook" });
    }
    return unreachable(ctx, e);
  }
}
