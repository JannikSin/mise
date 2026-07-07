// Pure logic for the Mise Worker — everything here is node-testable.
// The Worker returns raw item/protocol data; the APP owns section
// classification (sectionOf) and pantry merging, keeping this thin.

const ALLOWED_ORIGINS = ["https://janniksin.github.io", "http://127.0.0.1:8378"];

/**
 * CORS headers for an allowed origin, null for anything else.
 * @param {string | null} origin
 * @returns {Record<string, string> | null}
 */
export function corsFor(origin) {
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-mise-auth",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const SCAN_TOOL = {
  name: "record_items",
  description: "Record every distinct food item visible in the photo.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "short shopping-list name, e.g. 'eggs'" },
            kind: {
              type: "string",
              enum: ["staple", "perishable"],
              description:
                "staple = shelf-stable, always-stocked (rice, spices, oil); perishable = fresh, will expire (produce, dairy, leftovers)",
            },
            qty: { type: "string", description: "human-scale amount if visible, e.g. 'half bag'" },
          },
          required: ["name", "kind"],
        },
      },
    },
    required: ["items"],
  },
};

const SCAN_SYSTEM =
  "You itemize kitchen photos (fridge shelf, pantry, counter) for a personal " +
  "pantry tracker. List each DISTINCT food item once with a short generic name " +
  "(brand names off). Ignore non-food objects, appliances and packaging you " +
  "cannot identify. When unsure whether something is present, leave it out.";

/**
 * Anthropic Messages request body for a pantry photo scan.
 * @param {{ image: string, mediaType: string, model: string }} args
 */
export function buildScanRequest({ image, mediaType, model }) {
  return {
    model,
    max_tokens: 1024,
    system: SCAN_SYSTEM,
    tools: [SCAN_TOOL],
    tool_choice: { type: "tool", name: "record_items" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: "Itemize the food in this photo." },
        ],
      },
    ],
  };
}

const REMEDY_TOOL = {
  name: "record_protocol",
  description: "Record the kitchen remedy protocol.",
  input_schema: {
    type: "object",
    properties: {
      teas: { type: "array", items: { type: "string" }, description: "what to drink" },
      foods: { type: "array", items: { type: "string" }, description: "what to eat" },
      avoid: { type: "array", items: { type: "string" }, description: "what to skip" },
      notes: { type: "array", items: { type: "string" }, description: "behavior: rest, timing" },
    },
    required: ["teas", "foods", "avoid", "notes"],
  },
};

const REMEDY_SYSTEM =
  "You are the live remedy engine of Mise, a personal kitchen app for a " +
  "college athlete. Given how he feels, produce a practical KITCHEN protocol: " +
  "what to drink, eat, avoid, and do (rest, hydration, timing). Cheap, " +
  "real-food, high-protein bias; no supplements he would have to buy specially. " +
  "You are not a doctor and this is not medical advice: for anything beyond " +
  "everyday self-care (high fever, chest pain, injuries, symptoms lasting " +
  "over a week) the FIRST note must say to see a doctor or campus health.";

/**
 * Anthropic Messages request body for a live remedy.
 * @param {{ text: string, model: string }} args
 */
export function buildRemedyRequest({ text, model }) {
  return {
    model,
    max_tokens: 1024,
    system: REMEDY_SYSTEM,
    tools: [REMEDY_TOOL],
    tool_choice: { type: "tool", name: "record_protocol" },
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  };
}

/**
 * Input of the forced tool_use block, or null if absent.
 * @param {Record<string, any>} response
 * @param {string} toolName
 * @returns {Record<string, any> | null}
 */
export function parseToolUse(response, toolName) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const block = blocks.find((b) => b?.type === "tool_use" && b?.name === toolName);
  return block ? (block.input ?? null) : null;
}

const RATE_MAX = 30;
const RATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Fixed-window rate limit: at most RATE_MAX requests per key per 10 minutes.
 * State is a per-isolate Map (defense-in-depth against replay and the app's
 * own retry bugs — the PAT check is the real gate; a distributed attacker
 * without the PAT never reaches this).
 * @param {Map<string, { count: number, windowStart: number }>} state
 * @param {string} key
 * @param {number} now epoch ms
 * @returns {boolean} true if the request may proceed
 */
export function allowRequest(state, key, now) {
  const cur = state.get(key);
  if (!cur || now - cur.windowStart >= RATE_WINDOW_MS) {
    state.set(key, { count: 1, windowStart: now });
    return true;
  }
  cur.count++;
  return cur.count <= RATE_MAX;
}

/**
 * Sanitize model output into safe scan items: trimmed capped strings,
 * known kinds only, list length capped. Junk entries are dropped.
 * @param {Record<string, any> | null} input
 * @returns {{ name: string, kind: string, qty: string }[]}
 */
export function validateScanItems(input) {
  const raw = Array.isArray(input?.items) ? input.items : [];
  const out = [];
  for (const it of raw) {
    if (out.length >= 60) break;
    if (typeof it !== "object" || it === null) continue;
    const name = typeof it.name === "string" ? it.name.trim().slice(0, 80) : "";
    if (!name) continue;
    const kind = it.kind === "staple" ? "staple" : "perishable";
    const qty = typeof it.qty === "string" ? it.qty.trim().slice(0, 40) : "";
    out.push({ name, kind, qty });
  }
  return out;
}

/**
 * Sanitize model output into the protocol shape the remedies view renders.
 * @param {Record<string, any> | null} input
 * @returns {{ teas: string[], foods: string[], avoid: string[], notes: string[] }}
 */
export function validateProtocol(input) {
  const arr = (/** @type {any} */ v) =>
    (Array.isArray(v) ? v : [])
      .filter((s) => typeof s === "string" && s.trim())
      .map((s) => s.trim().slice(0, 200))
      .slice(0, 12);
  return {
    teas: arr(input?.teas),
    foods: arr(input?.foods),
    avoid: arr(input?.avoid),
    notes: arr(input?.notes),
  };
}
