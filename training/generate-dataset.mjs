// Mise-dialect training-set generator (see training/README.md).
// Reads the PUBLIC seed recipes, emits chat-format JSONL for mlx_lm.lora:
// extraction (T2), exact-math recipe rescaling (T3), diet classification
// replicating app/lib/plan.js dietOf (T4), tool-call traces (T5), and folds
// in the hand-written schema cards (T1/T6). Deterministic: same inputs,
// same split (FNV-1a hash of example id picks train vs valid).
//
//   node training/generate-dataset.mjs
//
// Dev-tooling only; nothing here ships in the app.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECIPES_DIR = join(root, "seed-data", "generated", "recipes");
const OUT_DIR = join(root, "training", "data");

const SYSTEM =
  "You are the Mise assistant. Mise is an offline-first meal-planner PWA: weekly plans " +
  "(plans/<week>.json with stacking entries, pinned/out flags, a buffer snack), a recipe bank " +
  "(per-serving nutrition, staple-flagged ingredients, Daily Dozen foodGroups), a pantry with " +
  "shelf-life auto-expiry, and a derived shopping list. You navigate, extract, and fill in app " +
  "data; you never edit the app's code. Never invent nutrition numbers: values you cannot " +
  "compute from given data need re-estimation or a greger_audit tool call. To use a tool, " +
  'reply with exactly one fenced json block: {"tool": <name>, "args": {...}}.';

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const round2 = (n) => Math.round(n * 100) / 100;

// mirror of app/lib/plan.js dietOf (keep in sync — T4 trains the model on
// the app's ACTUAL rules, not generic diet folklore)
const DIET_KEYWORDS = {
  meat: ["chicken", "beef", "turkey", "pork", "lamb", "kofta", "sausage", "bacon", "ham", "prosciutto", "veal", "duck", "bulgogi", "meatball"],
  fish: ["salmon", "tuna", "cod", "shrimp", "anchovy", "dashi", "sardine", "mackerel", "crab", "prawn", "fish sauce", "tilapia", "halibut", "trout"],
  dairy: ["milk", "yogurt", "cheese", "whey", "butter", "feta", "halloumi", "cottage", "parmesan", "cream", "kefir", "ghee"],
  egg: ["egg"],
};
function dietOf(recipe) {
  const tag = (recipe.tags ?? []).find((t) => ["vegan", "vegetarian", "pescatarian"].includes(t));
  if (tag) return { diet: tag, why: `carries the ${tag} tag` };
  const foods = (recipe.ingredients ?? [])
    .filter((i) => !i.optional)
    .map((i) => String(i.food ?? "").toLowerCase());
  const has = (list) => foods.some((f) => list.some((k) => f.includes(k)));
  if (has(DIET_KEYWORDS.meat)) return { diet: "omnivore", why: "a non-optional ingredient is meat" };
  if (has(DIET_KEYWORDS.fish)) return { diet: "pescatarian", why: "fish/seafood present, no meat" };
  if (has(DIET_KEYWORDS.dairy) || has(DIET_KEYWORDS.egg))
    return { diet: "vegetarian", why: "dairy or egg present, no meat or fish" };
  return { diet: "vegan", why: "no meat, fish, dairy, or egg in non-optional ingredients" };
}

const recipes = readdirSync(RECIPES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(RECIPES_DIR, f), "utf8")));

/** @type {{ id: string, messages: any[] }[]} */
const examples = [];
const ex = (id, user, assistant) =>
  examples.push({
    id,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
      { role: "assistant", content: assistant },
    ],
  });

for (const r of recipes) {
  const n = r.nutrition ?? {};

  // T2 extraction: macros, honest per-serving framing
  ex(
    `extract-macros|${r.id}`,
    `How much protein is in ${r.name}?`,
    `${n.protein}g protein per serving (${n.calories} kcal, ${n.carbs}g carbs, ${n.fat}g fat). The recipe makes ${r.servings} servings; values are per serving and method is "${n.method}".`,
  );

  // T2 extraction: shopping-relevant ingredients (matches deriveShoppingList's staple rule)
  const shop = (r.ingredients ?? []).filter((i) => !i.staple);
  const staples = (r.ingredients ?? []).filter((i) => i.staple);
  ex(
    `extract-shop|${r.id}`,
    `Which ingredients of ${r.name} would land on the shopping list?`,
    `${shop.map((i) => `${i.qty} ${i.unit} ${i.food}`).join(", ")}.` +
      (staples.length > 0
        ? ` The staples (${staples.map((i) => i.food).join(", ")}) are assumed on hand and never shopped.`
        : " It has no staple-flagged ingredients."),
  );

  // T3 exact-math rescale: full JSON back, no dropped fields
  const target = r.servings === 2 ? 5 : 2;
  const factor = target / (r.servings || 1);
  const rescaled = {
    ...r,
    servings: target,
    ingredients: (r.ingredients ?? []).map((i) => ({ ...i, qty: round2(i.qty * factor) })),
  };
  ex(
    `rescale|${r.id}`,
    `Rescale ${r.name} from ${r.servings} to ${target} servings and give me the full corrected recipe JSON.`,
    "Scaled every ingredient by " +
      `${target}/${r.servings}; per-serving nutrition is unchanged by rescaling.\n\`\`\`json\n${JSON.stringify(rescaled, null, 2)}\n\`\`\``,
  );

  // T4 diet classification per app rules
  const d = dietOf(r);
  ex(
    `diet|${r.id}`,
    `Classify the dietary pattern of ${r.name} per Mise's rules.`,
    `${d.diet} — ${d.why}. (Mise's classifier: a vegan/vegetarian/pescatarian tag wins; otherwise non-optional ingredients decide, meat > fish > dairy/egg > vegan, and optional ingredients never disqualify.)`,
  );

  // T5 tool trace: plan it
  const slotDate = { breakfast: "2026-08-03", lunch: "2026-08-04", dinner: "2026-08-05", smoothie: "2026-08-03", snack: "2026-08-06" }[r.mealType] ?? "2026-08-05";
  ex(
    `tool-add|${r.id}`,
    `Put ${r.name.toLowerCase()} on the plan for ${slotDate}.`,
    `\`\`\`json\n${JSON.stringify({ tool: "add_to_plan", args: { week: "2026-W32", date: slotDate, slot: r.mealType, recipeId: r.id, servings: 1 } })}\n\`\`\``,
  );
}

// T5 non-recipe tool traces + T2 plan Q&A on synthetic plans
const dinnerPool = recipes.filter((r) => r.mealType === "dinner").slice(0, 12);
dinnerPool.forEach((r, i) => {
  const date = `2026-08-${String(10 + (i % 7)).padStart(2, "0")}`;
  ex(
    `tool-out|${r.id}`,
    `We're going to a restaurant on ${date}, skip that night's dinner.`,
    `\`\`\`json\n${JSON.stringify({ tool: "toggle_slot_out", args: { week: "2026-W33", date, slot: "dinner" } })}\n\`\`\``,
  );
  const other = dinnerPool[(i + 1) % dinnerPool.length];
  const plan = {
    week: "2026-W33",
    entries: [
      { id: "a1", date, slot: "dinner", recipeId: r.id, servings: 1.5 },
      { id: "a2", date, slot: "lunch", recipeId: other.id, servings: 1 },
      { id: "a3", date, slot: "snack", freeText: "leftovers", servings: 1 },
    ],
  };
  const cal = round2((r.nutrition?.calories ?? 0) * 1.5 + (other.nutrition?.calories ?? 0));
  const pro = round2((r.nutrition?.protein ?? 0) * 1.5 + (other.nutrition?.protein ?? 0));
  ex(
    `plan-qa|${r.id}`,
    `Given this plan JSON, what are the planned calories and protein for ${date}?\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\nRecipes: ${r.id} = ${r.nutrition?.calories} kcal / ${r.nutrition?.protein}g P per serving; ${other.id} = ${other.nutrition?.calories} kcal / ${other.nutrition?.protein}g P per serving.`,
    `${cal} kcal and ${pro}g protein: ${r.id} at 1.5 servings (${round2((r.nutrition?.calories ?? 0) * 1.5)} kcal, ${round2((r.nutrition?.protein ?? 0) * 1.5)}g) plus ${other.id} at 1 serving. The freeText "leftovers" entry counts 0 — only recipe entries and eating-out credits carry macros.`,
  );
});

// fold in hand-written schema cards (T1/T6)
const cards = readFileSync(join(root, "training", "schema-cards.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line, i) => {
    const parsed = JSON.parse(line);
    return {
      id: `card|${i}`,
      messages: [{ role: "system", content: SYSTEM }, ...parsed.messages],
    };
  });
examples.push(...cards);

// deterministic ~90/10 split by id hash; cards always train (too few to split)
const train = [];
const valid = [];
for (const e of examples) {
  const bucket = e.id.startsWith("card|") ? 0 : hash(e.id) % 10;
  (bucket === 9 ? valid : train).push(e);
}
const toJsonl = (list) => list.map((e) => JSON.stringify({ messages: e.messages })).join("\n") + "\n";
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "train.jsonl"), toJsonl(train));
writeFileSync(join(OUT_DIR, "valid.jsonl"), toJsonl(valid));
console.log(`recipes: ${recipes.length} · examples: ${examples.length} (train ${train.length} / valid ${valid.length})`);
