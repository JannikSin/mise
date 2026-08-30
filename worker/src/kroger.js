// Kroger API proxy (fix list Tier 3, promises P4 store + P5 budget). The
// client id/secret live ONLY in Worker secrets; the app calls these endpoints
// with the same x-mise-auth PAT as every other route. Three operations:
//   POST /kroger/locations { term }              -> { locations }
//   POST /kroger/search    { term, locationId }  -> { products }
//   POST /kroger/byId      { upcs, locationId }  -> { products }
// Quota discipline (fix list 3.3): the app caches into prices.json/pins.json
// and refreshes weekly — these endpoints exist for the confirm-once pin flow
// and the weekly refresh, never for a live re-pricing loop. Products quota is
// 10k calls/day; a whole-list refresh is ~50.

const TOKEN_URL = "https://api.kroger.com/v1/connect/oauth2/token";
const API = "https://api.kroger.com/v1";

/** Where a cart consent hand-off may return to. Mirrors the Worker CORS list. */
export const ALLOWED_RETURN_ORIGINS = ["https://janniksin.github.io", "http://127.0.0.1:8378"];

/** per-isolate token cache; client-credentials tokens live ~30 min */
let cachedToken = /** @type {{ value: string, expiresAt: number } | null} */ (null);

/** @param {{ KROGER_CLIENT_ID?: string, KROGER_CLIENT_SECRET?: string }} env */
export function krogerConfigured(env) {
  return Boolean(env.KROGER_CLIENT_ID && env.KROGER_CLIENT_SECRET);
}

/**
 * A bearer token for the Products/Locations APIs, cached until ~1 min before
 * expiry. Throws on upstream failure — callers map that to a 502.
 * @param {{ KROGER_CLIENT_ID?: string, KROGER_CLIENT_SECRET?: string }} env
 * @returns {Promise<string>}
 */
async function accessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`),
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "product.compact" }),
  });
  if (!res.ok) throw new Error(`kroger token ${res.status}`);
  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 1800) - 60) * 1000,
  };
  return cachedToken.value;
}

/**
 * One Kroger GET with auth + one retry on a transient upstream status.
 * @param {string} path
 * @param {Record<string, string>} params
 * @param {any} env
 * @returns {Promise<any[]>} the response's data array
 */
async function krogerGet(path, params, env) {
  const token = await accessToken(env);
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data?.data) ? data.data : [];
    }
    if (![429, 502, 503].includes(res.status) || attempt === 1) {
      throw new Error(`kroger ${path} ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return [];
}

/**
 * Trim a Kroger product to what the app stores and renders. items[0] carries
 * the per-store price/size/stock for the requested locationId.
 * @param {any} p
 */
export function trimProduct(p) {
  const it = (Array.isArray(p?.items) ? p.items[0] : null) ?? {};
  const price = it.price ?? {};
  return {
    upc: String(p?.upc ?? ""),
    description: String(p?.description ?? ""),
    brand: typeof p?.brand === "string" ? p.brand : "",
    categories: (Array.isArray(p?.categories) ? p.categories : []).map(String).slice(0, 6),
    size: typeof it.size === "string" ? it.size : "",
    soldBy: typeof it.soldBy === "string" ? it.soldBy : "",
    price: {
      regular: typeof price.regular === "number" ? price.regular : null,
      promo: typeof price.promo === "number" && price.promo > 0 ? price.promo : null,
    },
    stock: String(it.inventory?.stockLevel ?? ""),
    aisle: String(
      (Array.isArray(p?.aisleLocations) ? p.aisleLocations[0] : null)?.description ?? "",
    ),
    shelf: shelfOf(p),
  };
}

/**
 * WHERE THE THING PHYSICALLY IS (David, 2026-08-24: "I was just at Pay Less
 * the other day and it would be nice if I could have navigated that better").
 *
 * Kroger returns a whole `aisleLocations` object per product and we were
 * keeping ONE string from it, `description`, and throwing the rest away.
 * `description` is a merchandising label ("NATURAL FOODS") -- useful for
 * sorting a list into store order, useless for walking to a shelf. The
 * navigable fields are the aisle NUMBER, which SIDE of it, and the bay.
 *
 * Every field is optional in Kroger's response and frequently absent
 * (independent banners like Pay Less populate less of it than Mariano's), so
 * this returns only what the store actually said and an empty object when it
 * said nothing. A caller must always be able to fall back to the description.
 *
 * @param {any} p a Kroger product payload
 * @returns {{ number?: string, side?: string, bay?: string, shelf?: string, description?: string }}
 */
function shelfOf(p) {
  const a = (Array.isArray(p?.aisleLocations) ? p.aisleLocations[0] : null) ?? null;
  if (!a) return {};
  /** @type {Record<string, string>} */
  const out = {};
  const put = (/** @type {string} */ k, /** @type {any} */ v) => {
    const s = String(v ?? "").trim();
    if (s) out[k] = s;
  };
  put("number", a.number);
  put("side", a.side);
  put("bay", a.bayNumber);
  put("shelf", a.shelfNumber);
  put("description", a.description);
  return out;
}

/**
 * Route a /kroger/* request. The caller has already authorized the PAT,
 * rate-limited, and parsed the JSON body.
 * @param {string} pathname
 * @param {any} body
 * @param {any} env
 * @param {(status: number, body: Record<string, any>) => Response} respond
 * @returns {Promise<Response | null>} null = not a kroger path
 */
export async function handleKroger(pathname, body, env, respond) {
  if (!pathname.startsWith("/kroger/")) return null;
  if (!krogerConfigured(env)) {
    return respond(503, { error: "Kroger API not configured yet" });
  }
  try {
    if (pathname === "/kroger/locations") {
      const term = String(body.term ?? "").trim();
      if (!/^\d{5}$/.test(term)) return respond(400, { error: "a 5-digit zip is required" });
      const rows = await krogerGet(
        "/locations",
        { "filter.zipCode.near": term, "filter.limit": "10" },
        env,
      );
      return respond(200, {
        locations: rows.map((l) => ({
          locationId: String(l?.locationId ?? ""),
          name: String(l?.name ?? ""),
          chain: String(l?.chain ?? ""),
          address: [l?.address?.addressLine1, l?.address?.city, l?.address?.state]
            .filter(Boolean)
            .join(", "),
        })),
      });
    }
    if (pathname === "/kroger/search") {
      const term = String(body.term ?? "")
        .trim()
        .slice(0, 60);
      const locationId = String(body.locationId ?? "").trim();
      if (!term || !locationId) return respond(400, { error: "term + locationId required" });
      const limit = Math.min(Math.max(Number(body.limit) || 30, 1), 50);
      const rows = await krogerGet(
        "/products",
        { "filter.term": term, "filter.locationId": locationId, "filter.limit": String(limit) },
        env,
      );
      return respond(200, { products: rows.map(trimProduct) });
    }
    if (pathname === "/kroger/byId") {
      const locationId = String(body.locationId ?? "").trim();
      const upcs = (Array.isArray(body.upcs) ? body.upcs : [])
        .map((/** @type {any} */ u) => String(u ?? "").trim())
        .filter((/** @type {string} */ u) => /^\d{6,14}$/.test(u))
        .slice(0, 60);
      if (!locationId || upcs.length === 0) {
        return respond(400, { error: "upcs + locationId required" });
      }
      // one Products call per UPC (the API filters one productId at a time);
      // sequential keeps a 50-row refresh far inside the 10k/day quota while
      // never bursting the upstream
      const products = [];
      const failed = [];
      for (const upc of upcs) {
        try {
          const rows = await krogerGet(
            "/products",
            { "filter.productId": upc, "filter.locationId": locationId, "filter.limit": "1" },
            env,
          );
          if (rows.length > 0) products.push(trimProduct(rows[0]));
          else failed.push(upc);
        } catch {
          failed.push(upc);
        }
      }
      // `requested` echoes how many UPCs were actually processed AFTER the
      // 60-cap, so a client that sent more can SEE the truncation instead of
      // silently treating dropped pins as priced (89 sent, 29 vanished)
      return respond(200, { requested: upcs.length, products, failed });
    }
    // ---- cart push: three POST routes, all gated on the cart config ------
    if (pathname.startsWith("/kroger/cart")) {
      if (!krogerCartConfigured(env)) {
        // NO FEATURE SHIPS DARK: absent config is a stated, actionable state,
        // never a silent no-op. The app hides the button on this response.
        return respond(503, {
          error: "cart push not set up yet",
          needs: [
            "KROGER_REDIRECT_URI",
            "KROGER_STATE_SECRET",
            "cart.basic:write on the Kroger app",
          ],
        });
      }
      if (pathname === "/kroger/cart/link") {
        const returnTo = String(body.returnTo ?? "").trim();
        try {
          if (!ALLOWED_RETURN_ORIGINS.includes(new URL(returnTo).origin)) {
            return respond(400, { error: "returnTo must be a Mise origin" });
          }
        } catch {
          return respond(400, { error: "returnTo must be an absolute URL" });
        }
        return respond(200, await cartLinkStart(env, returnTo));
      }
      if (pathname === "/kroger/cart/refresh") {
        const refresh = String(body.refreshToken ?? "").trim();
        if (!refresh) return respond(400, { error: "refreshToken required" });
        const t = await refreshCustomerToken(env, refresh);
        return respond(200, {
          accessToken: t.access_token,
          refreshToken: t.refresh_token ?? refresh,
          expiresIn: t.expires_in,
        });
      }
      if (pathname === "/kroger/cart/add") {
        const customer = String(body.accessToken ?? "").trim();
        if (!customer) return respond(401, { error: "not linked to a Kroger account" });
        const items = normalizeCartItems(body.items);
        if (items.length === 0) return respond(400, { error: "no valid UPCs to send" });
        const r = await cartAdd(customer, items);
        if (r.status === 401) return respond(401, { error: "Kroger link expired — link again" });
        if (!r.ok) return respond(502, { error: `Kroger refused the cart (${r.status})` });
        // ADD-ONLY: no read-back exists, so `sent` is the honest word and the
        // count is what WE sent, never what Kroger confirms it holds.
        return respond(200, { sent: items.length });
      }
    }
    return respond(404, { error: "not found" });
  } catch (e) {
    return respond(502, { error: e instanceof Error ? e.message : "kroger upstream failed" });
  }
}

/**
 * The ONE GET route this Worker serves: Kroger's redirect after the customer
 * consents. It cannot carry `x-mise-auth` (it is a browser navigation), which
 * is exactly why the flow is started by an AUTHENTICATED POST that mints a
 * signed, time-limited state. This route trusts nothing but that signature.
 * @param {URL} url
 * @param {any} env
 * @returns {Promise<Response | null>} null = not this route
 */
export async function handleKrogerCallback(url, env) {
  if (url.pathname !== "/kroger/cart/callback") return null;
  if (!krogerCartConfigured(env)) return new Response("cart push not configured", { status: 503 });
  const returnTo = await verifyState(
    url.searchParams.get("state") ?? "",
    env,
    ALLOWED_RETURN_ORIGINS,
  );
  // a bad or stale signature is the whole defence against an open redirect,
  // so it fails flat here rather than bouncing the browser anywhere
  if (!returnTo) return new Response("bad or expired state", { status: 400 });
  const err = url.searchParams.get("error");
  if (err) return Response.redirect(`${returnTo}#kroger_error=${encodeURIComponent(err)}`, 302);
  const code = url.searchParams.get("code") ?? "";
  if (!code) return new Response("missing code", { status: 400 });
  try {
    const t = await exchangeCode(env, code);
    // tokens ride back in the FRAGMENT, which browsers never send to a server
    const frag = new URLSearchParams({
      kroger_access: t.access_token ?? "",
      kroger_refresh: t.refresh_token ?? "",
      kroger_expires: String(t.expires_in ?? ""),
    });
    return Response.redirect(`${returnTo}#${frag}`, 302);
  } catch {
    return Response.redirect(`${returnTo}#kroger_error=exchange_failed`, 302);
  }
}

// ---------------------------------------------------------------------------
// CART PUSH (David, 2026-08-22: "as long as you put it in the cart, I will
// place the order").
//
// What is and is not possible, established 2026-08-22 by probing the gateway
// directly rather than reading docs (developer.kroger.com is a client-rendered
// SPA that returns the same shell for every path):
//   PUT /v1/cart/add   -> 401 (route registered)
//   PUT /v1/cart/zzz   -> 404 (control)
// So cart-add is live and reachable on the public tier. Order placement and
// pickup-slot booking do NOT exist at any tier. Checkout happens in Kroger's
// own app. This is a HAND-OFF, and calling it "in-store pickup integration"
// would be a promise the API cannot keep.
//
// Two hard limits the caller must design around:
//  1. ADD-ONLY. No read-back, no remove, no clear on the public tier. "Did it
//     work" is an HTTP status and nothing else, so we never claim more.
//  2. NO locationId IN THE PAYLOAD. Items land in whatever store the customer
//     account currently has selected. With Mariano's as the home store a Pay
//     Less basket lands in the Mariano's cart, so the UI must say which store
//     the account is set to and make the user confirm it.
//
// Auth is the other half. Products uses client_credentials; cart needs
// `cart.basic:write` via authorization_code, i.e. a real Kroger customer
// login. The Worker holds the client secret and never gives it out; the
// customer's own tokens live in their browser and are presented per request.
// The Worker is a proxy here, not a token store, which is why no KV binding
// is needed and why revoking is just clearing localStorage.

const AUTHORIZE_URL = "https://api.kroger.com/v1/connect/oauth2/authorize";
export const CART_SCOPE = "cart.basic:write";
/** an authorize hand-off is only good for a few minutes */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * @param {{ KROGER_CLIENT_ID?: string, KROGER_CLIENT_SECRET?: string, KROGER_REDIRECT_URI?: string, KROGER_STATE_SECRET?: string }} env
 */
export function krogerCartConfigured(env) {
  return Boolean(krogerConfigured(env) && env.KROGER_REDIRECT_URI && env.KROGER_STATE_SECRET);
}

/**
 * HMAC a state string so the callback can prove IT started the flow. Without
 * this the callback is an open door: anyone could hand Kroger our client_id
 * and a redirect back into the app.
 * @param {string} payload
 * @param {string} secret
 */
async function signState(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the Kroger consent URL plus a signed, time-limited state.
 * @param {any} env
 * @param {string} returnTo where to send the browser after consent
 */
export async function cartLinkStart(env, returnTo) {
  const issued = Date.now();
  const nonce = crypto.randomUUID();
  const payload = `${issued}.${nonce}.${returnTo}`;
  const sig = await signState(payload, env.KROGER_STATE_SECRET);
  const state = `${payload}.${sig}`;
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", env.KROGER_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.KROGER_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", CART_SCOPE);
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

/**
 * Verify a state that came back from Kroger. Returns the return-to URL, or
 * null when the signature is wrong, the state is stale, or it is malformed.
 * @param {string} state
 * @param {any} env
 * @param {string[]} allowedOrigins
 */
export async function verifyState(state, env, allowedOrigins) {
  const parts = String(state ?? "").split(".");
  if (parts.length < 4) return null;
  const sig = /** @type {string} */ (parts.pop());
  const payload = parts.join(".");
  const expected = await signState(payload, env.KROGER_STATE_SECRET);
  // constant-time-ish: compare full strings of equal length
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  const [issuedRaw, , ...rest] = payload.split(".");
  const issued = Number(issuedRaw);
  if (!Number.isFinite(issued) || Date.now() - issued > STATE_TTL_MS) return null;
  const returnTo = rest.join(".");
  // never redirect anywhere but back into one of our own origins
  try {
    const o = new URL(returnTo).origin;
    if (!allowedOrigins.includes(o)) return null;
  } catch {
    return null;
  }
  return returnTo;
}

/**
 * Exchange an authorization code (or refresh a token) for customer tokens.
 * @param {any} env
 * @param {Record<string, string>} form
 */
async function customerToken(env, form) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`),
    },
    body: new URLSearchParams(form),
  });
  if (!res.ok) throw new Error(`kroger customer token ${res.status}`);
  return /** @type {any} */ (await res.json());
}

/** @param {any} env @param {string} code */
export function exchangeCode(env, code) {
  return customerToken(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.KROGER_REDIRECT_URI,
  });
}

/** @param {any} env @param {string} refresh */
export function refreshCustomerToken(env, refresh) {
  return customerToken(env, { grant_type: "refresh_token", refresh_token: refresh });
}

/**
 * Normalize a cart payload. Kroger takes `{ items: [{ upc, quantity,
 * modality }] }`; anything else is a 400 we would rather raise here than
 * discover as an opaque upstream failure.
 * @param {any} raw
 * @returns {{ upc: string, quantity: number, modality: string }[]}
 */
export function normalizeCartItems(raw) {
  const out = [];
  for (const it of Array.isArray(raw) ? raw : []) {
    const upc = String(it?.upc ?? "").trim();
    // Kroger UPCs are 13-digit zero-padded strings; a bare number that lost
    // its leading zeros is the classic way this fails silently
    if (!/^\d{8,14}$/.test(upc)) continue;
    const quantity = Math.max(1, Math.min(99, Math.round(Number(it?.quantity) || 1)));
    const modality = it?.modality === "DELIVERY" ? "DELIVERY" : "PICKUP";
    out.push({ upc, quantity, modality });
  }
  return out.slice(0, 100);
}

/**
 * PUT the items into the signed-in customer's Kroger cart.
 * Returns nothing useful on success because the API returns nothing useful:
 * 204 and no body. That is why the caller must never claim more than "sent".
 * @param {string} customerAccessToken
 * @param {{ upc: string, quantity: number, modality: string }[]} items
 */
export async function cartAdd(customerAccessToken, items) {
  const res = await fetch(`${API}/cart/add`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${customerAccessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ items }),
  });
  return { ok: res.ok, status: res.status };
}
