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
            name: {
              type: "string",
              description: "generic food name, brand off, e.g. 'black beans'",
            },
            price: {
              type: "number",
              description: "the line's dollar price as a number, e.g. 1.99",
            },
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
      tiredOf: {
        type: "array",
        items: { type: "string" },
        description: "foods eaten too much lately",
      },
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
    required: [
      "name",
      "emoji",
      "sex",
      "age",
      "heightFt",
      "heightIn",
      "weightLb",
      "activity",
      "goal",
    ],
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

// ---- shared person context (menu / tailor / dinner) ----------------------

/**
 * Sanitize a client-sent people array (per-person nutrition context) at the
 * trust boundary: capped strings, finite numbers, bounded lists.
 * @param {any} input
 * @returns {{ id: string, name: string, goal: string, calories: number, protein: number, diet: string, avoid: string[], say: string }[]}
 */
export function sanitizePeople(input) {
  const str = (/** @type {any} */ v, /** @type {number} */ n) =>
    typeof v === "string" ? v.trim().slice(0, n) : "";
  const num = (/** @type {any} */ v) =>
    typeof v === "number" && isFinite(v) && v > 0 ? Math.round(v) : 0;
  const out = [];
  for (const p of Array.isArray(input) ? input : []) {
    if (out.length >= 8) break;
    if (typeof p !== "object" || p === null) continue;
    const name = str(p.name, 40);
    if (!name) continue;
    out.push({
      id: str(p.id, 40),
      name,
      goal: str(p.goal, 20),
      calories: num(p.calories),
      protein: num(p.protein),
      diet: str(p.diet, 20),
      avoid: (Array.isArray(p.avoid) ? p.avoid : [])
        .filter((/** @type {any} */ s) => typeof s === "string" && s.trim())
        .map((/** @type {string} */ s) => s.trim().slice(0, 60))
        .slice(0, 20),
      say: str(p.say, 300),
    });
  }
  return out;
}

/** @param {ReturnType<typeof sanitizePeople>[number]} p one prompt line of person context */
function personLine(p) {
  const bits = [`${p.name}: goal ${p.goal || "maintain"}`];
  if (p.calories) bits.push(`daily target ${p.calories} kcal / ${p.protein}g protein`);
  if (p.diet && p.diet !== "omnivore") bits.push(p.diet);
  if (p.avoid.length > 0) bits.push(`never serve: ${p.avoid.join(", ")}`);
  return bits.join(", ");
}

// ---- /menu: restaurant-menu photo → per-diner report ---------------------

const MENU_TOOL = {
  name: "record_menu",
  description: "Record the per-diner menu report.",
  input_schema: {
    type: "object",
    properties: {
      diners: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "the diner's name, exactly as given" },
            picks: {
              type: "array",
              description: "1-3 best menu items for this diner, best first",
              items: {
                type: "object",
                properties: {
                  item: { type: "string", description: "the menu item name as printed" },
                  why: { type: "string", description: "one short sentence: why this fits them" },
                  estCalories: { type: "number", description: "rough honest estimate" },
                  estProtein: { type: "number", description: "rough grams protein" },
                },
                required: ["item", "why", "estCalories", "estProtein"],
              },
            },
            skip: {
              type: "array",
              items: { type: "string" },
              description: "menu items this diner should skip, with no reason text",
            },
          },
          required: ["name", "picks", "skip"],
        },
      },
      notes: {
        type: "array",
        items: { type: "string" },
        description: "0-3 whole-table notes (share a side, portion warnings)",
      },
    },
    required: ["diners", "notes"],
  },
};

const MENU_SYSTEM =
  "You read a photographed restaurant menu for a household meal-planning app. " +
  "Each diner has a goal and daily macro targets. Recommend only items that " +
  "actually appear on the menu, adapted per diner: a gaining lifter wants " +
  "protein-dense and calorie-dense picks, a losing diner wants satiating " +
  "lower-calorie picks (and note easy trims like skip the bread, dressing on " +
  "the side). Respect diets and never-serve lists absolutely. Macro estimates " +
  "are honest restaurant-portion guesses. No em dashes.";

/**
 * Anthropic Messages request for a menu-photo scan.
 * @param {{ image: string, mediaType: string, diners: ReturnType<typeof sanitizePeople>, model: string }} args
 */
export function buildMenuRequest({ image, mediaType, diners, model }) {
  return {
    model,
    max_tokens: 2048,
    system: MENU_SYSTEM,
    tools: [MENU_TOOL],
    tool_choice: { type: "tool", name: "record_menu" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          {
            type: "text",
            text: `Diners:\n${diners.map(personLine).join("\n")}\n\nRead this menu and report what each diner should order.`,
          },
        ],
      },
    ],
  };
}

/**
 * Sanitize the menu report: capped strings, finite numbers, bounded lists.
 * @param {Record<string, any> | null} input
 * @returns {{ diners: { name: string, picks: { item: string, why: string, estCalories: number, estProtein: number }[], skip: string[] }[], notes: string[] }}
 */
export function validateMenuReport(input) {
  const strList = (/** @type {any} */ v, /** @type {number} */ cap) =>
    (Array.isArray(v) ? v : [])
      .filter((s) => typeof s === "string" && s.trim())
      .map((s) => s.trim().slice(0, 120))
      .slice(0, cap);
  const diners = [];
  for (const d of Array.isArray(input?.diners) ? input.diners : []) {
    if (diners.length >= 8) break;
    if (typeof d !== "object" || d === null) continue;
    const name = typeof d.name === "string" ? d.name.trim().slice(0, 40) : "";
    if (!name) continue;
    const picks = [];
    for (const p of Array.isArray(d.picks) ? d.picks : []) {
      if (picks.length >= 3) break;
      if (typeof p !== "object" || p === null) continue;
      const item = typeof p.item === "string" ? p.item.trim().slice(0, 80) : "";
      if (!item) continue;
      picks.push({
        item,
        why: typeof p.why === "string" ? p.why.trim().slice(0, 200) : "",
        estCalories:
          typeof p.estCalories === "number" && isFinite(p.estCalories)
            ? Math.round(p.estCalories)
            : 0,
        estProtein:
          typeof p.estProtein === "number" && isFinite(p.estProtein) ? Math.round(p.estProtein) : 0,
      });
    }
    diners.push({ name, picks, skip: strList(d.skip, 6) });
  }
  return { diners, notes: strList(input?.notes, 3).map((s) => s.slice(0, 200)) };
}

// ---- /tailor: one shared table dish → per-seat plate adjustments ---------

const TAILOR_TOOL = {
  name: "record_tailor",
  description: "Record per-seat plate adjustments and shared cook notes for one table dish.",
  input_schema: {
    type: "object",
    properties: {
      seats: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "the seat's profile id, exactly as given" },
            portionGrams: {
              type: "number",
              description:
                "weighed grams of the finished dish on THIS plate, from the kitchen scale; estimate honestly from the ingredient weights and the seat's servings",
            },
            plate: {
              type: "array",
              items: { type: "string" },
              description:
                "1-4 concrete plating actions for THIS person, EVERY line with an exact amount: grams for anything scoopable ('add 150 g cooked rice', 'add 100 g steamed broccoli'), counts for whole items ('1 fried egg on top'), and explicit omissions with the cook step that makes them possible ('no onions: this plate is portioned out before the onions go in')",
            },
            estCalories: { type: "number", description: "this seat's plate after adjustments" },
            estProtein: { type: "number", description: "grams protein after adjustments" },
          },
          required: ["id", "portionGrams", "plate", "estCalories", "estProtein"],
        },
      },
      cook: {
        type: "array",
        items: { type: "string" },
        description:
          "0-4 sequenced notes for the cook so ONE pot still serves everyone: what to hold back, add late, portion out early, or plate separately, in cooking order",
      },
    },
    required: ["seats", "cook"],
  },
};

const TAILOR_SYSTEM =
  "You tailor ONE shared home-cooked dish to each person at the table. The " +
  "dish is cooked once; your job is per-plate serving instructions so " +
  "nobody guesses at the pot: WHO eats WHAT and HOW MUCH, by weight. The " +
  "kitchen has a food scale and it is used for every plate, so state the " +
  "base portion of the finished dish in grams (portionGrams, estimated " +
  "honestly from the ingredient weights after cooking and the seat's " +
  "servings) and give every adjustment an exact amount: grams for anything " +
  "scoopable, counts for whole items. Move each plate toward that person's " +
  "goal and daily targets: extra starch or a supplemental egg for a gaining " +
  "lifter, more vegetables and lighter starch for someone losing, " +
  "respecting diets and never-serve lists absolutely. An omission ('no " +
  "onions') must come with the cook step that makes it real, e.g. portion " +
  "that plate out BEFORE the onions go in. Adjustments must be achievable " +
  "from the dish's own components plus ordinary pantry staples. Cook notes " +
  "are sequenced, in cooking order, so one pot still serves every plate. " +
  "Honest macro estimates per adjusted plate. No em dashes.";

/**
 * Anthropic Messages request to tailor a table dish per seat.
 * @param {{ recipe: { name: string, servings: number, calories: number, protein: number, carbs: number, fat: number, ingredients: string[] }, seats: ReturnType<typeof sanitizePeople>, model: string }} args
 */
export function buildTailorRequest({ recipe, seats, model }) {
  const dish =
    `Dish: ${recipe.name} (serves ${recipe.servings}; per serving ${recipe.calories} kcal, ` +
    `${recipe.protein}g protein, ${recipe.carbs}g carbs, ${recipe.fat}g fat)\n` +
    `Ingredients: ${recipe.ingredients.join(", ")}`;
  const people = seats
    .map((s) => `[${s.id}] ${personLine(s)}${s.say ? ` (${s.say})` : ""}`)
    .join("\n");
  return {
    model,
    max_tokens: 1536,
    system: TAILOR_SYSTEM,
    tools: [TAILOR_TOOL],
    tool_choice: { type: "tool", name: "record_tailor" },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `${dish}\n\nSeats:\n${people}\n\nTailor each plate.` }],
      },
    ],
  };
}

/**
 * Sanitize tailor output; seats not in `allowedIds` are dropped so the model
 * can never write notes for someone who is not at the table.
 * @param {Record<string, any> | null} input
 * @param {string[]} allowedIds
 * @returns {{ seats: Record<string, { portionGrams: number, plate: string[], estCalories: number, estProtein: number }>, cook: string[] }}
 */
export function validateTailor(input, allowedIds) {
  const strList = (/** @type {any} */ v, /** @type {number} */ cap) =>
    (Array.isArray(v) ? v : [])
      .filter((s) => typeof s === "string" && s.trim())
      .map((s) => s.trim().slice(0, 160))
      .slice(0, cap);
  /** @type {Record<string, { portionGrams: number, plate: string[], estCalories: number, estProtein: number }>} */
  const seats = {};
  const allowed = new Set(allowedIds);
  for (const s of Array.isArray(input?.seats) ? input.seats : []) {
    if (typeof s !== "object" || s === null) continue;
    if (typeof s.id !== "string" || !allowed.has(s.id) || seats[s.id]) continue;
    const plate = strList(s.plate, 4);
    if (plate.length === 0) continue;
    seats[s.id] = {
      // scale-first plating: clamp to a sane single-plate range; 0 = unknown
      portionGrams:
        typeof s.portionGrams === "number" && isFinite(s.portionGrams)
          ? Math.min(3000, Math.max(0, Math.round(s.portionGrams)))
          : 0,
      plate,
      estCalories:
        typeof s.estCalories === "number" && isFinite(s.estCalories)
          ? Math.round(s.estCalories)
          : 0,
      estProtein:
        typeof s.estProtein === "number" && isFinite(s.estProtein) ? Math.round(s.estProtein) : 0,
    };
  }
  return { seats, cook: strList(input?.cook, 4) };
}

// ---- deterministic avoid screen (council 2026-07-23) ---------------------
// Allergens and never-serve lists are enforced by CODE after the model has
// answered, as a refusal, never as an AI judgment the model can talk its
// way around.

/**
 * Which of a person's avoid terms appear in the text (case-insensitive
 * substring; a broad match is the safe direction for a denylist).
 * @param {string} text
 * @param {string[]} avoid
 * @returns {string[]}
 */
export function hitsAvoid(text, avoid) {
  const t = String(text).toLowerCase();
  return (avoid ?? []).filter((a) => a && t.includes(String(a).toLowerCase()));
}

/**
 * Drop any tailored plate line that names an ingredient on that seat's own
 * avoid list; a seat left with no clean lines is dropped entirely.
 * @param {{ seats: Record<string, { plate: string[], estCalories: number, estProtein: number }>, cook: string[] }} tailor
 * @param {{ id: string, avoid: string[] }[]} seats
 * @returns {{ seats: Record<string, { plate: string[], estCalories: number, estProtein: number }>, cook: string[] }}
 */
export function screenTailorAvoid(tailor, seats) {
  const avoidById = new Map(seats.map((s) => [s.id, s.avoid ?? []]));
  /** @type {typeof tailor.seats} */
  const clean = {};
  for (const [id, notes] of Object.entries(tailor.seats)) {
    const plate = notes.plate.filter(
      (line) => hitsAvoid(line, avoidById.get(id) ?? []).length === 0,
    );
    if (plate.length > 0) clean[id] = { ...notes, plate };
  }
  return { ...tailor, seats: clean };
}

/**
 * Refuse a special meal that hits ANY participant's avoid list — in its
 * ingredients, its name, or its instructions ("garnish with peanuts" is as
 * real as a peanut ingredient row; security review 2026-08-09). Broad
 * substring match stays the safe direction for a denylist.
 * Returns the refusal reasons ("Mom: cilantro"), empty = clean.
 * @param {{ name?: string, ingredients: { food: string }[], instructions?: ({ text: string } | string)[] }} special
 * @param {{ name: string, avoid: string[] }[]} people
 * @returns {string[]}
 */
export function specialAvoidHits(special, people) {
  const text = [
    special.name ?? "",
    (special.ingredients ?? []).map((i) => i.food).join(", "),
    (special.instructions ?? [])
      .map((s) => (typeof s === "string" ? s : (s?.text ?? "")))
      .join(" "),
  ].join(" | ");
  const out = [];
  for (const p of people) {
    const hits = hitsAvoid(text, p.avoid);
    if (hits.length > 0) out.push(`${p.name}: ${hits.join(", ")}`);
  }
  return out;
}

// ---- /dinner: household discussion → a decided dinner --------------------

const FOOD_GROUP_KEYS = [
  "beans",
  "berries",
  "otherFruit",
  "cruciferousVeg",
  "greens",
  "otherVeg",
  "flaxseed",
  "nuts",
  "spicesHerbs",
  "wholeGrains",
  "beverages",
];

const SPECIAL_SCHEMA = {
  type: "object",
  description: "a fully specified new meal, only when pickRecipeId is ''",
  properties: {
    name: { type: "string" },
    description: { type: "string", description: "one appetizing sentence" },
    servings: { type: "number", description: "how many servings the recipe yields" },
    totalTime: { type: "number", description: "minutes start to plate" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          qty: { type: "number" },
          unit: { type: "string", description: "g, ml, tbsp, x, ..." },
          food: { type: "string" },
        },
        required: ["qty", "unit", "food"],
      },
    },
    instructions: { type: "array", items: { type: "string" } },
    nutrition: {
      type: "object",
      description: "PER SERVING, honest estimates",
      properties: {
        calories: { type: "number" },
        protein: { type: "number" },
        carbs: { type: "number" },
        fat: { type: "number" },
      },
      required: ["calories", "protein", "carbs", "fat"],
    },
    foodGroups: {
      type: "object",
      description:
        "Daily Dozen servings per recipe serving; keys among: " + FOOD_GROUP_KEYS.join(", "),
    },
  },
  required: ["name", "servings", "totalTime", "ingredients", "instructions", "nutrition"],
};

const PLATES_SCHEMA = {
  type: "array",
  description:
    "per-person plate spec for the chosen dinner: who eats what and how much, by weight",
  items: {
    type: "object",
    properties: {
      id: { type: "string", description: "the person's profile id, exactly as given" },
      note: {
        type: "string",
        description:
          "one concrete plate spec for them with weighed amounts (the kitchen has a food scale): grams of the dish, grams of any addition, counts for whole items, explicit omissions; '' if truly as served",
      },
      estCalories: { type: "number" },
      estProtein: { type: "number" },
    },
    required: ["id", "note", "estCalories", "estProtein"],
  },
};

const DINNER_TOOL = {
  name: "record_dinner",
  description:
    "Call this ONLY when the dinner decision is settled. Either pick a recipe " +
    "from the candidate list (pickRecipeId) OR invent one special meal " +
    "(special) when no candidate honestly satisfies everyone. Never both.",
  input_schema: {
    type: "object",
    properties: {
      pickRecipeId: {
        type: "string",
        description: "the chosen candidate recipe id, or '' when proposing a special meal",
      },
      special: SPECIAL_SCHEMA,
      plates: PLATES_SCHEMA,
      why: { type: "string", description: "1-2 sentences: how this answers everyone's asks" },
    },
    required: ["pickRecipeId", "plates", "why"],
  },
};

const DINNER_SYSTEM =
  "You mediate a household's what-should-dinner-be discussion for a meal " +
  "planning app. Each person has a goal, daily targets, and tonight's ask in " +
  "their own words. Weigh every voice; nobody's ask is silently dropped. " +
  "Strongly prefer picking from the candidate recipe list (the household " +
  "already shops and cooks these). Invent a special meal ONLY when no " +
  "candidate honestly fits the asks, keeping it cheap, whole-food-forward " +
  "and weeknight-simple. If the asks conflict, say the tradeoff plainly in a " +
  "SHORT reply (a sentence or two) and ask ONE clarifying question instead " +
  "of deciding. The moment a fair decision exists, call record_dinner. " +
  "Respect diets and never-serve lists absolutely. Do not re-ask what the " +
  "asks already answer. No em dashes.";

/**
 * Anthropic Messages request for one dinner-discussion turn.
 * @param {{ messages: { role: string, content: string }[], people: ReturnType<typeof sanitizePeople>, candidates: { id: string, name: string, calories: number, protein: number, cuisine: string }[], model: string }} args
 */
export function buildDinnerRequest({ messages, people, candidates, model }) {
  const who = people
    .map((p) => `[${p.id}] ${personLine(p)}${p.say ? ` | tonight's ask: "${p.say}"` : ""}`)
    .join("\n");
  const menu = candidates
    .map(
      (c) =>
        `${c.id}: ${c.name} (${c.calories} kcal, ${c.protein}g P${c.cuisine ? `, ${c.cuisine}` : ""})`,
    )
    .join("\n");
  const system = `${DINNER_SYSTEM}\n\nPeople at the table:\n${who}\n\nCandidate recipes:\n${menu}`;
  return {
    model,
    max_tokens: 2048,
    system,
    tools: [DINNER_TOOL],
    messages: messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text: String(m.content ?? "").slice(0, 4000) }],
    })),
  };
}

/**
 * One dinner-discussion turn: either assistant text (still talking) or a
 * settled decision. Prefers the tool call when present.
 * @param {Record<string, any>} response
 * @param {string[]} candidateIds
 * @param {string[]} personIds
 * @returns {{ reply: string, decision: ReturnType<typeof validateDinnerDecision> }}
 */
export function parseDinnerResponse(response, candidateIds, personIds) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const tool = blocks.find((b) => b?.type === "tool_use" && b?.name === "record_dinner");
  if (tool) {
    const decision = validateDinnerDecision(tool.input ?? {}, candidateIds, personIds);
    if (decision) return { reply: "", decision };
  }
  const text = blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { reply: text, decision: null };
}

/**
 * Sanitize a record_dinner tool input. A pick must name a real candidate; a
 * special meal must be complete enough to cook and shop. Invalid = null (the
 * turn is treated as still-talking).
 * @param {Record<string, any>} input
 * @param {string[]} candidateIds
 * @param {string[]} personIds
 * @returns {{ pickRecipeId: string, special: Record<string, any> | null, plates: { id: string, note: string, estCalories: number, estProtein: number }[], why: string } | null}
 */
export function validateDinnerDecision(input, candidateIds, personIds) {
  const str = (/** @type {any} */ v, /** @type {number} */ n) =>
    typeof v === "string" ? v.trim().slice(0, n) : "";
  const num = (/** @type {any} */ v) => (typeof v === "number" && isFinite(v) ? v : null);
  const pick = str(input.pickRecipeId, 80);
  const allowedPeople = new Set(personIds);

  /** @type {Record<string, any> | null} */
  let special = null;
  if (!pick && typeof input.special === "object" && input.special !== null) {
    const s = input.special;
    const name = str(s.name, 60);
    const servings = num(s.servings);
    const ingredients = (Array.isArray(s.ingredients) ? s.ingredients : [])
      .filter((/** @type {any} */ i) => {
        if (typeof i !== "object" || i === null || !str(i.food, 60)) return false;
        const q = num(i.qty);
        return q !== null && q > 0;
      })
      .map((/** @type {any} */ i) => ({
        qty: /** @type {number} */ (num(i.qty)),
        unit: str(i.unit, 12) || "x",
        food: str(i.food, 60),
      }))
      .slice(0, 25);
    const instructions = (Array.isArray(s.instructions) ? s.instructions : [])
      .filter((/** @type {any} */ t) => typeof t === "string" && t.trim())
      .map((/** @type {string} */ t, /** @type {number} */ i) => ({
        step: i + 1,
        text: t.trim().slice(0, 300),
      }))
      .slice(0, 15);
    const nRaw = typeof s.nutrition === "object" && s.nutrition !== null ? s.nutrition : {};
    // magnitude clamps (security review 2026-08-09): a special's macros land
    // in a stored bank recipe and feed macro math app-wide — a claimed 1e300
    // kcal must die here, same rule as validateTailor's portionGrams clamp
    const clampN = (/** @type {number | null} */ v, /** @type {number} */ max) =>
      v === null ? null : Math.min(max, v);
    const nutrition = {
      calories: clampN(num(nRaw.calories), 5000),
      protein: clampN(num(nRaw.protein), 500),
      carbs: clampN(num(nRaw.carbs), 500),
      fat: clampN(num(nRaw.fat), 500),
    };
    /** @type {Record<string, number>} */
    const foodGroups = {};
    const fgRaw = typeof s.foodGroups === "object" && s.foodGroups !== null ? s.foodGroups : {};
    for (const key of FOOD_GROUP_KEYS) {
      const v = num(fgRaw[key]);
      if (v !== null && v > 0) foodGroups[key] = Math.min(4, v);
    }
    const ok =
      name &&
      servings !== null &&
      servings >= 1 &&
      servings <= 10 &&
      ingredients.length >= 2 &&
      instructions.length >= 2 &&
      Object.values(nutrition).every((v) => v !== null && v >= 0);
    if (ok) {
      special = {
        name,
        description: str(s.description, 200),
        servings: Math.round(/** @type {number} */ (servings)),
        totalTime: Math.max(5, Math.round(num(s.totalTime) ?? 30)),
        ingredients,
        instructions,
        nutrition: { ...nutrition, method: "estimated" },
        foodGroups: { ...foodGroups, method: "estimated" },
      };
    }
  }

  if (!candidateIds.includes(pick) && !special) return null;

  const plates = (Array.isArray(input.plates) ? input.plates : [])
    .filter(
      (/** @type {any} */ p) => typeof p === "object" && p !== null && allowedPeople.has(p.id),
    )
    .map((/** @type {any} */ p) => ({
      id: /** @type {string} */ (p.id),
      note: str(p.note, 160),
      // clamped like the special's macros: these land in stored tailor seats
      estCalories: Math.min(6000, Math.max(0, Math.round(num(p.estCalories) ?? 0))),
      estProtein: Math.min(500, Math.max(0, Math.round(num(p.estProtein) ?? 0))),
    }))
    .slice(0, 8);

  return {
    pickRecipeId: candidateIds.includes(pick) ? pick : "",
    special,
    plates,
    why: str(input.why, 400),
  };
}

// ---- /dinnerweek: one call → a tailored shared meal for every requested
// date+slot (David, 2026-08-09: the whole house eats the SAME three cooked
// meals a day; goals survive through per-person portioning, not separate
// cooking; snacks and smoothies stay personal and are never planned here) --

/** the slots a household cooks together; snacks/smoothies stay personal */
export const WEEK_MEAL_SLOTS = ["breakfast", "lunch", "dinner"];

const DINNER_WEEK_TOOL = {
  name: "record_dinner_week",
  description:
    "Record the settled meal plan: exactly ONE meal per requested date+slot. " +
    "Each meal either picks a candidate recipe (pickRecipeId) or invents a " +
    "special meal (special). Never both for the same meal.",
  input_schema: {
    type: "object",
    properties: {
      nights: {
        type: "array",
        description: "one entry per requested date+slot, none skipped",
        items: {
          type: "object",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD, one of the requested dates" },
            slot: { type: "string", enum: WEEK_MEAL_SLOTS },
            pickRecipeId: {
              type: "string",
              description: "the chosen candidate recipe id, or '' when proposing a special meal",
            },
            special: SPECIAL_SCHEMA,
            plates: PLATES_SCHEMA,
            why: { type: "string", description: "one sentence: why this dish for these people" },
          },
          required: ["date", "slot", "pickRecipeId", "plates", "why"],
        },
      },
    },
    required: ["nights"],
  },
};

const DINNER_WEEK_SYSTEM =
  "You plan a household's SHARED meals, several days in one go, for a meal " +
  "planning app. The house cooks each planned slot ONCE and everyone eats " +
  "the same food; each person's goal, daily calorie and protein targets, " +
  "diet and never-serve list are met through STRICT per-person portioning " +
  "and small plate modifications, never separate cooking. The household " +
  "may name a cuisine or theme to lean into. For EACH requested date+slot " +
  "pick the meal that best serves these specific people together: " +
  "strongly prefer the candidate recipe list (the household already shops " +
  "and cooks these; match the slot — breakfast recipes at breakfast); " +
  "invent a special meal ONLY when no candidate honestly fits, keeping it " +
  "cheap, whole-food-forward and weeknight-simple — and invent at most " +
  "THREE specials per run, the rest must come from candidates. Vary the " +
  "week: never " +
  "the same recipe twice, vary proteins and preparations, keep breakfasts " +
  "fast, and honor the cuisine preference where it genuinely fits rather " +
  "than forcing every meal into it. Every meal carries per-person plates: " +
  "WHO eats WHAT and HOW MUCH, with weighed gram amounts (the kitchen has " +
  "a food scale) and concrete modifications toward each person's own " +
  "daily targets — extra rice for a gainer, more vegetables for someone " +
  "losing, a supplemental egg, or an omission with how the cook makes it " +
  "possible. Across a day the three plates should land each person near " +
  "their daily calories and protein, leaving room for their own personal " +
  "snacks. Respect diets and never-serve lists absolutely. No em dashes.";

/**
 * Anthropic Messages request for the whole-week shared-meal plan.
 * @param {{ meals: { date: string, slot: string }[], cuisine: string, note: string, away?: Record<string, string[]>, people: ReturnType<typeof sanitizePeople>, candidates: { id: string, name: string, calories: number, protein: number, cuisine: string, meal?: string }[], model: string }} args
 */
export function buildDinnerWeekRequest({ meals, cuisine, note, away, people, candidates, model }) {
  const who = people
    .map((p) => `[${p.id}] ${personLine(p)}${p.say ? ` | ask: "${p.say}"` : ""}`)
    .join("\n");
  const menu = candidates
    .map(
      (c) =>
        `${c.id}: ${c.name} (${c.meal ? `${c.meal}, ` : ""}${c.calories} kcal, ${c.protein}g P${c.cuisine ? `, ${c.cuisine}` : ""})`,
    )
    .join("\n");
  const attendance = Object.entries(away ?? {})
    .map(
      ([id, dates]) =>
        `[${id}] is NOT at the table on ${dates.join(", ")} — plan them no plate those days; size those days' pots for the people who ARE there`,
    )
    .join("\n");
  const ask = [
    `Meals to plan: ${meals.map((m) => `${m.date} ${m.slot}`).join(", ")}`,
    attendance ? `Attendance:\n${attendance}` : "",
    cuisine ? `Cuisine/theme preference: ${cuisine}` : "",
    note ? `Household note: ${note}` : "",
    "Plan every requested meal.",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    model,
    max_tokens: 16384,
    system: `${DINNER_WEEK_SYSTEM}\n\nPeople at the table:\n${who}\n\nCandidate recipes:\n${menu}`,
    tools: [DINNER_WEEK_TOOL],
    tool_choice: { type: "tool", name: "record_dinner_week" },
    messages: [{ role: "user", content: [{ type: "text", text: ask }] }],
  };
}

/**
 * Sanitize the week plan: one validated decision per requested date+slot, in
 * requested order. A meal the model skipped, duplicated, or fumbled (bad
 * date/slot, unknown pick, incomplete special) is simply absent — the caller
 * reports uncovered meals honestly instead of inventing food.
 * @param {Record<string, any> | null} input
 * @param {string[]} candidateIds
 * @param {string[]} personIds
 * @param {{ date: string, slot: string }[]} meals the requested date+slot pairs
 * @returns {({ date: string, slot: string } & NonNullable<ReturnType<typeof validateDinnerDecision>>)[]}
 */
export function validateDinnerWeek(input, candidateIds, personIds, meals) {
  /** @type {Map<string, { date: string, slot: string } & NonNullable<ReturnType<typeof validateDinnerDecision>>>} */
  const byKey = new Map();
  const wanted = new Set(meals.map((m) => `${m.date}|${m.slot}`));
  for (const n of Array.isArray(input?.nights) ? input.nights : []) {
    if (typeof n !== "object" || n === null) continue;
    const date = typeof n.date === "string" ? n.date.trim() : "";
    // absent slot = dinner, so the pre-slot tool shape still validates
    const slot = typeof n.slot === "string" && n.slot.trim() ? n.slot.trim() : "dinner";
    const key = `${date}|${slot}`;
    if (!wanted.has(key) || byKey.has(key)) continue;
    const decision = validateDinnerDecision(n, candidateIds, personIds);
    if (decision) byKey.set(key, { date, slot, ...decision });
  }
  return meals
    .filter((m) => byKey.has(`${m.date}|${m.slot}`))
    .map((m) => /** @type {any} */ (byKey.get(`${m.date}|${m.slot}`)));
}
// Pure schedule logic; the Worker's scheduled() handler feeds it real data
// and posts the results to ntfy. All times are America/Chicago hours.

const APP_URL = "https://janniksin.github.io/mise/";

/** meal slots the cook reminders cover, with their local reminder hour */
const MEAL_HOURS = /** @type {const} */ ([
  ["lunch", 11],
  ["smoothie", 15],
  ["snack", 15],
  ["dinner", 17],
]);

/**
 * ISO week id for a local YYYY-MM-DD (same math as app/lib/dates.js).
 * @param {string} dateIso
 * @returns {string}
 */
export function isoWeekIdOf(dateIso) {
  const [y = 0, m = 1, d = 1] = dateIso.split("-").map(Number);
  const t = new Date(y, m - 1, d);
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const isoYear = t.getFullYear();
  const jan4 = new Date(isoYear, 0, 4);
  const week1Monday = new Date(isoYear, 0, 4 - ((jan4.getDay() + 6) % 7));
  const week = 1 + Math.round((t.getTime() - week1Monday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Everything to send for ONE local hour. Honest-state rules (David,
 * 2026-07-23): cook reminders exist only when the week's groceries are
 * CONFIRMED (plan.shoppedAt, set by scanning the receipt) and the meal
 * isn't already marked cooked; a missing plan or an OUT slot sends nothing.
 * @param {{
 *   hour: number,
 *   weekday: string,
 *   dateIso: string,
 *   plan: Record<string, any> | null,
 *   shopping: Record<string, any> | null,
 *   recipeName: (id: string) => string
 * }} args weekday = "Mon".."Sun"
 * @returns {{ title: string, body: string, tags: string, priority: string, click: string }[]}
 */
export function buildNotifications({ hour, weekday, dateIso, plan, shopping, recipeName }) {
  /** @type {{ title: string, body: string, tags: string, priority: string, click: string }[]} */
  const out = [];
  const entries = Array.isArray(plan?.entries) ? plan.entries : [];
  const shopped = Boolean(plan?.shoppedAt);
  const todayEntries = (/** @type {string} */ slot) =>
    entries.filter((e) => e.date === dateIso && e.slot === slot);
  const mealLine = (/** @type {Record<string, any>} */ e) =>
    e.table
      ? String(e.freeText ?? "🍽 table")
      : e.recipeId
        ? recipeName(e.recipeId)
        : String(e.freeText ?? "");

  // the day ahead. The "Log: ..." nag retired 2026-08-09 with the in-app
  // check-in (David: personal tracking lives in Crystal now) — mornings with
  // no meals to name send nothing at all.
  if (hour === 7) {
    const brk = todayEntries("breakfast").filter((e) => !e.out);
    const dinner = todayEntries("dinner").filter((e) => !e.out);
    const lines = [];
    if (shopped && brk.length > 0) lines.push(`Breakfast: ${brk.map(mealLine).join(" · ")}`);
    if (dinner.length > 0) lines.push(`Tonight: ${dinner.map(mealLine).join(" · ")}`);
    if (lines.length > 0) {
      out.push({
        title: "The day ahead",
        body: lines.join("\n"),
        tags: "sunrise",
        priority: "default",
        click: APP_URL,
      });
    }
  }

  // cook reminders, only for confirmed-shopped weeks and uncooked meals
  for (const [slot, mealHour] of MEAL_HOURS) {
    if (hour !== mealHour) continue;
    const due = todayEntries(slot).filter(
      (e) => !e.out && !e.cookedAt && (e.table || (shopped && e.recipeId)),
    );
    if (due.length === 0) continue;
    const label = slot === "smoothie" || slot === "snack" ? "Afternoon fuel" : `Cook ${slot}`;
    // one notification per hour, meals merged (smoothie+snack share 15:00)
    const existing = out.find((n) => n.title === label);
    const body = due.map(mealLine).filter(Boolean).join(" · ");
    if (existing) {
      existing.body += ` · ${body}`;
    } else {
      out.push({
        title: label,
        body,
        tags: "cook",
        priority: "default",
        click: `${APP_URL}#/plan`,
      });
    }
  }

  // store run: Saturday nag, Sunday fallback, until the receipt confirms
  if ((weekday === "Sat" && hour === 10) || (weekday === "Sun" && hour === 12)) {
    if (!shopped) {
      const open = (shopping?.items ?? []).filter((/** @type {any} */ i) => !i.checked).length;
      if (open > 0) {
        out.push({
          title: "Store run",
          body: `${open} items on the list. Scan the receipt after — that's what unlocks cook reminders.`,
          tags: "shopping_cart",
          priority: "default",
          click: `${APP_URL}#/list`,
        });
      }
    }
  }

  // Sunday batch block
  if (weekday === "Sun" && hour === 10) {
    out.push({
      title: "Batch day",
      body: "Sunday prep: open Cook for the batch list, tick each component done as you go.",
      tags: "cooking",
      priority: "default",
      click: `${APP_URL}#/plan`,
    });
  }

  // evening catch-up: planned meals still unconfirmed. The not-logged-yet
  // nag retired with the in-app check-in (2026-08-09) — Crystal owns the
  // personal tracking now.
  if (hour === 20) {
    const uncooked = shopped
      ? entries.filter((e) => e.date === dateIso && e.recipeId && !e.out && !e.cookedAt).length
      : 0;
    if (uncooked > 0) {
      out.push({
        title: "Evening catch-up",
        body: `${uncooked} planned meal${uncooked === 1 ? "" : "s"} not marked cooked`,
        tags: "clipboard",
        priority: "default",
        click: APP_URL,
      });
    }
  }

  return out;
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
 * @param {number} [weight] window slots this request consumes (default 1);
 *   /dinnerweek passes 4 — its 16k max_tokens buys ~4x the spend of any
 *   other route, so a stolen token cannot 4x the cost ceiling for free
 * @returns {boolean} true if the request may proceed
 */
export function allowRequest(state, key, now, weight = 1) {
  const cur = state.get(key);
  if (!cur || now - cur.windowStart >= RATE_WINDOW_MS) {
    state.set(key, { count: weight, windowStart: now });
    return true;
  }
  cur.count += weight;
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
  const req = [
    input.sex,
    input.age,
    input.heightFt,
    input.heightIn,
    input.weightLb,
    input.activity,
    input.goal,
  ];
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
    diet: ["omnivore", "pescatarian", "vegetarian", "vegan"].includes(input.diet)
      ? input.diet
      : "omnivore",
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
    const price =
      typeof it.price === "number" && it.price > 0 ? Math.round(it.price * 100) / 100 : 0;
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

// ---- Apple Health vitals ingest ------------------------------------------
// Health Auto Export (healthyapps.dev) posts HealthKit data straight to a REST
// endpoint on a schedule. That replaces the 14-action Apple Shortcut this
// project originally specced: no Shortcuts app, no PAT on the phone clipboard,
// and a scheduled app export does not silently fail the way a locked-phone
// automation can.
//
// Its payload is {"data":{"metrics":[{name, units, data:[{date, qty}]}]}}.
// The exact metric NAMES are the one thing not verified against a live export,
// so nothing here fails silently: unrecognised metric names are collected and
// echoed back in the response, which turns the first real post into the
// documentation. Fix the map below from that response, do not guess twice.

/**
 * normalise a metric name for matching: lowercase, alphanumerics only
 * @param {unknown} name
 */
function metricKey(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * HealthKit metric name (normalised) -> the vitals.json field it feeds
 * @type {Record<string, string>}
 */
const METRIC_FIELD = {
  stepcount: "steps",
  steps: "steps",
  walkingrunningdistance: "distanceMi",
  distancewalkingrunning: "distanceMi",
  activeenergy: "activeKcal",
  activeenergyburned: "activeKcal",
  restingheartrate: "restingHR",
  heartratevariability: "hrvMs",
  heartratevariabilitysdnn: "hrvMs",
  sleepanalysis: "sleepHours",
  vo2max: "vo2max",
};

/**
 * how many decimals each field is stored with
 * @type {Record<string, number>}
 */
const FIELD_ROUND = {
  steps: 0,
  distanceMi: 1,
  activeKcal: 0,
  restingHR: 0,
  hrvMs: 1,
  sleepHours: 1,
  vo2max: 1,
};

/**
 * Convert a raw quantity into the unit vitals.json stores. Health Auto Export
 * reports in the phone's locale units, so a device set to metric would
 * otherwise write kilometres into a field the dashboard labels miles.
 * @param {string} field
 * @param {number} qty
 * @param {string} units
 */
function toStoredUnit(field, qty, units) {
  const u = String(units ?? "").toLowerCase();
  if (field === "distanceMi") {
    if (u.includes("km")) return qty * 0.621371;
    if (u === "m" || u.includes("meter")) return qty * 0.000621371;
  }
  if (field === "activeKcal" && u.includes("kj")) return qty / 4.184;
  if (field === "sleepHours" && (u.includes("min") || u.includes("sec"))) {
    return u.includes("sec") ? qty / 3600 : qty / 60;
  }
  return qty;
}

/**
 * Sleep entries are not a single quantity: Health Auto Export reports the
 * stages separately. Prefer an explicit total, else asleep, else the sum of
 * the asleep stages. inBed and awake are deliberately excluded, because time
 * in bed is not sleep and counting it inflates every downstream number.
 * @param {Record<string, any>} entry
 * @returns {number | null}
 */
function sleepHoursFrom(entry) {
  for (const k of ["totalsleep", "asleep"]) {
    const hit = Object.keys(entry).find((key) => metricKey(key) === k);
    if (hit && typeof entry[hit] === "number") return entry[hit];
  }
  const stages = ["deep", "core", "rem", "light"];
  let sum = 0;
  let found = false;
  for (const key of Object.keys(entry)) {
    if (stages.includes(metricKey(key)) && typeof entry[key] === "number") {
      sum += entry[key];
      found = true;
    }
  }
  return found ? sum : null;
}

/**
 * Parse a Health Auto Export payload (or a plain {days:[...]} body) into
 * vitals.json day rows.
 * @param {Record<string, any> | null} body
 * @returns {{ days: Record<string, any>[], recognized: string[], ignored: string[] }}
 */
export function parseHealthExport(body) {
  /** @type {string[]} */
  const ignored = [];
  /** @type {string[]} */
  const recognized = [];
  /** @type {Record<string, Record<string, any>>} */
  const byDate = {};

  /**
   * @param {string} date
   * @param {string} field
   * @param {number} value
   */
  const put = (date, field, value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value)) return;
    const decimals = FIELD_ROUND[field] ?? 1;
    const rounded = Number(value.toFixed(decimals));
    if (rounded <= 0) return; // a zero-step day is a phone left at home, not data
    byDate[date] = byDate[date] ?? { date };
    byDate[date][field] = rounded;
  };

  // Direct shape: {days:[{date, steps, ...}]} or a single {date, ...}.
  // Kept because it makes this endpoint testable with curl and gives a manual
  // fallback if the app is ever uninstalled.
  const direct = Array.isArray(body?.days) ? body.days : body?.date ? [body] : null;
  if (direct) {
    for (const row of direct) {
      const date = String(row?.date ?? "").slice(0, 10);
      for (const [field, decimals] of Object.entries(FIELD_ROUND)) {
        void decimals;
        if (typeof row?.[field] === "number") put(date, field, row[field]);
      }
    }
    return {
      days: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)),
      recognized,
      ignored,
    };
  }

  const metrics = body?.data?.metrics ?? body?.metrics ?? [];
  if (!Array.isArray(metrics)) return { days: [], recognized, ignored };

  for (const metric of metrics) {
    const field = METRIC_FIELD[metricKey(metric?.name)];
    if (!field) {
      const raw = String(metric?.name ?? "?");
      if (!ignored.includes(raw)) ignored.push(raw);
      continue;
    }
    if (!recognized.includes(field)) recognized.push(field);
    for (const entry of Array.isArray(metric?.data) ? metric.data : []) {
      const date = String(entry?.date ?? "").slice(0, 10);
      const raw =
        field === "sleepHours"
          ? sleepHoursFrom(entry)
          : typeof entry?.qty === "number"
            ? entry.qty
            : typeof entry?.Avg === "number"
              ? entry.Avg
              : typeof entry?.avg === "number"
                ? entry.avg
                : null;
      if (raw === null) continue;
      put(date, field, toStoredUnit(field, raw, metric?.units));
    }
  }
  return {
    days: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)),
    recognized,
    ignored,
  };
}

/**
 * Upsert incoming days into the stored day list, newest data winning per
 * FIELD (not per row), so a partial re-post never blanks a field an earlier
 * post already filled. Sorted oldest-first, which is how the dashboard reads.
 * @param {Record<string, any>[]} existing
 * @param {Record<string, any>[]} incoming
 */
export function mergeVitalsDays(existing, incoming) {
  /** @type {Record<string, Record<string, any>>} */
  const byDate = {};
  for (const row of Array.isArray(existing) ? existing : []) {
    const date = String(row?.date ?? "").slice(0, 10);
    if (date) byDate[date] = { ...row, date };
  }
  for (const row of Array.isArray(incoming) ? incoming : []) {
    const date = String(row?.date ?? "").slice(0, 10);
    if (!date) continue;
    byDate[date] = { ...(byDate[date] ?? {}), ...row, date };
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// /ask — the general in-app question box (David, 2026-08-03: "I need a chat
// so I can ask questions on the app where all of the context is"). Freeform
// text answers grounded in a compact client-composed snapshot of the
// household's live state. No tools, no writes: it explains, it never edits.

const ASK_SYSTEM =
  "You are Mise's kitchen assistant, answering questions inside a family " +
  "meal-planning app. You get a JSON snapshot of the asker's live state: " +
  "their targets, today's meals, the week's family dinners with cooks and " +
  "buyers, the kitchen inventory, and their shopping list. Ground answers " +
  "in that snapshot; when it lacks the answer, say so plainly instead of " +
  "guessing. Cooking questions (methods, temperatures, substitutions, how " +
  "to batch-cook a component) deserve concrete, practical answers with " +
  "real times and temperatures. Keep answers short: a few sentences, or a " +
  "tight list of steps when asked how to cook something. Plain words, no " +
  "headers. You never give medical or supplement-dosing advice — for " +
  "health questions, point at a clinician. You cannot change the app's " +
  "data; when asked to change something, say which button in the app does " +
  "it if the snapshot makes that clear.";

/**
 * Clamp the client-composed context snapshot to a bounded, string-safe
 * shape. The client is trusted-ish (PAT-gated) but a poisoned field must
 * cap at annoying, never at expensive.
 * @param {any} raw
 * @returns {Record<string, any>}
 */
export function sanitizeAskContext(raw) {
  if (typeof raw !== "object" || raw === null) return {};
  const s = (/** @type {any} */ v, /** @type {number} */ n) =>
    typeof v === "string" ? v.slice(0, n) : undefined;
  const list = (/** @type {any} */ v, /** @type {number} */ cap, /** @type {number} */ len) =>
    Array.isArray(v)
      ? v
          .slice(0, cap)
          .map((x) => (typeof x === "string" ? x.slice(0, len) : ""))
          .filter(Boolean)
      : [];
  return {
    name: s(raw.name, 40),
    phase: s(raw.phase, 20),
    targets: s(raw.targets, 120),
    today: list(raw.today, 12, 120),
    dinners: list(raw.dinners, 10, 160),
    kitchen: list(raw.kitchen, 60, 80),
    list: list(raw.list, 40, 80),
    notes: s(raw.notes, 200),
  };
}

/**
 * @param {{ messages: { role: string, content: string }[], context: Record<string, any>, model: string }} args
 */
export function buildAskRequest({ messages, context, model }) {
  const system = `${ASK_SYSTEM}\n\nLive snapshot:\n${JSON.stringify(context)}`;
  return {
    model,
    max_tokens: 1024,
    system,
    messages: messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text: String(m.content ?? "").slice(0, 4000) }],
    })),
  };
}

/**
 * @param {any} resp
 * @returns {{ reply: string }}
 */
export function parseAskResponse(resp) {
  const blocks = Array.isArray(resp?.content) ? resp.content : [];
  const text = blocks
    .filter((/** @type {any} */ b) => b?.type === "text" && typeof b.text === "string")
    .map((/** @type {any} */ b) => b.text)
    .join("\n")
    .trim();
  return { reply: text || "no answer came back — try asking again" };
}
