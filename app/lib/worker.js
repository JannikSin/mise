// Client for the Mise Worker (camera-pantry scan + live remedies).
// Auth: the same fine-grained PAT the app already stores — the Worker
// verifies it against the private data repo, so there is no second secret.
// If WORKER_URL's origin changes, the CSP connect-src in index.html must
// change with it.

import { getToken } from "./github.js";

export const WORKER_URL = "https://mise-worker.janniksin.workers.dev";

const MAX_EDGE = 1280;

/**
 * Downscale a camera photo to a small JPEG the Worker will accept —
 * iPhone originals are 3-4MB; ~1280px at 0.8 is plenty for itemizing.
 * @param {File | Blob} file
 * @returns {Promise<{ image: string, mediaType: string }>} base64 + type
 */
export async function downscalePhoto(file) {
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
 * Free-text symptoms → protocol in the rules-engine shape.
 * @param {string} text
 * @returns {Promise<{ teas: string[], foods: string[], avoid: string[], notes: string[] }>}
 */
export async function liveRemedy(text) {
  const data = await post("/remedy", { text });
  return data.protocol;
}
