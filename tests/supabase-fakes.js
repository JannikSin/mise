// Test-only fakes for the 2.0 Worker lane: a locally generated ES256 key pair
// that signs Supabase-shaped JWTs, and an in-memory Supabase (JWKS plus
// PostgREST RPCs). Nothing here ever reaches a real project: the project URL
// is a placeholder and every fetch is answered in memory.
// (Not a *.test.js file, so `node --test tests/*.test.js` does not run it.)

export const PROJECT_REF = "placeholderref01";
export const SANDBOX_REF = "placeholdersbx01";
export const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
export const SANDBOX_URL = `https://${SANDBOX_REF}.supabase.co`;
export const USER_A = "11111111-1111-4111-8111-111111111111";
export const USER_B = "22222222-2222-4222-8222-222222222222";

/** env with the sandbox branch switched to Supabase (placeholders only) */
export const SANDBOX_ENV = {
  SUPABASE_BACKEND: "sandbox",
  SUPABASE_SANDBOX_URL: SANDBOX_URL,
  SUPABASE_SANDBOX_SECRET_KEY: "sb_secret_PLACEHOLDER",
  SUPABASE_SANDBOX_PUBLISHABLE_KEY: "sb_publishable_PLACEHOLDER",
  GUEST_SESSION_KEY: "test-guest-session-key-PLACEHOLDER",
};

/** @param {Uint8Array} bytes */
function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** @param {any} obj */
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

/**
 * A fresh ES256 key pair and its public JWK.
 * @param {string} kid
 */
export async function makeKey(kid = "kid-1") {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid, alg: "ES256", use: "sig" },
  };
}

/**
 * Sign a JWT. `claims` overrides the good defaults; `header` overrides the header.
 * @param {{ kid: string, privateKey: CryptoKey }} key
 * @param {Record<string, any>} [claims]
 * @param {Record<string, any>} [header]
 * @param {string} [iss]
 */
export async function signJwt(key, claims = {}, header = {}, iss = `${SANDBOX_URL}/auth/v1`) {
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: "ES256", typ: "JWT", kid: key.kid, ...header });
  const p = enc({
    iss,
    sub: USER_A,
    aud: "authenticated",
    role: "authenticated",
    is_anonymous: false,
    email: "guest-a@example.test",
    iat: now,
    exp: now + 3600,
    ...claims,
  });
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

/**
 * An in-memory Supabase: JWKS for each project plus RPC handlers.
 * `rpc[name]` is (args, ctx) => value | Response; ctx carries headers and the project.
 * Any other URL falls through to `other` (for example a fake GitHub).
 * @param {{ jwks?: Record<string, any[]>, rpc?: Record<string, (args: any, ctx: any) => any>, other?: (input: any, init: any) => Promise<Response> }} cfg
 */
export function fakeSupabase(cfg) {
  /** @type {{ url: string, fn?: string, args?: any, headers: Headers }[]} */
  const calls = [];
  const fetchImpl = async (/** @type {any} */ input, /** @type {any} */ init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers ?? {});
    const host = url.host;
    if (host.endsWith(".supabase.co")) {
      const ref = host.split(".")[0];
      if (url.pathname === "/auth/v1/.well-known/jwks.json") {
        calls.push({ url: url.toString(), headers });
        return Response.json({ keys: cfg.jwks?.[/** @type {string} */ (ref)] ?? [] });
      }
      const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_0-9]+)$/);
      if (m) {
        const fn = /** @type {string} */ (m[1]);
        const args = JSON.parse(init.body ?? "{}");
        calls.push({ url: url.toString(), fn, args, headers });
        const h = cfg.rpc?.[fn];
        if (!h) return Response.json({ code: "PGRST202", message: "not found" }, { status: 404 });
        const out = await h(args, { headers, ref });
        if (out instanceof Response) return out;
        return Response.json(out === undefined ? null : out);
      }
      if (url.pathname === "/auth/v1/token") {
        calls.push({ url: url.toString(), args: JSON.parse(init.body ?? "{}"), headers });
        const h = cfg.rpc?.["__token"];
        const out = h ? await h(JSON.parse(init.body ?? "{}"), { headers, ref }) : null;
        if (out instanceof Response) return out;
        return out ? Response.json(out) : Response.json({ error: "invalid" }, { status: 400 });
      }
      const rest = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
      if (rest) {
        const table = /** @type {string} */ (rest[1]);
        calls.push({ url: url.toString(), fn: `table:${table}`, headers });
        const h = cfg.rpc?.[`table:${table}`];
        const out = h ? await h(Object.fromEntries(url.searchParams), { headers, ref }) : [];
        if (out instanceof Response) return out;
        return Response.json(out);
      }
      return new Response("not found", { status: 404 });
    }
    if (cfg.other) return cfg.other(input, init);
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchImpl };
}

/**
 * Run fn with globalThis.fetch replaced.
 * @template T
 * @param {(input: any, init?: any) => Promise<Response>} f
 * @param {() => Promise<T>} fn
 */
export async function withFetch(f, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (f);
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/**
 * A Worker request from an origin, with an x-mise-auth value.
 * @param {string} path
 * @param {any} body
 * @param {{ origin?: string, auth?: string, ip?: string }} [o]
 */
export function workerReq(path, body, o = {}) {
  /** @type {Record<string, string>} */
  const headers = {
    origin: o.origin ?? "https://mise-next.pages.dev",
    "content-type": "application/json",
    "cf-connecting-ip": o.ip ?? "9.9.9.9",
  };
  if (o.auth) headers["x-mise-auth"] = o.auth;
  return new Request(`https://mise-worker.janniksin.workers.dev${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * A tiny in-memory stand-in for the svc contract in worker/src/svc.js, with
 * just enough behaviour to drive the Worker's Supabase routes. It is a TEST
 * DOUBLE of the contract, not of the SQL: the DB lane's PGlite suite tests
 * the real functions.
 * @param {{ root?: string, people?: any[], docs?: Record<string, any>, bank?: Record<string, any>, logins?: Record<string, any> }} seed
 */
export function fakeSvcDb(seed = {}) {
  const st = {
    root: seed.root ?? "host-1",
    /** @type {any[]} people: { id uuid, slug, user, kind, home, houses[], name, admin, entitled, grantUntil? } */
    people: seed.people ?? [],
    /** @type {Record<string, any>} */ docs: { ...(seed.docs ?? {}) },
    /** @type {Record<string, any>} */ bank: { ...(seed.bank ?? {}) },
    /** @type {Record<string, any>} */ logins: { ...(seed.logins ?? {}) },
    /** @type {Record<string, any>} */ invites: {},
    /** @type {any[]} */ writes: [],
  };
  let n = 0;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  const byUser = (/** @type {string} */ u) => st.people.find((p) => p.user === u);
  const bySlug = (/** @type {string} */ s) => st.people.find((p) => p.slug === s);
  const pgErr = (/** @type {string} */ code) =>
    Response.json({ code, message: "refused" }, { status: 400 });
  /** @type {Record<string, (a: any, ctx: any) => any>} */
  const rpc = {
    entitled: (a) => Boolean(byUser(a.p_user)?.entitled),
    ai_take: () => "ok",
    whoami: (a) => {
      const p = byUser(a.p_user);
      return p ? { slug: p.slug, admin: Boolean(p.admin), houses: p.houses ?? [] } : null;
    },
    recipe_for: (a) =>
      String(a.p_id).startsWith("house-")
        ? (st.docs[`households/${a.p_house}/recipes/${a.p_id}.json`] ?? null)
        : (st.bank[a.p_id] ?? null),
    recipe_names: (a) => {
      /** @type {Record<string, string>} */
      const out = {};
      for (const id of a.p_ids) {
        const r = rpc.recipe_for({ p_house: a.p_house, p_id: id }, {});
        if (r?.name) out[id] = r.name;
      }
      return out;
    },
    cron_inputs: (a) => {
      const me = bySlug(st.root);
      const house = me?.home ?? "";
      return {
        profile: st.root,
        house,
        plan: st.docs[`plans/${a.p_week}.json`] ?? null,
        events: st.docs[`households/${house}/events.json`] ?? null,
        shopping: a.p_with_shopping ? (st.docs["shopping.json"] ?? null) : null,
      };
    },
    slug_free: (a) =>
      !bySlug(a.p_slug) && !Object.keys(st.docs).some((k) => k.startsWith(`profiles/${a.p_slug}/`)),
    mint_invite: (a) => {
      const p = byUser(a.p_user);
      if (!p || !(p.admin || (p.houses ?? []).includes(a.p_host_house))) return "forbidden";
      st.invites[a.p_code_hash] = {
        host_house: a.p_host_house,
        expires_at: a.p_expires_at,
        used_at: null,
        claimed: null,
        status_until: null,
      };
      return "ok";
    },
    invite_get: (a) => st.invites[a.p_code_hash] ?? null,
    claim_guest: (a) => {
      const inv = st.invites[a.p_code_hash];
      if (!inv) return { status: "missing" };
      if (inv.used_at) return { status: "used" };
      if (inv.expires_at < new Date().toISOString()) return { status: "expired" };
      if (!rpc.slug_free({ p_slug: a.p_slug }, {})) return { status: "slug_taken" };
      if (a.p_login && st.logins[a.p_login.name_key]) return { status: "name_taken" };
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      st.people.push({
        id,
        slug: a.p_slug,
        kind: "guest",
        home: "guesthouse",
        houses: [],
        name: a.p_roster.name,
        roster: a.p_roster,
        family: a.p_family,
        grantHouse: inv.host_house,
        grantUntil: "2099-01-01",
      });
      st.docs[`profiles/${a.p_slug}/profile/targets.json`] = a.p_targets;
      st.docs[`profiles/${a.p_slug}/fitness/targets.json`] = a.p_targets;
      if (a.p_login) st.logins[a.p_login.name_key] = { slug: a.p_slug, salt: a.p_login.salt, hash: a.p_login.hash };
      inv.used_at = new Date().toISOString();
      inv.claimed = a.p_slug;
      inv.status_until = "2099-01-01T00:00:00.000Z";
      return { status: "ok", house: "guesthouse" };
    },
    guest_login_row: (a) => st.logins[a.p_name_key] ?? null,
    guest_view: (a) => {
      const g = bySlug(a.p_slug);
      if (!g || g.kind !== "guest" || !(g.grantUntil >= today)) return null;
      const tables = st.docs[`households/${g.grantHouse}/events.json`]?.tables ?? [];
      /** @type {Record<string, string>} */
      const names = {};
      for (const t of tables) for (const s of t.seats ?? []) {
        const p = bySlug(s.id);
        if (p) names[s.id] = p.name;
      }
      return {
        profile_id: g.id,
        name: g.name,
        has_login: Object.values(st.logins).some((l) => l.slug === g.slug),
        host_house: g.grantHouse,
        tables,
        names,
      };
    },
    guest_summary: (a) => {
      const g = st.people.find((p) => p.id === a.p_profile);
      return g ? (st.docs[`profiles/${g.slug}/profile/targets.json`] ?? null) : null;
    },
    guard_hits: () => 0,
    write_doc: (a, ctx) => {
      const bearer = String(ctx.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      st.writes.push({ path: a.p_path, bearer, apikey: ctx.headers.get("apikey"), profile: ctx.headers.get("content-profile") });
      if (JSON.stringify(a.p_data).toLowerCase().includes("guest-name-term")) return pgErr("P0422");
      if (a.p_path in st.docs) return pgErr("P0409");
      st.docs[a.p_path] = a.p_data;
      return 1;
    },
  };
  return { st, rpc };
}
