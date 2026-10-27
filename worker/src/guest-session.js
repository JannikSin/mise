// Mise 2.0 (plan section 4.2, "GUEST_SESSION_KEY signs guest sessions, typed
// typ:"guest""): the guest session on a branch switched to Supabase.
//
// 1.95 derived the session key from MISE_INVITE_TOKEN, the GitHub write PAT.
// On Supabase there is no such PAT, so the key is its own Worker secret,
// GUEST_SESSION_KEY (from `openssl rand -base64 32`, David's step 9). The
// payload carries typ:"guest", and the verifier refuses anything else, so a
// guest session can never be replayed as some other kind of signed blob. A
// 1.95 session does not verify here (different key and label): the switch
// costs a guest one log in, which is the intended clean break.

import { GUEST_SESSION_TTL_MS } from "./lib.js";

/** @param {Uint8Array} bytes */
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} s */
function fromB64url(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

/**
 * The secret, or "" when it is missing or obviously too short to be real.
 * @param {any} env
 */
export function guestSessionSecret(env) {
  const k = String(env?.GUEST_SESSION_KEY ?? "");
  return k.length >= 16 ? k : "";
}

/** @param {string} secret */
async function hmacKey(secret) {
  const raw = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`mise-guest-session-v2:${secret}`),
  );
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/**
 * @param {{ p: string, b: string }} who guest profile slug and data branch
 * @param {string} secret GUEST_SESSION_KEY
 * @param {number} nowMs
 */
export async function signGuestSessionV2(who, secret, nowMs) {
  const body = b64url(
    new TextEncoder().encode(
      JSON.stringify({
        typ: "guest",
        p: String(who.p),
        b: String(who.b),
        exp: nowMs + GUEST_SESSION_TTL_MS,
      }),
    ),
  );
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

/**
 * @param {unknown} token
 * @param {string} secret
 * @param {string} branch
 * @param {number} nowMs
 * @returns {Promise<{ p: string, b: string, exp: number } | null>}
 */
export async function verifyGuestSessionV2(token, secret, branch, nowMs) {
  if (!secret || typeof token !== "string" || token.length > 1024) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      fromB64url(sig),
      new TextEncoder().encode(body),
    );
    if (!ok) return null;
    const s = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    if (s?.typ !== "guest" || typeof s.p !== "string" || s.b !== branch) return null;
    if (!(Number(s.exp) > nowMs)) return null;
    return { p: s.p, b: s.b, exp: Number(s.exp) };
  } catch {
    return null;
  }
}
