// Mise Worker — the app's only server-side component (blueprint Task 12).
// Anthropic-backed endpoints:
//   POST /scan    { image, mediaType }            -> { items: [{name, kind, qty}] }
//   POST /receipt { image, mediaType }            -> { store, items: [{name, price, size}] }
//   POST /menu    { image, mediaType, diners }    -> { diners: [{name, picks, skip}], notes }
//   POST /tailor  { recipe, seats }               -> { seats: {id: {plate, est*}}, cook }
//   POST /dinner  { messages, people, candidates } -> { reply, decision }
//   POST /dinnerweek { people, candidates, meals, cuisine, note } -> { nights, notes }
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
  buildDinnerWeekRequest,
  validateDinnerWeek,
  WEEK_MEAL_SLOTS,
  parseToolUse,
  parseOnboardResponse,
  parseDinnerResponse,
  validateScanItems,
  validateReceiptItems,
  validateProtocol,
  validateMenuReport,
  validateTailor,
  sanitizePeople,
  screenTailorAvoid,
  specialAvoidHits,
  hitsAvoid,
  allowRequest,
  buildNotifications,
  isoWeekIdOf,
  parseHealthExport,
  mergeVitalsDays,
  buildAskRequest,
  parseAskResponse,
  sanitizeAskContext,
} from "./lib.js";

const DATA_REPO = "JannikSin/mise-data";
const DEFAULT_MODEL = "claude-sonnet-5";
const AUTH_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 6 * 1024 * 1024; // ~4.5MB image after base64

/** token-hash -> expiry; per-isolate, so worst case is one extra GitHub call */
const authCache = new Map();
/** token-hash -> fixed-window request counter (see allowRequest) */
const rateState = new Map();

/**
 * Bounded candidate-recipe list at the trust boundary (shared by /dinner and
 * /dinnerweek).
 * @param {any} input
 * @returns {{ id: string, name: string, calories: number, protein: number, cuisine: string }[]}
 */
function sanitizeCandidates(input) {
  return (Array.isArray(input) ? input : [])
    .filter(
      (/** @type {any} */ c) =>
        typeof c === "object" && c !== null && typeof c.id === "string" && c.id,
    )
    .map((/** @type {any} */ c) => ({
      id: String(c.id).slice(0, 80),
      name: typeof c.name === "string" ? c.name.trim().slice(0, 80) : "",
      calories:
        typeof c.calories === "number" && isFinite(c.calories) ? Math.round(c.calories) : 0,
      protein: typeof c.protein === "number" && isFinite(c.protein) ? Math.round(c.protein) : 0,
      cuisine: typeof c.cuisine === "string" ? c.cuisine.trim().slice(0, 30) : "",
    }))
    .slice(0, 80);
}

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

// ---- notification cron helpers -------------------------------------------

/**
 * Read one file from the private data repo via the Contents API (the one
 * sanctioned data path). 404 → null.
 * @param {string} path
 * @param {string} token
 * @returns {Promise<Record<string, any> | null>}
 */
async function ghReadJson(path, token) {
  const res = await fetch(`https://api.github.com/repos/${DATA_REPO}/contents/${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github.raw+json",
      "user-agent": "mise-worker",
    },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

/** local wall clock in David's timezone */
function chicagoNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (/** @type {string} */ t) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    hour: Number(get("hour")) % 24,
    weekday: get("weekday"),
    dateIso: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/**
 * Compute this hour's notifications from live data and post them to ntfy.
 * @param {string} token repo-read token
 * @param {string} topic ntfy topic
 * @param {{ hour: number, weekday: string, dateIso: string }} now
 * @param {boolean} send false = preview only (the SYS test button)
 * @returns {Promise<{ sent: number, preview: { title: string, body: string }[] }>}
 */
async function runNotifications(token, topic, now, send) {
  const weekId = isoWeekIdOf(now.dateIso);
  const plan = await ghReadJson(`plans/${weekId}.json`, token);
  // shopping only matters at its hours; skip the read otherwise. (The daily
  // log read left with the log nags, 2026-08-09 — Crystal owns tracking.)
  const wantsShopping = now.weekday === "Sat" || now.weekday === "Sun";
  const shopping = wantsShopping ? await ghReadJson("shopping.json", token) : null;
  // resolve only the recipe names today's entries actually need
  /** @type {Record<string, string>} */
  const names = {};
  const todaysIds = [
    ...new Set(
      (plan?.entries ?? [])
        .filter((/** @type {any} */ e) => e.date === now.dateIso && e.recipeId)
        .map((/** @type {any} */ e) => String(e.recipeId))
        // defense-in-depth: recipe ids are slugs; anything else never
        // reaches a URL (no path/query traversal via a poisoned plan file)
        .filter((/** @type {string} */ id) => /^[a-z0-9-]+$/.test(id)),
    ),
  ].slice(0, 12);
  for (const id of todaysIds) {
    const r = await ghReadJson(`recipes/${id}.json`, token);
    if (r?.name) names[id] = String(r.name);
  }
  const recipeName = (/** @type {string} */ id) => names[id] ?? id;

  const notifications = send
    ? buildNotifications({ ...now, plan, shopping, recipeName })
    : // preview mode: the whole day's schedule at once, so the SYS button
      // shows what WOULD fire instead of an empty list at off-hours
      [7, 10, 11, 12, 15, 17, 20].flatMap((hour) =>
        buildNotifications({ ...now, hour, plan, shopping, recipeName }),
      );

  let sent = 0;
  if (send && topic) {
    for (const n of notifications) {
      const res = await fetch(`https://ntfy.sh/${topic}`, {
        method: "POST",
        headers: {
          Title: n.title,
          Priority: n.priority,
          Tags: n.tags,
          Click: n.click,
        },
        body: n.body,
      });
      if (res.ok) sent++;
    }
  }
  return { sent, preview: notifications.map((n) => ({ title: n.title, body: n.body })) };
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

/**
 * Write one JSON file to the private data repo. Passes the sha so a concurrent
 * write 409s instead of silently clobbering, per the project data rules.
 * @param {string} path
 * @param {Record<string, any>} data
 * @param {string | undefined} sha
 * @param {string} token
 * @param {string} message
 */
async function ghWriteJson(path, data, sha, token, message) {
  /** @type {Record<string, string>} */
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2)))),
  };
  if (sha) body.sha = sha;
  return fetch(`https://api.github.com/repos/${DATA_REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "mise-worker",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * Read a file WITH its sha (ghReadJson deliberately returns raw content only).
 * @param {string} path
 * @param {string} token
 * @returns {Promise<{ data: Record<string, any> | null, sha: string | undefined }>}
 */
async function ghReadWithSha(path, token) {
  const res = await fetch(`https://api.github.com/repos/${DATA_REPO}/contents/${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "mise-worker",
    },
  });
  if (res.status === 404) return { data: null, sha: undefined };
  if (!res.ok) throw new Error(`read ${path} failed: ${res.status}`);
  const meta = await res.json();
  /** @type {Record<string, any> | null} */
  let data;
  try {
    data = JSON.parse(
      decodeURIComponent(escape(atob(String(meta.content ?? "").replace(/\n/g, "")))),
    );
  } catch {
    data = null;
  }
  return { data, sha: meta.sha };
}

/**
 * POST /vitals — Apple Health ingest for Health Auto Export.
 *
 * Auth is a dedicated VITALS_KEY, not the GitHub PAT the browser app presents,
 * so the phone never carries a credential that can read the whole data repo.
 * The key may arrive as an `x-vitals-key` header OR as the last path segment
 * (`/vitals/<key>`), because the app's URL field is guaranteed to exist while
 * its custom-header support is the one thing not verified against a live
 * install. Prefer the header: a key in a URL can end up in request logs.
 *
 * @param {Request} request
 * @param {{ VITALS_KEY?: string, MISE_DATA_WRITE_TOKEN?: string }} env
 * @param {URL} url
 */
async function handleVitals(request, env, url) {
  /** @type {Record<string, string>} */
  const bare = {};
  if (request.method !== "POST") return json(405, { error: "POST only" }, bare);
  if (!env.VITALS_KEY || !env.MISE_DATA_WRITE_TOKEN) {
    return json(
      503,
      { error: "vitals ingest not configured (VITALS_KEY + MISE_DATA_WRITE_TOKEN)" },
      bare,
    );
  }
  const pathKey = url.pathname.startsWith("/vitals/") ? url.pathname.slice("/vitals/".length) : "";
  const presented = request.headers.get("x-vitals-key") || pathKey;
  // Constant-time-ish: compare lengths first, then whole strings. The key is
  // high-entropy and this endpoint is rate-limited by GitHub write latency,
  // so a timing oracle here is not a practical attack surface.
  if (!presented || presented.length !== env.VITALS_KEY.length || presented !== env.VITALS_KEY) {
    return json(401, { error: "bad vitals key" }, bare);
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: "payload too large" }, bare);
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid JSON body" }, bare);
  }

  const { days, recognized, ignored } = parseHealthExport(body);
  if (!days.length) {
    // Deliberately not a 200. A post that parsed to nothing is the failure mode
    // that would otherwise look exactly like success, and the ignored list is
    // what tells us which metric names to add to the map.
    return json(
      422,
      { error: "no recognisable health metrics in payload", recognized, ignored },
      bare,
    );
  }

  const path = "health/vitals.json";
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, sha } = await ghReadWithSha(path, env.MISE_DATA_WRITE_TOKEN);
    const merged = {
      days: mergeVitalsDays(data?.days ?? [], days),
      ekg: Array.isArray(data?.ekg) ? data.ekg : [],
    };
    const res = await ghWriteJson(
      path,
      merged,
      sha,
      env.MISE_DATA_WRITE_TOKEN,
      `vitals ${days.map((d) => d.date).join(", ")}`,
    );
    if (res.ok) {
      return json(
        200,
        { written: days.length, dates: days.map((d) => d.date), recognized, ignored },
        bare,
      );
    }
    // 409 means someone else wrote between our read and write. Re-read and
    // retry once, which is the merge rule the rest of this project follows.
    if (res.status !== 409) {
      return json(502, { error: `data write failed: ${res.status}`, recognized, ignored }, bare);
    }
  }
  return json(409, { error: "write conflict twice, try again" }, bare);
}

export default {
  /**
   * Hourly cron (wrangler.toml): compute this hour's notifications and post
   * them to ntfy. Silent no-op until both secrets exist: MISE_DATA_TOKEN (a
   * read-only fine-grained PAT for mise-data — the ONE stored credential,
   * revoke it to kill the cron) and NTFY_TOPIC.
   * @param {{ cron: string }} controller
   * @param {{ MISE_DATA_TOKEN?: string, NTFY_TOPIC?: string }} env
   */
  async scheduled(controller, env) {
    if (!env.MISE_DATA_TOKEN || !env.NTFY_TOPIC) return;
    try {
      await runNotifications(env.MISE_DATA_TOKEN, env.NTFY_TOPIC, chicagoNow(), true);
    } catch {
      // one bad fetch must not take down the hour's cron; the next hour
      // runs fresh and the SYS test button surfaces persistent breakage
    }
  },

  /**
   * @param {Request} request
   * @param {{ ANTHROPIC_API_KEY?: string, SCAN_MODEL?: string, REMEDY_MODEL?: string, MISE_DATA_TOKEN?: string, NTFY_TOPIC?: string, VITALS_KEY?: string, MISE_DATA_WRITE_TOKEN?: string }} env
   */
  async fetch(request, env) {
    const cors = corsFor(request.headers.get("origin"));

    // /vitals is handled BEFORE the CORS gate on purpose. Every other route is
    // called by the browser app, so an allowed Origin is the right first
    // filter. This one is called by Health Auto Export, a native iOS app,
    // which sends no Origin header at all — running it through corsFor would
    // 403 every post and the failure would look like "the watch isn't working".
    // It is not less protected: it carries its own dedicated key and never
    // touches the Anthropic budget.
    {
      const u = new URL(request.url);
      if (u.pathname === "/vitals" || u.pathname.startsWith("/vitals/")) {
        return handleVitals(request, env, u);
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
    }
    if (!cors) return json(403, { error: "origin not allowed" }, {});
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      ![
        "/scan",
        "/receipt",
        "/onboard",
        "/remedy",
        "/menu",
        "/tailor",
        "/dinner",
        "/dinnerweek",
        "/ask",
        "/notify-test",
      ].includes(url.pathname)
    ) {
      return json(404, { error: "not found" }, cors);
    }

    const token = request.headers.get("x-mise-auth");
    if (!(await isAuthorized(token))) {
      return json(401, { error: "unauthorized" }, cors);
    }
    if (
      !allowRequest(
        rateState,
        await tokenKey(/** @type {string} */ (token)),
        Date.now(),
        // /dinnerweek's 16k max_tokens is ~4x any other route's spend
        url.pathname === "/dinnerweek" ? 4 : 1,
      )
    ) {
      return json(429, { error: "slow down — try again in a few minutes" }, cors);
    }

    // notification test (SYS button): reads with the PRESENTED token, sends
    // one live ping, returns the whole day's would-fire schedule. Needs no
    // Anthropic key — only the ntfy topic.
    if (url.pathname === "/notify-test") {
      try {
        const now = chicagoNow();
        const result = await runNotifications(
          /** @type {string} */ (token),
          env.NTFY_TOPIC ?? "",
          now,
          false,
        );
        let pinged = false;
        if (env.NTFY_TOPIC) {
          const res = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
            method: "POST",
            headers: { Title: "Mise notifications are wired", Tags: "tada", Priority: "default" },
            body: `Test ping ${now.dateIso} ${now.hour}:00. Today's schedule has ${result.preview.length} notification(s).`,
          });
          pinged = res.ok;
        }
        return json(
          200,
          {
            pinged,
            topicSet: Boolean(env.NTFY_TOPIC),
            cronReady: Boolean(env.MISE_DATA_TOKEN && env.NTFY_TOPIC),
            preview: result.preview,
          },
          cors,
        );
      } catch (e) {
        return json(502, { error: e instanceof Error ? e.message : "notify test failed" }, cors);
      }
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
        // deterministic avoid screen AFTER the model — never an AI judgment
        return json(
          200,
          screenTailorAvoid(
            validateTailor(
              parseToolUse(resp, "record_tailor"),
              seats.map((s) => s.id),
            ),
            seats,
          ),
          cors,
        );
      }
      if (url.pathname === "/ask") {
        const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
        if (messages.length === 0) return json(400, { error: "messages required" }, cors);
        const context = sanitizeAskContext(body.context);
        const resp = await callAnthropic(
          buildAskRequest({ messages, context, model: env.SCAN_MODEL ?? DEFAULT_MODEL }),
          env.ANTHROPIC_API_KEY,
        );
        return json(200, parseAskResponse(resp), cors);
      }
      if (url.pathname === "/dinner") {
        const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
        const people = sanitizePeople(body.people).filter((p) => p.id);
        const candidates = sanitizeCandidates(body.candidates);
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
        const turn = parseDinnerResponse(
          resp,
          candidates.map((/** @type {any} */ c) => c.id),
          people.map((p) => p.id),
        );
        if (turn.decision) {
          // deterministic avoid screen AFTER the model — never an AI judgment
          if (turn.decision.special) {
            const hits = specialAvoidHits(/** @type {any} */ (turn.decision.special), people);
            if (hits.length > 0) {
              return json(
                200,
                {
                  reply: `That idea is refused: it uses something on a never-serve list (${hits.join("; ")}). Ask for another idea.`,
                  decision: null,
                },
                cors,
              );
            }
          }
          const avoidById = new Map(people.map((p) => [p.id, p.avoid]));
          turn.decision.plates = turn.decision.plates.map((p) =>
            hitsAvoid(p.note, avoidById.get(p.id) ?? []).length > 0 ? { ...p, note: "" } : p,
          );
        }
        return json(200, turn, cors);
      }
      if (url.pathname === "/dinnerweek") {
        const people = sanitizePeople(body.people).filter((p) => p.id);
        const candidates = sanitizeCandidates(body.candidates);
        /** @type {{ date: string, slot: string }[]} */
        const meals = [];
        const seen = new Set();
        for (const m of Array.isArray(body.meals) ? body.meals : []) {
          if (meals.length >= 21) break; // 7 days x the 3 cooked slots
          if (typeof m !== "object" || m === null) continue;
          const date =
            typeof m.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.date) ? m.date : "";
          const slot = typeof m.slot === "string" && WEEK_MEAL_SLOTS.includes(m.slot) ? m.slot : "";
          if (!date || !slot || seen.has(`${date}|${slot}`)) continue;
          seen.add(`${date}|${slot}`);
          meals.push({ date, slot });
        }
        meals.sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            WEEK_MEAL_SLOTS.indexOf(a.slot) - WEEK_MEAL_SLOTS.indexOf(b.slot),
        );
        const cuisine = typeof body.cuisine === "string" ? body.cuisine.trim().slice(0, 60) : "";
        const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
        if (people.length === 0) return json(400, { error: "people required" }, cors);
        if (meals.length === 0) return json(400, { error: "meals required" }, cors);
        const resp = await callAnthropic(
          buildDinnerWeekRequest({
            meals,
            cuisine,
            note,
            people,
            candidates,
            model: env.SCAN_MODEL ?? DEFAULT_MODEL,
          }),
          env.ANTHROPIC_API_KEY,
        );
        const nights = validateDinnerWeek(
          parseToolUse(resp, "record_dinner_week"),
          candidates.map((c) => c.id),
          people.map((p) => p.id),
          meals,
        );
        // deterministic avoid screen AFTER the model — never an AI judgment.
        // A special that hits a never-serve list drops its MEAL (reported),
        // and a plate note naming an avoided food is blanked, same as /dinner.
        const avoidById = new Map(people.map((p) => [p.id, p.avoid]));
        /** @type {string[]} */
        const notes = [];
        const clean = nights.filter((n) => {
          if (n.special) {
            const hits = specialAvoidHits(/** @type {any} */ (n.special), people);
            if (hits.length > 0) {
              notes.push(
                `${n.date} ${n.slot}: the proposed special was refused (${hits.join("; ")})`,
              );
              return false;
            }
          }
          n.plates = n.plates.map((p) =>
            hitsAvoid(p.note, avoidById.get(p.id) ?? []).length > 0 ? { ...p, note: "" } : p,
          );
          return true;
        });
        for (const m of meals) {
          const label = `${m.date} ${m.slot}`;
          if (
            !clean.some((n) => n.date === m.date && n.slot === m.slot) &&
            !notes.some((s) => s.startsWith(label))
          )
            notes.push(
              `${label}: nothing came back for this meal — run it again or set it by hand`,
            );
        }
        return json(200, { nights: clean, notes }, cors);
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
