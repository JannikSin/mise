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
            plate: {
              type: "array",
              items: { type: "string" },
              description:
                "1-3 concrete plating actions for THIS person (e.g. 'add 100g extra tofu on top', 'skip the bread', 'half portion of rice')",
            },
            estCalories: { type: "number", description: "this seat's plate after adjustments" },
            estProtein: { type: "number", description: "grams protein after adjustments" },
          },
          required: ["id", "plate", "estCalories", "estProtein"],
        },
      },
      cook: {
        type: "array",
        items: { type: "string" },
        description:
          "0-3 notes for the cook so ONE pot still serves everyone (what to hold back, add late, or plate separately)",
      },
    },
    required: ["seats", "cook"],
  },
};

const TAILOR_SYSTEM =
  "You tailor ONE shared home-cooked dish to each person at the table. The " +
  "dish is cooked once; your job is per-plate adjustments at serving time " +
  "that move each plate toward that person's goal and daily targets: extra " +
  "protein or starch for a gaining lifter, lighter starch, skipped bread or " +
  "smaller portion for someone losing, respecting diets and never-serve " +
  "lists absolutely. Adjustments must be concrete kitchen actions with " +
  "amounts, achievable from the dish's own components plus ordinary pantry " +
  "staples. Cook notes keep it one pot: what to hold back, add late, or " +
  "plate separately. Honest macro estimates per adjusted plate. No em dashes.";

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
 * @returns {{ seats: Record<string, { plate: string[], estCalories: number, estProtein: number }>, cook: string[] }}
 */
export function validateTailor(input, allowedIds) {
  const strList = (/** @type {any} */ v, /** @type {number} */ cap) =>
    (Array.isArray(v) ? v : [])
      .filter((s) => typeof s === "string" && s.trim())
      .map((s) => s.trim().slice(0, 160))
      .slice(0, cap);
  /** @type {Record<string, { plate: string[], estCalories: number, estProtein: number }>} */
  const seats = {};
  const allowed = new Set(allowedIds);
  for (const s of Array.isArray(input?.seats) ? input.seats : []) {
    if (typeof s !== "object" || s === null) continue;
    if (typeof s.id !== "string" || !allowed.has(s.id) || seats[s.id]) continue;
    const plate = strList(s.plate, 3);
    if (plate.length === 0) continue;
    seats[s.id] = {
      plate,
      estCalories:
        typeof s.estCalories === "number" && isFinite(s.estCalories)
          ? Math.round(s.estCalories)
          : 0,
      estProtein:
        typeof s.estProtein === "number" && isFinite(s.estProtein) ? Math.round(s.estProtein) : 0,
    };
  }
  return { seats, cook: strList(input?.cook, 3) };
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
 * Refuse a special meal whose ingredients hit ANY participant's avoid list.
 * Returns the refusal reasons ("Mom: cilantro"), empty = clean.
 * @param {{ ingredients: { food: string }[] }} special
 * @param {{ name: string, avoid: string[] }[]} people
 * @returns {string[]}
 */
export function specialAvoidHits(special, people) {
  const foods = (special.ingredients ?? []).map((i) => i.food).join(", ");
  const out = [];
  for (const p of people) {
    const hits = hitsAvoid(foods, p.avoid);
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
      special: {
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
      },
      plates: {
        type: "array",
        description: "per-person plate note for the chosen dinner",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "the person's profile id, exactly as given" },
            note: {
              type: "string",
              description: "one concrete plating adjustment for them, '' if none",
            },
            estCalories: { type: "number" },
            estProtein: { type: "number" },
          },
          required: ["id", "note", "estCalories", "estProtein"],
        },
      },
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
    const nutrition = {
      calories: num(nRaw.calories),
      protein: num(nRaw.protein),
      carbs: num(nRaw.carbs),
      fat: num(nRaw.fat),
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
      estCalories: Math.round(num(p.estCalories) ?? 0),
      estProtein: Math.round(num(p.estProtein) ?? 0),
    }))
    .slice(0, 8);

  return {
    pickRecipeId: candidateIds.includes(pick) ? pick : "",
    special,
    plates,
    why: str(input.why, 400),
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
