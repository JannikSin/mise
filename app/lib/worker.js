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
 * Grocery-receipt photo → the store and its priced food lines, for the
 * price-catalogue freshness loop. Same downscale + auth path as the pantry
 * scan; returns empty when the model finds nothing.
 * @param {File | Blob} file
 * @returns {Promise<{ store: string, items: { name: string, price: number, size: string }[] }>}
 */
export async function scanReceipt(file) {
  const { image, mediaType } = await downscalePhoto(file);
  const data = await post("/receipt", { image, mediaType });
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
 * One shared table dish → per-seat plate adjustments + cook notes. The
 * caller persists the result onto the table (setTableTailor).
 * @param {{ name: string, servings: number, calories: number, protein: number, carbs: number, fat: number, ingredients: string[] }} recipe
 * @param {{ id: string, name: string, goal: string, calories: number, protein: number, diet: string, avoid: string[] }[]} seats
 * @returns {Promise<{ seats: Record<string, { plate: string[], estCalories: number, estProtein: number }>, cook: string[] }>}
 */
export async function tailorTable(recipe, seats) {
  const data = await post("/tailor", { recipe, seats });
  return {
    seats: data.seats && typeof data.seats === "object" ? data.seats : {},
    cook: Array.isArray(data.cook) ? data.cook : [],
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
 * Free-text symptoms → protocol in the rules-engine shape.
 * @param {string} text
 * @returns {Promise<{ teas: string[], foods: string[], avoid: string[], notes: string[] }>}
 */
export async function liveRemedy(text) {
  const data = await post("/remedy", { text });
  return data.protocol;
}
