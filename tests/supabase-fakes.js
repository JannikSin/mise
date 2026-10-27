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
