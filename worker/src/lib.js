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

const RECEIPT_TOOL = {
  name: "record_receipt",
  description: "Record the store and every priced line item on a grocery receipt.",
  input_schema: {
    type: "object",
    properties: {
      store: {
        type: "string",
        description: "store name printed on the receipt if visible, e.g. 'Trader Joe's', else ''",
      },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "generic food name, brand off, e.g. 'black beans'" },
            price: { type: "number", description: "the line's dollar price as a number, e.g. 1.99" },
            size: { type: "string", description: "package size if printed, e.g. '15 oz', else ''" },
          },
          required: ["name", "price"],
        },
      },
    },
    required: ["store", "items"],
  },
};

const RECEIPT_SYSTEM =
  "You read grocery receipts for a personal price tracker. Record the store " +
  "name and every FOOD line with its price as a number. Use a short generic " +
  "food name (brand off). Skip non-food lines, taxes, totals, discounts, and " +
  "loyalty rows. If a size is printed on the line, include it, else leave it blank.";

/**
 * Anthropic Messages request body for a grocery-receipt scan.
 * @param {{ image: string, mediaType: string, model: string }} args
 */
export function buildReceiptRequest({ image, mediaType, model }) {
  return {
    model,
    max_tokens: 2048,
    system: RECEIPT_SYSTEM,
    tools: [RECEIPT_TOOL],
    tool_choice: { type: "tool", name: "record_receipt" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: "Read the store and every priced food line on this receipt." },
        ],
      },
    ],
  };
}

const ONBOARD_TOOL = {
  name: "record_profile",
  description:
    "Call this ONLY once you have gathered every required answer. Record the " +
    "raw questionnaire answers. The app computes calories/macros itself from " +
    "these (Mifflin-St Jeor), so never invent nutrition numbers.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      emoji: { type: "string", description: "one emoji for the profile button" },
      household: { type: "string", description: "who they grocery-shop with; 'home' if unsure" },
      sex: { type: "string", enum: ["m", "f"], description: "for the calorie formula" },
      age: { type: "number" },
      heightFt: { type: "number" },
      heightIn: { type: "number" },
      weightLb: { type: "number" },
      activity: { type: "number", description: "1 desk job .. 5 athlete" },
      goal: { type: "string", enum: ["loss", "maintain", "gain"] },
      trainingEnabled: { type: "boolean", description: "do they want workout tracking" },
      state: { type: "string", description: "2-letter US state for grocery tax, or ''" },
      diet: { type: "string", enum: ["omnivore", "pescatarian", "vegetarian", "vegan"] },
      allergensFreeText: { type: "string", description: "comma-separated allergies/hard-no foods" },
      dislikeIngredients: { type: "array", items: { type: "string" } },
      tiredOf: { type: "array", items: { type: "string" }, description: "foods eaten too much lately" },
      lovedCuisines: { type: "array", items: { type: "string" } },
      avoidedCuisines: { type: "array", items: { type: "string" } },
      budget: { type: "string", enum: ["tight", "normal", "loose"] },
      stores: { type: "array", items: { type: "string" } },
      maxWeeknightMinutes: { type: "number", description: "15, 30, or 0 for no limit" },
      leftoverTolerance: { type: "string", enum: ["none", "some", "lots"] },
      packsLunch: { type: "boolean" },
      lunchMicrowave: { type: "boolean" },
      skipBreakfast: { type: "boolean" },
      smoothie: { type: "boolean", description: "wants a daily smoothie (needs a blender)" },
    },
    required: ["name", "emoji", "sex", "age", "heightFt", "heightIn", "weightLb", "activity", "goal"],
  },
};

const ONBOARD_SYSTEM =
  "You onboard a new person to Mise, a personal meal-planning app, through a " +
  "SHORT friendly chat. A partial survey may already be filled in (given as " +
  "JSON); NEVER re-ask anything already answered there. Ask only what is still " +
  "missing or needs nuance, ONE question at a time, grouping a couple of quick " +
  "ones when natural. You MUST end with the required fields known: name, emoji, " +
  "sex, age, height, weight, activity level, and goal (lose/maintain/gain). " +
  "Everything else is a bonus, do not drag the chat out for it. Keep each reply " +
  "to a sentence or two. The moment you have the required answers plus whatever " +
  "the person volunteered, call record_profile and stop asking. Do not compute " +
  "calories or macros, the app does that. No medical advice. No em dashes.";

/**
 * Anthropic Messages request for one onboarding chat turn. `messages` is the
 * running user/assistant history; `survey` is the partial gate answers as
 * context so the model never re-asks them.
 * @param {{ messages: {role: string, content: string}[], survey: Record<string, any>, model: string }} args
 */
export function buildOnboardRequest({ messages, survey, model }) {
  const system = `${ONBOARD_SYSTEM}\n\nAlready-known survey answers (do not re-ask):\n${JSON.stringify(survey ?? {})}`;
  return {
    model,
    max_tokens: 1024,
    system,
    tools: [ONBOARD_TOOL],
    messages: messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text: String(m.content ?? "").slice(0, 4000) }],
    })),
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
 * Extract one onboarding turn from a model response: either assistant TEXT
 * (the next question) or a record_profile tool call (done). Prefers the tool
 * call when present.
 * @param {Record<string, any>} response
 * @returns {{ reply: string, profile: Record<string, any> | null }}
 */
export function parseOnboardResponse(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const tool = blocks.find((b) => b?.type === "tool_use" && b?.name === "record_profile");
  if (tool) return { reply: "", profile: validateOnboardProfile(tool.input ?? {}) };
  const text = blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { reply: text, profile: null };
}

/**
 * Sanitize a record_profile tool input into the raw questionnaire the app
 * feeds to targetsFromQuestionnaire. Missing required numbers => null (the
 * turn is treated as not-yet-done). Strings capped, arrays bounded.
 * @param {Record<string, any>} input
 * @returns {Record<string, any> | null}
 */
export function validateOnboardProfile(input) {
  const str = (/** @type {any} */ v, /** @type {number} */ n) =>
    typeof v === "string" ? v.trim().slice(0, n) : "";
  const num = (/** @type {any} */ v) => (typeof v === "number" && isFinite(v) ? v : null);
  const list = (/** @type {any} */ v) =>
    (Array.isArray(v) ? v : [])
      .filter((s) => typeof s === "string" && s.trim())
      .map((s) => s.trim().slice(0, 60))
      .slice(0, 20);
  const name = str(input.name, 40);
  const req = [input.sex, input.age, input.heightFt, input.heightIn, input.weightLb, input.activity, input.goal];
  const sexOk = input.sex === "m" || input.sex === "f";
  const goalOk = ["loss", "maintain", "gain"].includes(input.goal);
  if (!name || !sexOk || !goalOk || req.some((v, i) => i > 0 && i < 6 && num(v) === null)) {
    return null;
  }
  return {
    name,
    emoji: str(input.emoji, 8) || "🙂",
    household: str(input.household, 40),
    sex: input.sex,
    age: num(input.age),
    heightFt: num(input.heightFt),
    heightIn: num(input.heightIn) ?? 0,
    weightLb: num(input.weightLb),
    activity: Math.max(1, Math.min(5, Math.round(num(input.activity) ?? 2))),
    goal: input.goal,
    trainingEnabled: input.trainingEnabled !== false,
    state: str(input.state, 2).toUpperCase(),
    diet: ["omnivore", "pescatarian", "vegetarian", "vegan"].includes(input.diet) ? input.diet : "omnivore",
    allergensFreeText: str(input.allergensFreeText, 200),
    dislikeIngredients: list(input.dislikeIngredients),
    tiredOf: list(input.tiredOf),
    lovedCuisines: list(input.lovedCuisines).slice(0, 3),
    avoidedCuisines: list(input.avoidedCuisines),
    budget: ["tight", "normal", "loose"].includes(input.budget) ? input.budget : "normal",
    stores: list(input.stores),
    maxWeeknightMinutes: num(input.maxWeeknightMinutes) || 0,
    leftoverTolerance: ["none", "some", "lots"].includes(input.leftoverTolerance)
      ? input.leftoverTolerance
      : "some",
    packsLunch: input.packsLunch === true,
    lunchMicrowave: input.lunchMicrowave === true,
    skipBreakfast: input.skipBreakfast === true,
    smoothie: input.smoothie === true,
  };
}

/**
 * Sanitize receipt output: a store string plus priced food lines. Junk and
 * non-positive prices dropped, strings capped, list length bounded.
 * @param {Record<string, any> | null} input
 * @returns {{ store: string, items: { name: string, price: number, size: string }[] }}
 */
export function validateReceiptItems(input) {
  const store = typeof input?.store === "string" ? input.store.trim().slice(0, 60) : "";
  const raw = Array.isArray(input?.items) ? input.items : [];
  const out = [];
  for (const it of raw) {
    if (out.length >= 120) break;
    if (typeof it !== "object" || it === null) continue;
    const name = typeof it.name === "string" ? it.name.trim().slice(0, 80) : "";
    const price = typeof it.price === "number" && it.price > 0 ? Math.round(it.price * 100) / 100 : 0;
    if (!name || !price) continue;
    const size = typeof it.size === "string" ? it.size.trim().slice(0, 40) : "";
    out.push({ name, price, size });
  }
  return { store, items: out };
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
