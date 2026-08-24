// PURDUE DINING PROXY (P10).
//
// This exists for exactly one reason, and it is worth writing down because I
// argued against it an hour before writing it: **Purdue's API sends no
// Access-Control-Allow-Origin header.** It is public and keyless, so curl and
// node reach it happily, and a browser will not. The app's CSP already allowed
// api.hfs.purdue.edu and that was never the blocker; CORS was. The first click
// on a real device said "Failed to fetch" and that is what found it.
//
// So the Worker proxies. Two routes, both dumb pass-throughs that add nothing
// but a CORS header, because the parsing lives in `app/lib/dininghall.js`
// where it is pure and tested and must not be duplicated here.
//
//   POST /hall/day    { court, date }  -> the published day menu
//   POST /hall/items  { ids: [...] }   -> nutrition for many dishes AT ONCE
//
// The batch on /hall/items is the other reason this is a win rather than a
// tax: the item endpoint is the only place nutrition lives, so a dinner menu
// is ~40 separate lookups. Doing them from a phone on dorm wifi is forty round
// trips; doing them here is one.

const API = "https://api.hfs.purdue.edu/menus/v2";

/** Courts we will proxy for. An allowlist, so this cannot become an open relay. */
const COURTS = new Set(["Earhart", "Ford", "Hillenbrand", "Wiley", "Windsor"]);

/** How many dish lookups one request may trigger. */
const MAX_ITEMS = 60;

/**
 * @param {string} pathname
 * @param {any} body
 * @param {(status: number, body: Record<string, any>) => Response} respond
 * @returns {Promise<Response | null>} null = not a hall path
 */
export async function handleHall(pathname, body, respond) {
  if (!pathname.startsWith("/hall/")) return null;
  try {
    if (pathname === "/hall/day") {
      const court = String(body?.court ?? "").trim();
      const date = String(body?.date ?? "").trim();
      if (!COURTS.has(court)) return respond(400, { error: "unknown dining court" });
      // the app speaks ISO; Purdue's path wants MM-DD-YYYY
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return respond(400, { error: "date must be ISO" });
      const [y, m, d] = date.split("-");
      const res = await fetch(`${API}/locations/${encodeURIComponent(court)}/${m}-${d}-${y}`);
      if (!res.ok) return respond(502, { error: `the hall menu did not load (${res.status})` });
      return respond(200, { day: await res.json() });
    }

    if (pathname === "/hall/items") {
      const ids = (Array.isArray(body?.ids) ? body.ids : [])
        .map((/** @type {any} */ i) => String(i ?? "").trim())
        // Purdue ids are uuids; anything else is not ours to fetch, and this
        // is what stops the route being a general-purpose relay
        .filter((/** @type {string} */ i) => /^[0-9a-f-]{16,64}$/i.test(i))
        .slice(0, MAX_ITEMS);
      if (ids.length === 0) return respond(400, { error: "no valid item ids" });
      // one round trip for the caller, concurrent upstream, and a dish that
      // fails is simply absent rather than failing the whole tray
      const items = (
        await Promise.all(
          ids.map(async (/** @type {string} */ id) => {
            try {
              const r = await fetch(`${API}/items/${encodeURIComponent(id)}`);
              return r.ok ? await r.json() : null;
            } catch {
              return null;
            }
          }),
        )
      ).filter(Boolean);
      return respond(200, { items });
    }

    return respond(404, { error: "not found" });
  } catch (e) {
    return respond(502, { error: e instanceof Error ? e.message : "purdue dining upstream failed" });
  }
}
