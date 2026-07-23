// Mise Worker — the app's only server-side component (blueprint Task 12).
// Anthropic-backed endpoints:
//   POST /scan    { image, mediaType }            -> { items: [{name, kind, qty}] }
//   POST /receipt { image, mediaType }            -> { store, items: [{name, price, size}] }
//   POST /menu    { image, mediaType, diners }    -> { diners: [{name, picks, skip}], notes }
//   POST /tailor  { recipe, seats }               -> { seats: {id: {plate, est*}}, cook }
//   POST /dinner  { messages, people, candidates } -> { reply, decision }
//   POST /onboard { messages, survey }            -> { reply, profile }
//   POST /remedy  { text }                        -> { protocol: {teas, foods, avoid, notes} }
// Auth: the caller proves they are David by presenting the SAME fine-grained
// PAT the app already holds — the Worker verifies it can see the private
// mise-data repo. No second secret to manage; revoking the PAT kills both.
// The Anthropic key exists ONLY as a Worker secret (never in the app).

import {
  corsFor,
  buildScanRequest,
  buildReceiptRequest,
  buildOnboardRequest,
  buildRemedyRequest,
  buildMenuRequest,
  buildTailorRequest,
  buildDinnerRequest,
  parseToolUse,
  parseOnboardResponse,
  parseDinnerResponse,
  validateScanItems,
  validateReceiptItems,
  validateProtocol,
  validateMenuReport,
  validateTailor,
  sanitizePeople,
  allowRequest,
} from "./lib.js";

const DATA_REPO = "JannikSin/mise-data";
const DEFAULT_MODEL = "claude-sonnet-5";
const AUTH_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 6 * 1024 * 1024; // ~4.5MB image after base64

/** token-hash -> expiry; per-isolate, so worst case is one extra GitHub call */
const authCache = new Map();
/** token-hash -> fixed-window request counter (see allowRequest) */
const rateState = new Map();

/** @param {string} token */
async function tokenKey(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The presented PAT must be able to see the PRIVATE data repo.
 * @param {string | null} token
 */
async function isAuthorized(token) {
  if (!token) return false;
  const key = await tokenKey(token);
  const cached = authCache.get(key);
  if (cached && cached > Date.now()) return true;
  const res = await fetch(`https://api.github.com/repos/${DATA_REPO}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "mise-worker",
    },
  });
  if (!res.ok) return false;
  const repo = await res.json();
  if (repo?.private !== true) return false;
  authCache.set(key, Date.now() + AUTH_TTL_MS);
  return true;
}

/**
 * @param {number} status
 * @param {Record<string, any>} body
 * @param {Record<string, string>} cors
 */
function json(status, body, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

/**
 * @param {Record<string, any>} body Anthropic Messages request
 * @param {string} apiKey
 */
async function callAnthropic(body, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`anthropic ${res.status}`);
  }
  return res.json();
}

export default {
  /**
   * @param {Request} request
   * @param {{ ANTHROPIC_API_KEY?: string, SCAN_MODEL?: string, REMEDY_MODEL?: string }} env
   */
  async fetch(request, env) {
    const cors = corsFor(request.headers.get("origin"));
    if (request.method === "OPTIONS") {
      return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
    }
    if (!cors) return json(403, { error: "origin not allowed" }, {});
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      !["/scan", "/receipt", "/onboard", "/remedy", "/menu", "/tailor", "/dinner"].includes(
        url.pathname,
      )
    ) {
      return json(404, { error: "not found" }, cors);
    }

    const token = request.headers.get("x-mise-auth");
    if (!(await isAuthorized(token))) {
      return json(401, { error: "unauthorized" }, cors);
    }
    if (!allowRequest(rateState, await tokenKey(/** @type {string} */ (token)), Date.now())) {
      return json(429, { error: "slow down — try again in a few minutes" }, cors);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json(503, { error: "ANTHROPIC_API_KEY not configured yet" }, cors);
    }

    // size-cap on the ACTUAL bytes read, not the client-claimed header
    let body;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) {
        return json(413, { error: "photo too large — retake or lower quality" }, cors);
      }
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "invalid JSON body" }, cors);
    }
    if (typeof body !== "object" || body === null) {
      return json(400, { error: "invalid JSON body" }, cors);
    }

    try {
      if (url.pathname === "/scan") {
        const image = typeof body.image === "string" ? body.image : "";
        const mediaType = ["image/jpeg", "image/png", "image/webp"].includes(body.mediaType)
          ? body.mediaType
          : "";
        if (!image || !mediaType) return json(400, { error: "image + mediaType required" }, cors);
        const resp = await callAnthropic(
          buildScanRequest({ image, mediaType, model: env.SCAN_MODEL ?? DEFAULT_MODEL }),
          env.ANTHROPIC_API_KEY,
        );
        return json(200, { items: validateScanItems(parseToolUse(resp, "record_items")) }, cors);
      }
      if (url.pathname === "/receipt") {
        const image = typeof body.image === "string" ? body.image : "";
        const mediaType = ["image/jpeg", "image/png", "image/webp"].includes(body.mediaType)
          ? body.mediaType
          : "";
        if (!image || !mediaType) return json(400, { error: "image + mediaType required" }, cors);
        const resp = await callAnthropic(
          buildReceiptRequest({ image, mediaType, model: env.SCAN_MODEL ?? DEFAULT_MODEL }),
          env.ANTHROPIC_API_KEY,
        );
        return json(200, validateReceiptItems(parseToolUse(resp, "record_receipt")), cors);
      }
      if (url.pathname === "/onboard") {
        const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
        const survey = typeof body.survey === "object" && body.survey ? body.survey : {};
        if (messages.length === 0) return json(400, { error: "messages required" }, cors);
        const resp = await callAnthropic(
          buildOnboardRequest({ messages, survey, model: env.SCAN_MODEL ?? DEFAULT_MODEL }),
          env.ANTHROPIC_API_KEY,
        );
        return json(200, parseOnboardResponse(resp), cors);
      }
      if (url.pathname === "/menu") {
        const image = typeof body.image === "string" ? body.image : "";
        const mediaType = ["image/jpeg", "image/png", "image/webp"].includes(body.mediaType)
          ? body.mediaType
          : "";
        const diners = sanitizePeople(body.diners);
        if (!image || !mediaType) return json(400, { error: "image + mediaType required" }, cors);
        if (diners.length === 0) return json(400, { error: "diners required" }, cors);
        const resp = await callAnthropic(
          buildMenuRequest({ image, mediaType, diners, model: env.SCAN_MODEL ?? DEFAULT_MODEL }),
          env.ANTHROPIC_API_KEY,
        );
        return json(200, validateMenuReport(parseToolUse(resp, "record_menu")), cors);
      }
      if (url.pathname === "/tailor") {
        const r = typeof body.recipe === "object" && body.recipe !== null ? body.recipe : {};
        const recipe = {
          name: typeof r.name === "string" ? r.name.trim().slice(0, 80) : "",
          servings: typeof r.servings === "number" && isFinite(r.servings) ? r.servings : 1,
          calories: typeof r.calories === "number" && isFinite(r.calories) ? r.calories : 0,
          protein: typeof r.protein === "number" && isFinite(r.protein) ? r.protein : 0,
          carbs: typeof r.carbs === "number" && isFinite(r.carbs) ? r.carbs : 0,
          fat: typeof r.fat === "number" && isFinite(r.fat) ? r.fat : 0,
          ingredients: (Array.isArray(r.ingredients) ? r.ingredients : [])
            .filter((/** @type {any} */ s) => typeof s === "string" && s.trim())
            .map((/** @type {string} */ s) => s.trim().slice(0, 60))
            .slice(0, 30),
        };
        const seats = sanitizePeople(body.seats).filter((s) => s.id);
        if (!recipe.name) return json(400, { error: "recipe required" }, cors);
        if (seats.length === 0) return json(400, { error: "seats required" }, cors);
        const resp = await callAnthropic(
          buildTailorRequest({ recipe, seats, model: env.SCAN_MODEL ?? DEFAULT_MODEL }),
          env.ANTHROPIC_API_KEY,
        );
        return json(
          200,
          validateTailor(
            parseToolUse(resp, "record_tailor"),
            seats.map((s) => s.id),
          ),
          cors,
        );
      }
      if (url.pathname === "/dinner") {
        const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
        const people = sanitizePeople(body.people).filter((p) => p.id);
        const candidates = (Array.isArray(body.candidates) ? body.candidates : [])
          .filter(
            (/** @type {any} */ c) =>
              typeof c === "object" && c !== null && typeof c.id === "string" && c.id,
          )
          .map((/** @type {any} */ c) => ({
            id: String(c.id).slice(0, 80),
            name: typeof c.name === "string" ? c.name.trim().slice(0, 80) : "",
            calories:
              typeof c.calories === "number" && isFinite(c.calories) ? Math.round(c.calories) : 0,
            protein:
              typeof c.protein === "number" && isFinite(c.protein) ? Math.round(c.protein) : 0,
            cuisine: typeof c.cuisine === "string" ? c.cuisine.trim().slice(0, 30) : "",
          }))
          .slice(0, 80);
        if (messages.length === 0) return json(400, { error: "messages required" }, cors);
        if (people.length === 0) return json(400, { error: "people required" }, cors);
        const resp = await callAnthropic(
          buildDinnerRequest({
            messages,
            people,
            candidates,
            model: env.SCAN_MODEL ?? DEFAULT_MODEL,
          }),
          env.ANTHROPIC_API_KEY,
        );
        return json(
          200,
          parseDinnerResponse(
            resp,
            candidates.map((/** @type {any} */ c) => c.id),
            people.map((p) => p.id),
          ),
          cors,
        );
      }
      // /remedy
      const text = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
      if (!text) return json(400, { error: "text required" }, cors);
      const resp = await callAnthropic(
        buildRemedyRequest({ text, model: env.REMEDY_MODEL ?? DEFAULT_MODEL }),
        env.ANTHROPIC_API_KEY,
      );
      return json(200, { protocol: validateProtocol(parseToolUse(resp, "record_protocol")) }, cors);
    } catch (e) {
      return json(502, { error: e instanceof Error ? e.message : "upstream error" }, cors);
    }
  },
};
