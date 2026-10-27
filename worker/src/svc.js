// Mise 2.0 (plan section 4.2, "Worker readers ... each moved to a typed svc
// function", ENG L2-5): the Worker's ONLY door into Supabase.
//
// Every call is a PostgREST RPC into the `svc` schema with the project's
// SECRET key (svc is exposed to the Data API, but authenticated and anon have
// no USAGE on it, RT N5). The functions are typed and narrow on purpose: the
// Worker never gets a generic "read any path".
//
// THIS FILE IS THE CONTRACT with the DB lane (supabase/migrations/). Each
// wrapper below names the SQL signature it expects. Marked [B2] = already in
// the DB lane's B2 migration with this exact signature; marked [NEEDED] = the
// Worker needs the DB lane to add it (listed in the lane notes). A function missing on the
// server answers 404 from PostgREST, which reaches the caller as SvcError
// and the route as a 502/503, never as a silent empty result.
//
// One call path writes AS THE USER instead (`writeDocAsUser`): annotate-save
// forwards the caller's own JWT to public.write_doc, so the bank's admin-only
// rule and the name guard decide, exactly as they do for the app.

export class SvcError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string} [code] Postgres error code (P0403, P0409, P0422 ...)
   */
  constructor(message, status, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @typedef {(input: string, init?: any) => Promise<Response>} FetchImpl
 * @typedef {{ url: string, secret: string, publishable?: string }} SvcProject
 */

/**
 * POST /rest/v1/rpc/<fn> in a schema.
 * @param {SvcProject} project
 * @param {string} fn
 * @param {Record<string, unknown>} args
 * @param {{ fetchImpl?: FetchImpl, schema?: string, bearer?: string, apikey?: string }} [opts]
 * @returns {Promise<any>}
 */
export async function rpc(project, fn, args, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? ((i, n) => fetch(i, n));
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(fn)) throw new SvcError("bad function name", 400);
  const res = await fetchImpl(`${project.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: opts.apikey ?? project.secret,
      authorization: `Bearer ${opts.bearer ?? project.secret}`,
      "content-type": "application/json",
      accept: "application/json",
      "content-profile": opts.schema ?? "svc",
      "accept-profile": opts.schema ?? "svc",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  /** @type {any} */
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new SvcError(`${fn} ${res.status}`, res.status, String(body?.code ?? ""));
  }
  return body;
}

// ---- the typed svc functions (the DB lane's contract) ----------------------

/**
 * [B2] svc.entitled(p_sub uuid) returns boolean
 * True for an entitled (or admin) non-probe profile whose user_id is p_sub.
 * @param {SvcProject} project @param {string} sub @param {FetchImpl} [fetchImpl]
 */
export async function entitled(project, sub, fetchImpl) {
  return (await rpc(project, "entitled", { p_sub: sub }, { fetchImpl })) === true;
}

/**
 * [B2] svc.ai_count(p_sub uuid) returns int
 * Adds one call to public.ai_usage(p_sub, current_date) and returns that
 * row's count for today. The Worker uses two reserved rows besides each
 * person's: the shared PAT quota and the global ceiling (auth.js).
 * @param {SvcProject} project @param {string} sub @param {FetchImpl} [fetchImpl]
 * @returns {Promise<number>}
 */
export async function aiCount(project, sub, fetchImpl) {
  const r = await rpc(project, "ai_count", { p_sub: sub }, { fetchImpl });
  const n = Number(r);
  if (!Number.isFinite(n)) throw new SvcError("ai_count returned no count", 502);
  return n;
}

/**
 * svc.ai_take(p_sub uuid, p_n int, p_day date, p_user_cap int, p_global_cap int)
 * returns text (fix loop 1, E9; supabase/migrations/20261104100000_worker_ai_take.sql):
 * adds p_n to the person's row and, unless that row is over its cap, to the
 * global row, for David's day, in ONE call. 'ok' | 'user' | 'global'.
 * @param {SvcProject} project
 * @param {{ sub: string, n: number, day: string, userCap: number, globalCap: number }} a
 * @param {FetchImpl} [fetchImpl]
 * @returns {Promise<"ok" | "user" | "global">}
 */
export async function aiTake(project, a, fetchImpl) {
  const r = await rpc(
    project,
    "ai_take",
    { p_sub: a.sub, p_n: a.n, p_day: a.day, p_user_cap: a.userCap, p_global_cap: a.globalCap },
    { fetchImpl },
  );
  if (r !== "ok" && r !== "user" && r !== "global") throw new SvcError("ai_take returned no answer", 502);
  return r;
}

/**
 * [db fix1, 20261031100000] svc.whoami(p_sub uuid) returns jsonb
 * { slug text, admin boolean, houses text[] } for the caller's profile, or null.
 * @param {SvcProject} project @param {string} sub @param {FetchImpl} [fetchImpl]
 * @returns {Promise<{ slug: string, admin: boolean, houses: string[] } | null>}
 */
export async function whoami(project, sub, fetchImpl) {
  const r = await rpc(project, "whoami", { p_sub: sub }, { fetchImpl });
  if (!r || typeof r.slug !== "string") return null;
  return {
    slug: r.slug,
    admin: r.admin === true,
    houses: Array.isArray(r.houses)
      ? r.houses.filter((/** @type {unknown} */ h) => typeof h === "string")
      : [],
  };
}

/**
 * [B2] svc.recipe_for(p_house text, p_id text) returns jsonb
 * The bank row's data, or households/<p_house>/recipes/<p_id>.json when p_id
 * starts with "house-"; null otherwise (and null for a staging recipe).
 * @param {SvcProject} project @param {string} house @param {string} id @param {FetchImpl} [fetchImpl]
 */
export async function recipeFor(project, house, id, fetchImpl) {
  const r = await rpc(project, "recipe_for", { p_house: house, p_id: id }, { fetchImpl });
  return r && typeof r === "object" ? /** @type {Record<string, any>} */ (r) : null;
}

/**
 * [B2] svc.recipe_names(p_house text, p_ids text[]) returns jsonb
 * { "<id>": "<name>" } for the ids that resolve (bank, or that house's specials).
 * @param {SvcProject} project @param {string} house @param {string[]} ids @param {FetchImpl} [fetchImpl]
 * @returns {Promise<Record<string, string>>}
 */
export async function recipeNames(project, house, ids, fetchImpl) {
  if (ids.length === 0) return {};
  const r = await rpc(project, "recipe_names", { p_house: house, p_ids: ids }, { fetchImpl });
  /** @type {Record<string, string>} */
  const out = {};
  if (r && typeof r === "object") {
    for (const [k, v] of Object.entries(r)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * [db fix1, 20261031100000] svc.cron_inputs(p_week text, p_with_shopping boolean) returns jsonb
 * The root profile's (private.settings root_profile) inputs to the hourly
 * notifications: { profile text, house text|null, plan jsonb|null,
 * events jsonb|null, shopping jsonb|null }. `house` is the root profile's
 * home household slug; `events` is that house's events.json data.
 * @param {SvcProject} project @param {string} week @param {boolean} withShopping @param {FetchImpl} [fetchImpl]
 */
export async function cronInputs(project, week, withShopping, fetchImpl) {
  const r = await rpc(
    project,
    "cron_inputs",
    { p_week: week, p_with_shopping: withShopping },
    { fetchImpl },
  );
  return {
    profile: typeof r?.profile === "string" ? r.profile : "",
    house: typeof r?.house === "string" ? r.house : "",
    plan: r?.plan && typeof r.plan === "object" ? r.plan : null,
    events: r?.events && typeof r.events === "object" ? r.events : null,
    shopping: r?.shopping && typeof r.shopping === "object" ? r.shopping : null,
  };
}

/**
 * [B2] svc.slug_free(p_slug text) returns boolean
 * True only when there is no profiles row with that slug AND no docs row
 * under profiles/<p_slug>/ (a recycled id would inherit a stranger's targets).
 * @param {SvcProject} project @param {string} slug @param {FetchImpl} [fetchImpl]
 */
export async function slugFree(project, slug, fetchImpl) {
  return (await rpc(project, "slug_free", { p_slug: slug }, { fetchImpl })) === true;
}

/**
 * [db fix1, 20261031100000] svc.mint_invite(p_sub uuid, p_code_hash text, p_host_house text, p_expires_at timestamptz) returns text
 * Inserts a guest invite for p_host_house when the caller is an entitled
 * member of that house (or the admin): 'ok', else 'forbidden'.
 * @param {SvcProject} project
 * @param {{ user: string, codeHash: string, hostHouse: string, expiresAt: string }} a
 * @param {FetchImpl} [fetchImpl]
 */
export async function mintInvite(project, a, fetchImpl) {
  const r = await rpc(
    project,
    "mint_invite",
    {
      p_sub: a.user,
      p_code_hash: a.codeHash,
      p_host_house: a.hostHouse,
      p_expires_at: a.expiresAt,
    },
    { fetchImpl },
  );
  return r === "ok" ? "ok" : "forbidden";
}

/**
 * [db fix1, 20261031100000] svc.invite_get(p_code_hash text) returns jsonb
 * { host_house text, expires_at text, used_at text|null, claimed text|null
 * (the claimed profile's slug), status_until text|null } or null.
 * @param {SvcProject} project @param {string} codeHash @param {FetchImpl} [fetchImpl]
 */
export async function inviteGet(project, codeHash, fetchImpl) {
  const r = await rpc(project, "invite_get", { p_code_hash: codeHash }, { fetchImpl });
  if (!r || typeof r.host_house !== "string") return null;
  return {
    hostHouse: r.host_house,
    expiresAt: String(r.expires_at ?? ""),
    usedAt: typeof r.used_at === "string" ? r.used_at : null,
    claimed: typeof r.claimed === "string" ? r.claimed : null,
    statusUntil: typeof r.status_until === "string" ? r.status_until : null,
  };
}

/**
 * [B2] svc.claim_guest(p_code_hash text, p_slug text, p_roster jsonb, p_targets jsonb, p_until date) returns uuid
 * ONE transaction: spends an unused, unexpired guest invite and creates the
 * guest profile (kind 'guest'), its grant to the invite's host house until
 * p_until, and BOTH targets docs rows (the plate trigger fires on them).
 * Raises P0403 when the invite is invalid and P0409 when the slug is taken.
 * Fix loop 1, E11: 23505 (a slug inserted by a racing claim) is a taken slug
 * too, and P0422 (the guest's own entry trips the host house's name guard)
 * is "guarded", which the route answers in plain words.
 * @param {SvcProject} project
 * @param {{ codeHash: string, slug: string, roster: Record<string, unknown>, targets: Record<string, unknown>, until: string }} a
 * @param {FetchImpl} [fetchImpl]
 * @returns {Promise<{ status: "ok" | "invalid" | "slug_taken" | "guarded", profileId: string }>}
 */
export async function claimGuest(project, a, fetchImpl) {
  try {
    const r = await rpc(
      project,
      "claim_guest",
      {
        p_code_hash: a.codeHash,
        p_slug: a.slug,
        p_roster: a.roster,
        p_targets: a.targets,
        p_until: a.until,
      },
      { fetchImpl },
    );
    return { status: "ok", profileId: String(r ?? "") };
  } catch (e) {
    if (e instanceof SvcError && (e.code === "P0409" || e.code === "23505"))
      return { status: "slug_taken", profileId: "" };
    if (e instanceof SvcError && e.code === "P0422") return { status: "guarded", profileId: "" };
    if (e instanceof SvcError && e.code === "P0403") return { status: "invalid", profileId: "" };
    throw e;
  }
}

/**
 * [db fix1, 20261031100000] svc.guest_login_add(p_profile uuid, p_name_key text, p_salt text, p_hash text) returns boolean
 * Inserts the guest_logins row; false (nothing written) when the name_key is taken.
 * @param {SvcProject} project
 * @param {{ profileId: string, nameKey: string, salt: string, hash: string }} a
 * @param {FetchImpl} [fetchImpl]
 */
export async function guestLoginAdd(project, a, fetchImpl) {
  const r = await rpc(
    project,
    "guest_login_add",
    { p_profile: a.profileId, p_name_key: a.nameKey, p_salt: a.salt, p_hash: a.hash },
    { fetchImpl },
  );
  return r === true;
}

/**
 * [db fix1, 20261031100000] svc.guest_login_row(p_name_key text) returns jsonb
 * { slug text, salt text, hash text } or null.
 * @param {SvcProject} project @param {string} nameKey @param {FetchImpl} [fetchImpl]
 */
export async function guestLoginRow(project, nameKey, fetchImpl) {
  const r = await rpc(project, "guest_login_row", { p_name_key: nameKey }, { fetchImpl });
  if (!r || typeof r.slug !== "string") return null;
  return { slug: r.slug, salt: String(r.salt ?? ""), hash: String(r.hash ?? "") };
}

/**
 * [db fix1, 20261031100000] svc.guest_view(p_slug text) returns jsonb
 * For a guest profile with a LIVE grant (until >= current_date):
 * { profile_id uuid, name text, has_login boolean, host_house text,
 *   tables jsonb (the host house's events.json "tables"),
 *   names jsonb ({ slug: roster name } for the people seated at those tables only) }.
 * Null for an unknown slug, a non-guest, or an expired grant.
 * @param {SvcProject} project @param {string} slug @param {FetchImpl} [fetchImpl]
 */
export async function guestView(project, slug, fetchImpl) {
  const r = await rpc(project, "guest_view", { p_slug: slug }, { fetchImpl });
  if (!r || typeof r.host_house !== "string") return null;
  /** @type {Record<string, string>} */
  const names = {};
  if (r.names && typeof r.names === "object") {
    for (const [k, v] of Object.entries(r.names)) if (typeof v === "string") names[k] = v;
  }
  return {
    profileId: String(r.profile_id ?? ""),
    name: String(r.name ?? ""),
    hasLogin: r.has_login === true,
    hostHouse: r.host_house,
    tables: Array.isArray(r.tables) ? r.tables : [],
    names,
  };
}

/**
 * [B2] svc.guest_summary(p_profile uuid) returns jsonb
 * The guest's own profile/targets.json data (the guest is its owner), or null.
 * @param {SvcProject} project @param {string} profileId @param {FetchImpl} [fetchImpl]
 */
export async function guestSummary(project, profileId, fetchImpl) {
  const r = await rpc(project, "guest_summary", { p_profile: profileId }, { fetchImpl });
  return r && typeof r === "object" ? r : null;
}

/**
 * [B2] svc.guard_hits() returns jsonb
 * { docs, recipes, plates }: rows carrying a guarded term where that term's
 * audience can read it. The weekly probe wants every count 0; this returns
 * their sum (NaN when the answer is not that shape).
 * @param {SvcProject} project @param {FetchImpl} [fetchImpl]
 */
export async function guardHits(project, fetchImpl) {
  const r = await rpc(project, "guard_hits", {}, { fetchImpl });
  if (typeof r === "number") return r;
  if (!r || typeof r !== "object") return Number.NaN;
  const vals = Object.values(r).map(Number);
  if (vals.length === 0 || vals.some((v) => !Number.isFinite(v))) return Number.NaN;
  return vals.reduce((a, b) => a + b, 0);
}

// ---- as the user -----------------------------------------------------------

/**
 * public.write_doc(p_path, p_data, p_expected_rev) with the CALLER's JWT, so
 * RLS, the admin-only bank rule and the name guard decide.
 * @param {SvcProject} project
 * @param {string} jwt
 * @param {string} path
 * @param {Record<string, unknown>} data
 * @param {number | null} expectedRev
 * @param {FetchImpl} [fetchImpl]
 * @returns {Promise<number>} the new rev
 */
export async function writeDocAsUser(project, jwt, path, data, expectedRev, fetchImpl) {
  // NEVER the secret key here: a secret apikey can lift the request to
  // service_role and walk past the very RLS this call exists to apply
  if (!project.publishable) throw new SvcError("publishable key not configured", 503);
  const r = await rpc(
    project,
    "write_doc",
    { p_path: path, p_data: data, p_expected_rev: expectedRev },
    { fetchImpl, schema: "public", bearer: jwt, apikey: project.publishable },
  );
  return Number(r);
}
