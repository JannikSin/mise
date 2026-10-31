// Mise 2.0 (plan section 4.2, "Worker token check, all of these required"):
// verify a Supabase session JWT against the project's JWKS.
//
//  - `iss` exactly https://<ref>.supabase.co/auth/v1 for the project the
//    request ORIGIN maps to (a sandbox token never works on live);
//  - one pinned `alg` (ES256, the asymmetric default; RS256 only if the env
//    pins it), and the `kid` looked up in the JWKS. The JWKS is cached at most
//    10 minutes, and an unknown `kid` buys at most one refetch, never more
//    often than every 30 seconds per project (an unknown-kid flood must not
//    turn this Worker into a fetch amplifier);
//  - `aud` and `role` both "authenticated", `is_anonymous` exactly false,
//    `exp` in the future, `nbf`/`iat` not in the future, `sub` a uuid.
// Every failure is the same null to the caller; the reason is for tests and
// the Worker log only, never sent to the client.
//
// The fetch is injectable so the tests run on a locally generated key pair
// and never touch a real project.

const JWKS_TTL_MS = 10 * 60 * 1000;
const REFETCH_FLOOR_MS = 30 * 1000;
const LEEWAY_S = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @type {Record<string, { kty: string, import: any, verify: any }>} */
const ALGS = {
  ES256: {
    kty: "EC",
    import: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
  RS256: {
    kty: "RSA",
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
  },
};

/**
 * jwksUrl -> { keys: kid -> jwk, imported: kid -> CryptoKey, fetchedAt,
 * retryAt }. retryAt is the backoff after a failed fetch (fix loop 1, R5):
 * no new fetch before it, and the keys already held keep working.
 * @type {Map<string, { keys: Map<string, any>, imported: Map<string, CryptoKey>, fetchedAt: number, retryAt: number }>}
 */
const jwksCache = new Map();

/** tests only */
export function resetJwksCacheForTests() {
  jwksCache.clear();
}

/** @param {string} s */
function b64urlBytes(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "===".slice((pad.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @param {string} s */
function b64urlJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

/**
 * The pinned algorithm: ES256 unless the env pins RS256. Anything else is ES256.
 * @param {any} env
 */
export function pinnedAlg(env) {
  return env?.SUPABASE_JWT_ALG === "RS256" ? "RS256" : "ES256";
}

/**
 * @param {string} jwksUrl
 * @param {(input: string, init?: any) => Promise<Response>} fetchImpl
 * @param {number} nowMs
 */
async function loadJwks(jwksUrl, fetchImpl, nowMs) {
  const old = jwksCache.get(jwksUrl);
  // inside the backoff after a failure: the old keys, or the outage
  if (old && nowMs < old.retryAt) {
    if (old.keys.size) return old;
    throw new Error("jwks backoff");
  }
  let body;
  try {
    const res = await fetchImpl(jwksUrl, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    body = await res.json();
  } catch (e) {
    // stale-if-error: keep what we had, and wait REFETCH_FLOOR_MS before the next try
    if (old) {
      old.retryAt = nowMs + REFETCH_FLOOR_MS;
      if (old.keys.size) return old;
    } else {
      jwksCache.set(jwksUrl, { keys: new Map(), imported: new Map(), fetchedAt: -Infinity, retryAt: nowMs + REFETCH_FLOOR_MS });
    }
    throw e;
  }
  /** @type {Map<string, any>} */
  const keys = new Map();
  for (const k of Array.isArray(body?.keys) ? body.keys : []) {
    if (k && typeof k.kid === "string" && k.kid) keys.set(k.kid, k);
  }
  const entry = { keys, imported: new Map(), fetchedAt: nowMs, retryAt: 0 };
  jwksCache.set(jwksUrl, entry);
  return entry;
}

/**
 * The CryptoKey for a kid, or null. Fresh cache first; an unknown kid buys
 * one refetch (subject to the 30-second floor).
 * @param {string} jwksUrl
 * @param {string} kid
 * @param {string} alg
 * @param {(input: string, init?: any) => Promise<Response>} fetchImpl
 * @param {number} nowMs
 * @returns {Promise<CryptoKey | null>}
 */
async function keyFor(jwksUrl, kid, alg, fetchImpl, nowMs) {
  let entry = jwksCache.get(jwksUrl);
  if (!entry || nowMs - entry.fetchedAt >= JWKS_TTL_MS) {
    entry = await loadJwks(jwksUrl, fetchImpl, nowMs);
  } else if (!entry.keys.has(kid) && nowMs - entry.fetchedAt >= REFETCH_FLOOR_MS) {
    entry = await loadJwks(jwksUrl, fetchImpl, nowMs);
  }
  const jwk = entry.keys.get(kid);
  if (!jwk) return null;
  const spec = ALGS[alg];
  if (!spec || jwk.kty !== spec.kty) return null;
  // a key that names its own alg must name the pinned one
  if (jwk.alg !== undefined && jwk.alg !== alg) return null;
  if (jwk.use !== undefined && jwk.use !== "sig") return null;
  const hit = entry.imported.get(kid);
  if (hit) return hit;
  // only the public members: key_ops / ext from the server are not trusted
  const pub =
    spec.kty === "EC"
      ? { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y }
      : { kty: "RSA", n: jwk.n, e: jwk.e };
  if (spec.kty === "EC" && jwk.crv !== "P-256") return null;
  const key = await crypto.subtle.importKey("jwk", pub, spec.import, false, ["verify"]);
  entry.imported.set(kid, key);
  return key;
}

/**
 * Verify a Supabase access token for one project.
 * @param {unknown} token
 * @param {{ iss: string, jwksUrl: string }} project
 * @param {{ fetchImpl?: (input: string, init?: any) => Promise<Response>, nowMs?: number, alg?: string }} [opts]
 * @returns {Promise<{ ok: true, sub: string, email: string, exp: number } | { ok: false, reason: string }>}
 */
export async function verifySupabaseJwt(token, project, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? ((i, n) => fetch(i, n));
  const nowMs = opts.nowMs ?? Date.now();
  const alg = opts.alg === "RS256" ? "RS256" : "ES256";
  const no = (/** @type {string} */ reason) => ({ ok: /** @type {false} */ (false), reason });
  if (typeof token !== "string" || token.length > 8192) return no("shape");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return no("shape");
  const [h, p, s] = /** @type {[string, string, string]} */ (parts);
  /** @type {any} */ let header;
  /** @type {any} */ let claims;
  try {
    header = b64urlJson(h);
    claims = b64urlJson(p);
  } catch {
    return no("shape");
  }
  if (header?.alg !== alg) return no("alg");
  if (typeof header?.kid !== "string" || !header.kid) return no("kid");
  /** @type {CryptoKey | null} */
  let key;
  try {
    key = await keyFor(project.jwksUrl, header.kid, alg, fetchImpl, nowMs);
  } catch {
    return no("jwks");
  }
  if (!key) return no("kid");
  let good;
  try {
    const spec = /** @type {any} */ (ALGS[alg]);
    good = await crypto.subtle.verify(
      spec.verify,
      key,
      b64urlBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
  } catch {
    good = false;
  }
  if (!good) return no("signature");
  const nowS = Math.floor(nowMs / 1000);
  if (claims?.iss !== project.iss) return no("iss");
  const aud = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  if (!aud.includes("authenticated")) return no("aud");
  if (claims?.role !== "authenticated") return no("role");
  if (claims?.is_anonymous !== false) return no("anonymous");
  if (typeof claims?.exp !== "number" || claims.exp <= nowS) return no("exp");
  if (typeof claims?.nbf === "number" && claims.nbf > nowS + LEEWAY_S) return no("nbf");
  if (typeof claims?.iat === "number" && claims.iat > nowS + LEEWAY_S) return no("iat");
  if (typeof claims?.sub !== "string" || !UUID_RE.test(claims.sub)) return no("sub");
  return {
    ok: true,
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : "",
    exp: claims.exp,
  };
}

/**
 * Does this x-mise-auth value look like a JWT (three base64url segments)?
 * A GitHub PAT never has a dot, so the two never collide.
 * @param {string | null} token
 */
export function looksLikeJwt(token) {
  return (
    typeof token === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  );
}
