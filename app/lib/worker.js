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
  try {
    res = await fetch(WORKER_URL + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mise-auth": token },
      body: JSON.stringify(body),
    });
  } catch {
    // fetch network failures are technical strings ("Failed to fetch") —
    // never show those to David
    throw new Error("no connection — try again when you have signal");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `worker error ${res.status}`);
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
 * Free-text symptoms → protocol in the rules-engine shape.
 * @param {string} text
 * @returns {Promise<{ teas: string[], foods: string[], avoid: string[], notes: string[] }>}
 */
export async function liveRemedy(text) {
  const data = await post("/remedy", { text });
  return data.protocol;
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
