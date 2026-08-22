// Client for the Mise Worker (camera-pantry scan + live remedies).
// Auth: the same fine-grained PAT the app already stores — the Worker
// verifies it against the private data repo, so there is no second secret.
// If WORKER_URL's origin changes, the CSP connect-src in index.html must
// change with it.

import { getToken } from "./github.js";

const WORKER_URL = "https://mise-worker.janniksin.workers.dev";

const MAX_EDGE = 1280;

/**
 * Downscale a camera photo to a small JPEG the Worker will accept —
 * iPhone originals are 3-4MB; ~1280px at 0.8 is plenty for itemizing.
 * @param {File | Blob} file
 * @returns {Promise<{ image: string, mediaType: string }>} base64 + type
 */
async function downscalePhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  if (!blob) throw new Error("could not encode photo");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { image: btoa(bin), mediaType: "image/jpeg" };
}

/**
 * @param {string} path
 * @param {Record<string, any>} body
 */
async function post(path, body) {
  const token = getToken();
  if (!token) throw new Error("connect token in SYS first");
  if (!navigator.onLine) throw new Error("no signal — the offline tools above still work");
  let res;
  const startedAt = Date.now();
  try {
    res = await fetch(WORKER_URL + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mise-auth": token },
      body: JSON.stringify(body),
      // explicit ceiling: iOS Safari gives up around 60s of silence and
      // surfaces it as a network error, which used to render as the LYING
      // "no signal" message on a long two-model-call scan. Cap it ourselves
      // and say what actually happened.
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    // some engines surface an abort as TypeError/Error rather than a
    // DOMException; match on the name, not the class
    const name = err instanceof Error || err instanceof DOMException ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error("that took too long and timed out. Try again in a minute.", { cause: err });
    }
    // iOS Safari gives up on a long-silent request around 60s and surfaces
    // it as a plain network error. If we had been going a while, that is a
    // drop, not a missing signal; saying "no signal" there is a lie.
    if (Date.now() - startedAt > 20000) {
      throw new Error(
        "the connection dropped mid-request (locking the phone or switching apps can do this). Try again.",
        { cause: err },
      );
    }
    // fetch network failures are technical strings ("Failed to fetch") —
    // never show those to David
    throw new Error("no connection — try again when you have signal", { cause: err });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // validator rejects (422) carry the specific reasons in `details`;
    // append them so the view can show WHY instead of a generic sentence
    const details = Array.isArray(data.details) ? ` (${data.details.join("; ")})` : "";
    throw new Error((data.error ?? `worker error ${res.status}`) + details);
  }
  return data;
}

/**
 * Photo → sanitized item candidates for review.
 * @param {File | Blob} file
 * @returns {Promise<{ name: string, kind: string, qty: string }[]>}
 */
export async function scanPhoto(file) {
  const { image, mediaType } = await downscalePhoto(file);
  const data = await post("/scan", { image, mediaType });
  return Array.isArray(data.items) ? data.items : [];
}

/**
 * Grocery-receipt photo(s) → the store and its priced food lines, for the
 * price-catalogue freshness loop. Same downscale + auth path as the pantry
 * scan; returns empty when the model finds nothing.
 *
 * Takes one file or SEVERAL overlapping photos of one long receipt (David,
 * 2026-08-10: a Costco receipt does not fit in a frame). All of them go in
 * ONE request on purpose: the model reads the strip as a single continuous
 * receipt and so can tell that the bottom of photo 2 is the top of photo 3.
 * Scanning shot-by-shot and de-duplicating afterwards is the obvious design
 * and it is wrong — a receipt really can print the same item at the same
 * price twice, and any drop-the-repeat rule loses that line silently.
 * @param {File | Blob | (File | Blob)[]} files one photo, or several in order
 *   from the top of the receipt to the bottom
 * @returns {Promise<{ store: string, items: { name: string, price: number, size: string }[] }>}
 */
export async function scanReceipt(files) {
  const list = Array.isArray(files) ? files : [files];
  if (list.length === 0) throw new Error("no photo to read");
  const images = [];
  for (const f of list) images.push(await downscalePhoto(f));
  const data = await post("/receipt", { images });
  return {
    store: typeof data.store === "string" ? data.store : "",
    items: Array.isArray(data.items) ? data.items : [],
  };
}

/**
 * One turn of the chat onboarder. Sends the running message history plus the
 * partial gate survey; gets back either the assistant's next question
 * (`reply`) or a finished raw profile (`profile`, ready for
 * targetsFromQuestionnaire). Gated on the Worker AI key like the scans.
 * @param {{ role: string, content: string }[]} messages
 * @param {Record<string, any>} survey
 * @returns {Promise<{ reply: string, profile: Record<string, any> | null }>}
 */
export async function onboardTurn(messages, survey) {
  const data = await post("/onboard", { messages, survey });
  return {
    reply: typeof data.reply === "string" ? data.reply : "",
    profile: data.profile && typeof data.profile === "object" ? data.profile : null,
  };
}

/**
 * Restaurant-menu photo + the diners at the table → per-diner order report.
 * Same downscale + auth path as the pantry scan; nothing is persisted.
 * @param {File | Blob} file
 * @param {{ id: string, name: string, goal: string, calories: number, protein: number, diet: string, avoid: string[] }[]} diners
 * @returns {Promise<{ diners: { name: string, picks: { item: string, why: string, estCalories: number, estProtein: number }[], skip: string[] }[], notes: string[] }>}
 */
export async function scanMenu(file, diners) {
  const { image, mediaType } = await downscalePhoto(file);
  const data = await post("/menu", { image, mediaType, diners });
  return {
    diners: Array.isArray(data.diners) ? data.diners : [],
    notes: Array.isArray(data.notes) ? data.notes : [],
  };
}

/**
 * One shared table dish → per-seat plate specs (scale-first: weighed base
 * portion + measured adjustments) + sequenced cook notes. The caller
 * persists the result onto the table (setTableTailor).
 * @param {{ name: string, servings: number, calories: number, protein: number, carbs: number, fat: number, ingredients: string[] }} recipe
 * @param {{ id: string, name: string, goal: string, calories: number, protein: number, diet: string, avoid: string[] }[]} seats
 * @returns {Promise<{ seats: Record<string, { portionGrams?: number, plate: string[], estCalories: number, estProtein: number }>, cook: string[] }>}
 */
export async function tailorTable(recipe, seats) {
  const data = await post("/tailor", { recipe, seats });
  return {
    seats: data.seats && typeof data.seats === "object" ? data.seats : {},
    cook: Array.isArray(data.cook) ? data.cook : [],
  };
}

/**
 * One call → a settled, people-tailored SHARED meal for every requested
 * date+slot (the house cooks each slot once; goals survive via per-person
 * portioning). Each meal is a full decision (bank pick or special,
 * per-person plate specs with weighed amounts, why); `notes` reports meals
 * the screen refused or the model skipped, so silence never reads as
 * covered.
 * @param {{ id: string, name: string, goal: string, calories: number, protein: number, diet: string, avoid: string[], say?: string }[]} people
 * @param {{ id: string, name: string, calories: number, protein: number, cuisine: string, meal?: string }[]} candidates
 * @param {{ date: string, slot: string }[]} meals date+slot pairs to plan
 * @param {string} cuisine cuisine/theme preference, "" = none
 * @param {string} note free-text household note, "" = none
 * @param {Record<string, string[]>} [away] personId → dates they are NOT at
 *   the table (no plate planned for them those days)
 * @returns {Promise<{ nights: Record<string, any>[], notes: string[] }>}
 */
export async function dinnerWeek(people, candidates, meals, cuisine, note, away = {}) {
  const data = await post("/dinnerweek", { people, candidates, meals, cuisine, note, away });
  return {
    nights: Array.isArray(data.nights) ? data.nights : [],
    notes: Array.isArray(data.notes) ? data.notes : [],
  };
}

/**
 * One turn of the household dinner discussion. Gets back either the
 * mediator's next question (`reply`) or a settled `decision` (a bank pick or
 * a fully specified special meal, plus per-person plate notes).
 * @param {{ role: string, content: string }[]} messages
 * @param {{ id: string, name: string, goal: string, calories: number, protein: number, diet: string, avoid: string[], say: string }[]} people
 * @param {{ id: string, name: string, calories: number, protein: number, cuisine: string }[]} candidates
 * @returns {Promise<{ reply: string, decision: Record<string, any> | null }>}
 */
export async function dinnerTurn(messages, people, candidates) {
  const data = await post("/dinner", { messages, people, candidates });
  return {
    reply: typeof data.reply === "string" ? data.reply : "",
    decision: data.decision && typeof data.decision === "object" ? data.decision : null,
  };
}

/**
 * Test the notification pipeline: sends one live ntfy ping and returns the
 * whole day's would-fire schedule plus whether the cron is fully configured.
 * @returns {Promise<{ pinged: boolean, topicSet: boolean, cronReady: boolean, preview: { title: string, body: string }[] }>}
 */
export async function notifyTest() {
  const data = await post("/notify-test", {});
  return {
    pinged: Boolean(data.pinged),
    topicSet: Boolean(data.topicSet),
    cronReady: Boolean(data.cronReady),
    preview: Array.isArray(data.preview) ? data.preview : [],
  };
}

/**
 * HBP Recipe Scan: URL or photo in, an annotated recipe (or a hard stop /
 * refusal / verdict) out. Nothing is persisted by the scan itself (A3): the
 * transcription travels back with the result and is embedded only on save.
 * @param {{ url?: string, file?: File | Blob, objective: string, diners: Record<string, any>[], context: { plan: string[], pantry: string[], macros: string } }} args
 * @returns {Promise<Record<string, any>>} { result, transcription, extracted, path, refusalTokens, saveEligible } or { hardStop, path }
 */
export async function annotateRecipe({ url, file, objective, diners, context }) {
  /** @type {Record<string, any>} */
  const body = { objective, diners, context };
  if (file) {
    const { image, mediaType } = await downscalePhoto(file);
    body.image = image;
    body.mediaType = mediaType;
  } else {
    body.url = url;
  }
  return post("/annotate", body);
}

/**
 * Save a scan to the cookbook: server-side revalidate-then-write (D3). The
 * Worker re-runs the fail-closed validator, maps to the canonical recipe
 * shape, and writes recipes/hbp-<slug>-<date>.json with the presented PAT.
 * @param {{ result: Record<string, any>, transcription: string, extracted: string, path: string, sourceUrl: string, pantryStaples: string[] }} payload
 * @returns {Promise<{ recipe: Record<string, any> }>}
 */
export async function saveAnnotation(payload) {
  const data = await post("/annotate-save", payload);
  if (!data.recipe || typeof data.recipe !== "object") throw new Error("save came back empty");
  return { recipe: data.recipe };
}

/**
 * Free-text symptoms → protocol in the rules-engine shape.
 * @param {string} text
 * @returns {Promise<{ teas: string[], foods: string[], avoid: string[], notes: string[] }>}
 */
export async function liveRemedy(text) {
  const data = await post("/remedy", { text });
  return data.protocol;
}

/**
 * Live Kroger product search at one store (the PICK half of the confirm-once
 * pin flow, fix list 3.2). Quota discipline: called once per unresolved
 * ingredient ever, never in a loop.
 * @param {string} term
 * @param {string} locationId
 * @returns {Promise<import("./kroger.js").KrogerProduct[]>}
 */
export async function krogerSearch(term, locationId) {
  const data = await post("/kroger/search", { term, locationId, limit: 30 });
  return Array.isArray(data.products) ? data.products : [];
}

/**
 * Current prices for pinned UPCs at one store (the weekly refresh, fix list
 * 3.5). `failed` lists UPCs the API no longer returns — those pins render
 * stale rather than silently keeping an old price.
 * @param {string[]} upcs
 * @param {string} locationId
 * @returns {Promise<{ products: import("./kroger.js").KrogerProduct[], failed: string[] }>}
 */
export async function krogerPricesById(upcs, locationId) {
  const data = await post("/kroger/byId", { upcs, locationId });
  return {
    products: Array.isArray(data.products) ? data.products : [],
    failed: Array.isArray(data.failed) ? data.failed : [],
  };
}

/**
 * One general-question turn against the /ask endpoint: freeform answer
 * grounded in the compact context snapshot the caller composes.
 * @param {{ role: string, content: string }[]} messages
 * @param {Record<string, any>} context
 * @returns {Promise<{ reply: string }>}
 */
export async function askTurn(messages, context) {
  const data = await post("/ask", { messages, context });
  return { reply: typeof data.reply === "string" ? data.reply : "" };
}

// ---------------------------------------------------------------------------
// KROGER CART PUSH. Mise builds the list; Kroger's own app does checkout.
// There is no order-placement and no pickup-slot endpoint in the public API
// at any tier, so this is a hand-off and never claims otherwise.
//
// The customer's Kroger tokens live HERE, in this browser, not on the Worker.
// The Worker holds the client secret and proxies; unlinking is just clearing
// these keys, which is why there is no server-side token store to revoke.
// ---------------------------------------------------------------------------

const KROGER_ACCESS = "mise.kroger.access";
const KROGER_REFRESH = "mise.kroger.refresh";
const KROGER_EXPIRES = "mise.kroger.expires";

/** @returns {boolean} true when this browser holds a Kroger customer link */
export function krogerLinked() {
  try {
    return Boolean(localStorage.getItem(KROGER_REFRESH));
  } catch {
    return false;
  }
}

/** Forget the Kroger link. The only revoke this feature needs. */
export function krogerUnlink() {
  try {
    for (const k of [KROGER_ACCESS, KROGER_REFRESH, KROGER_EXPIRES]) localStorage.removeItem(k);
  } catch {
    // a browser that refuses storage was never linked
  }
}

/**
 * Consume the tokens Kroger's callback put in the URL fragment, if any.
 * The fragment is used deliberately: browsers never send it to a server.
 * Clears the hash so a reload cannot replay it.
 * @returns {"linked" | "error" | null}
 */
export function krogerConsumeRedirect() {
  let hash;
  try {
    hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  } catch {
    return null;
  }
  if (!hash) return null;
  const p = new URLSearchParams(hash);
  const clear = () => {
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      // a browser that refuses replaceState just keeps a stale hash
    }
  };
  if (p.get("kroger_error")) {
    clear();
    return "error";
  }
  const access = p.get("kroger_access");
  const refresh = p.get("kroger_refresh");
  if (!access || !refresh) return null;
  try {
    localStorage.setItem(KROGER_ACCESS, access);
    localStorage.setItem(KROGER_REFRESH, refresh);
    localStorage.setItem(
      KROGER_EXPIRES,
      String(Date.now() + (Number(p.get("kroger_expires")) || 1800) * 1000),
    );
  } catch {
    return "error";
  }
  clear();
  return "linked";
}

/**
 * Start the Kroger consent hand-off. Returns the URL to navigate to.
 * @returns {Promise<string>}
 */
export async function krogerCartLink() {
  const { url } = await post("/kroger/cart/link", { returnTo: location.href.split("#")[0] });
  return url;
}

/** A live customer access token, refreshed if it is close to expiry. */
async function krogerAccessToken() {
  const access = localStorage.getItem(KROGER_ACCESS);
  const refresh = localStorage.getItem(KROGER_REFRESH);
  const expires = Number(localStorage.getItem(KROGER_EXPIRES)) || 0;
  if (!refresh) throw new Error("not linked to a Kroger account yet");
  // refresh a minute early rather than discovering expiry as a 401 mid-push
  if (access && expires > Date.now() + 60000) return access;
  const t = await post("/kroger/cart/refresh", { refreshToken: refresh });
  localStorage.setItem(KROGER_ACCESS, t.accessToken);
  localStorage.setItem(KROGER_REFRESH, t.refreshToken);
  localStorage.setItem(KROGER_EXPIRES, String(Date.now() + (Number(t.expiresIn) || 1800) * 1000));
  return t.accessToken;
}

/**
 * Send items to the signed-in customer's Kroger cart.
 * Resolves with how many rows WE SENT. The public API is add-only with no
 * read-back, so this can never report what Kroger actually holds, and the
 * caller must not phrase it as though it can.
 * @param {{ upc: string, quantity: number }[]} items
 * @returns {Promise<number>}
 */
export async function krogerCartAdd(items) {
  const accessToken = await krogerAccessToken();
  const { sent } = await post("/kroger/cart/add", { accessToken, items });
  return Number(sent) || 0;
}
