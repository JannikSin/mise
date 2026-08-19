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
    aisle: String((Array.isArray(p?.aisleLocations) ? p.aisleLocations[0] : null)?.description ?? ""),
  };
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
      const term = String(body.term ?? "").trim().slice(0, 60);
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
      return respond(200, { products, failed });
    }
    return respond(404, { error: "not found" });
  } catch (e) {
    return respond(502, { error: e instanceof Error ? e.message : "kroger upstream failed" });
  }
}
