// THE TWO SUNDAY POTS (David, 2026-10-25: "Sunday he cooks TWO separate
// recipes: meal A eaten Sun and Mon; meal B for Tue, Wed, Thu, fully prepped
// Sunday ... EXCEPT the meat ... beef is made day of to make sure it is still
// fresh"). This module holds the facts about meal B that are not planning:
// which dishes can be cooked that way, how much meat each night cooks, which
// recipe steps are Sunday's and which are the night's, and the food-safety
// lines the cards print. The planner (compose.js) decides the week; the
// screens read these.
//
// FOOD SAFETY, every number verified 2026-10-25 against the government
// charts (the direct pages refused this machine, so the figures were read
// from the FoodSafety.gov chart text and USDA reprints):
//  - raw ground meat and poultry: 1 to 2 days in the fridge (FoodSafety.gov
//    Cold Food Storage Chart, https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts),
//    so meat bought Sunday is cooked by Tuesday, and with the meat cooked each
//    night, Wednesday's and Thursday's goes in the freezer on Sunday;
//  - ground meat thawed in the fridge: cook within 1 to 2 days, and about a
//    day to thaw a pound (USDA, via https://food.unl.edu/article/how-thaw-meat-and-poultry-safely),
//    so it moves to the fridge the night before;
//  - cooked food in the fridge within 2 hours, in shallow containers, keeps
//    3 to 4 days (USDA FSIS Leftovers and Food Safety,
//    https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation/food-safety-basics/leftovers-and-food-safety);
//    cooked rice ideally within 1 hour, spread shallow (Bacillus cereus
//    spores survive cooking; NHS advice). Thursday is day 4, the edge, so
//    Thursday's rice or noodles go in the freezer on Sunday too;
//  - cooked meat keeps 3 to 4 days in the fridge (the same chart), so meat
//    cooked Tuesday is good through Thursday;
//  - reheat leftovers to 165 F; ground meat 160 F, ground poultry 165 F
//    (FoodSafety.gov Safe Minimum Internal Temperatures,
//    https://www.foodsafety.gov/food-safety-charts/safe-minimum-internal-temperatures).
import { partOf } from "./synth.js";
import { proteinClassOf } from "./foodclass.js";

/** protein-part foods that are "the rest", not the meat: cheese, yogurt and friends hold like the rest of the dish */
const DAIRY =
  /\b(yogurt|cottage cheese|cheese|skyr|kefir|feta|mozzarella|halloumi|paneer|ricotta|parmesan|whey)\b/;
/** proteins that cook from raw in about 15 to 20 minutes whatever the cut */
const FAST_ANY = /\b(ground|minced?|shrimp|prawns?|eggs?|tofu|tempeh|edamame)\b/;
/** whole-muscle meat is fast only when cut small or thin */
const FAST_CUT = /\b(slic\w*|thin\w*|cub\w*|dic\w*|strips?|pieces?|chunks?|bite|pounded|cut)\b/;
/** never day-of: slow cuts, precooked meat, a whole bird, a fillet of fish */
/** braising cuts: slow unless sliced thin (gyudon's chuck) */
const SLOW_CUT = /\b(shoulder|butt|chuck|stew meat)\b/;
const SLOW =
  /\b(left whole|whole bird|rotisserie|cheeks?|shank|brisket|roast|bone-in|poached|shredded|batch-cooked|sunday[- ]batch|cooked|fillets?)\b/;
/** dishes where the meat cooks INTO the rest (baked, simmered for hours): there is no "rest" to prep without it */
const BAKED_IN =
  /\b(dump-and-bake|casserole|sunday-bake|shepherd|lasagn\w*|bake|sheet-pan|slow[- ]cooker|braise\w*)\b/;

/**
 * The meat rows meal B cooks fresh each night, or null when the dish cannot
 * be cooked that way. A recipe's own `freshProtein` (true or false) wins;
 * otherwise it is DERIVED: every non-optional protein row (synth.js partOf,
 * dairy excluded, those hold like the rest) must cook from raw in about 15 to
 * 20 minutes, the dish must not bake or braise the meat into the rest, and
 * the rest must keep at least 3 days. Fish fillets are out (they keep 1 to 2
 * days raw, like ground meat, but are not on David's list); shrimp is in.
 * @param {Record<string, any> | null | undefined} recipe
 * @returns {Record<string, any>[] | null}
 */
export function freshProteinRows(recipe) {
  if (!recipe || recipe.mealType !== "dinner") return null;
  const rows = (recipe.ingredients ?? []).filter(
    (/** @type {any} */ i) =>
      i &&
      !i.optional &&
      partOf(i) === "protein" &&
      proteinClassOf(i.food) !== null &&
      // "eggplant" reads as egg to both keyword lists; it is a vegetable
      !/eggplant/i.test(String(i.food ?? "")) &&
      !DAIRY.test(String(i.food ?? "").toLowerCase()),
  );
  if (recipe.freshProtein === false || rows.length === 0) return null;
  if (recipe.freshProtein === true) return rows;
  const words = `${String(recipe.name ?? "")} ${(recipe.tags ?? []).join(" ")}`.toLowerCase();
  if (BAKED_IN.test(words)) return null;
  if (!(Number(recipe.safeDays) >= 3)) return null;
  for (const r of rows) {
    const text = `${String(r.food ?? "")} ${String(r.note ?? "")}`.toLowerCase();
    if (SLOW.test(text)) return null;
    if (SLOW_CUT.test(text) && !/\bthin\w*/.test(text)) return null;
    if (FAST_ANY.test(text)) continue;
    if (proteinClassOf(r.food) === "fish") return null;
    if (!FAST_CUT.test(text)) return null;
  }
  return rows;
}

/**
 * @param {Record<string, any> | null | undefined} recipe
 * @returns {boolean}
 */
export function freshProteinOk(recipe) {
  return freshProteinRows(recipe) !== null;
}

/**
 * The meat one night cooks: each fresh row scaled from the recipe's servings
 * to the night's plates. Grams round to 5; everything else to a quarter.
 * @param {Record<string, any> | null | undefined} recipe
 * @param {number} servings the night's plates, every seat summed
 * @returns {{ food: string, qty: number, unit: string }[]}
 */
export function freshMeatFor(recipe, servings) {
  const rows = freshProteinRows(recipe) ?? [];
  const per = Number(recipe?.servings) > 0 ? Number(recipe?.servings) : 1;
  const k = Math.max(0, Number(servings) || 0) / per;
  return rows.map((r) => {
    const unit = String(r.unit ?? "");
    const raw = Number(r.qty ?? 0) * k;
    const qty = unit === "g" || unit === "ml" ? Math.round(raw / 5) * 5 : Math.round(raw * 4) / 4;
    return { food: String(r.food ?? ""), qty, unit };
  });
}

/**
 * "340 g ground beef", "2 egg": one plain phrase per row.
 * @param {{ food: string, qty: number, unit: string }[]} meat
 * @returns {string}
 */
export function meatPhrase(meat) {
  return meat
    .map((m) => {
      const unit = m.unit && m.unit !== "unit" ? ` ${m.unit}` : "";
      return `${m.qty}${unit} ${m.food}`;
    })
    .join(" and ");
}

/**
 * Split the recipe's steps: Sunday does every step that does not touch the
 * meat; the night does the rest. A step naming a fresh row's food (its main
 * word, "beef" for "ground beef") is the night's.
 * @param {Record<string, any> | null | undefined} recipe
 * @returns {{ sunday: string[], night: string[] }}
 */
export function splitSteps(recipe) {
  const rows = freshProteinRows(recipe) ?? [];
  const words = new Set(
    rows.flatMap((r) => [
      // the class word too: "flank steak" steps say "beef"
      ...(proteinClassOf(r.food) && proteinClassOf(r.food) !== "plant"
        ? [String(proteinClassOf(r.food))]
        : []),
      ...String(r.food ?? "")
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter(
          (w) =>
            w.length > 2 &&
            ![
              "ground",
              "raw",
              "lean",
              "boneless",
              "skinless",
              "large",
              "extra",
              "firm",
              "shelled",
            ].includes(w),
        ),
    ]),
  );
  /** @type {string[]} */
  const sunday = [];
  /** @type {string[]} */
  const night = [];
  for (const s of recipe?.instructions ?? []) {
    const text = String(typeof s === "string" ? s : (s?.text ?? "")).trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    const touchesMeat = [...words].some((w) => new RegExp(`\\b${w}`).test(lower));
    (touchesMeat ? night : sunday).push(text);
  }
  return { sunday, night };
}

/** the cook temperature for a fresh row: ground meat 160 F, poultry and the rest 165 F, shrimp until opaque */
function doneLine(/** @type {{ food: string }[]} */ meat) {
  const foods = meat.map((m) => m.food.toLowerCase());
  if (foods.some((f) => /chicken|turkey/.test(f))) return "Cook it to 165 F.";
  if (foods.some((f) => /ground/.test(f))) return "Cook it to 160 F.";
  if (foods.some((f) => /beef|pork|steak/.test(f))) return "Cook it to 145 F, or 160 F if ground.";
  if (foods.some((f) => /shrimp|prawn/.test(f))) return "Cook until pink and opaque.";
  if (foods.some((f) => /egg/.test(f))) return "Cook until the eggs are set.";
  return "";
}

/**
 * Sunday's lines for meal B: what to prep, what to buy and where it goes.
 * @param {string[]} nightNames the nights B feeds, in order ("Tue", "Wed", "Thu")
 * @param {boolean} once the meat is cooked once, on the first night, for all of them
 * @returns {string[]}
 */
export function freshSundayLines(nightNames, once) {
  const first = nightNames[0] ?? "";
  const later = nightNames.slice(1);
  const last = nightNames[nightNames.length - 1];
  return [
    "Prep everything except the meat today: the rice or noodles, the vegetables, the sauce.",
    once || later.length === 0
      ? `Buy the meat today and keep it in the fridge for ${first}. If it was bought before Sunday, freeze it and move it to the fridge ${dayBefore(first)} night.`
      : `Buy the meat today. Fridge ${first}'s portion; freeze ${later.join(" and ")}'s now.`,
    "Cool it fast: in the fridge within 2 hours, rice within 1 hour, spread shallow.",
    ...(nightNames.length >= 3
      ? [`Freeze ${last}'s rice or noodles too; ${last} is day 4, the limit.`]
      : []),
  ];
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Tue" -> "Monday" */
function dayBefore(/** @type {string} */ name) {
  const i = DAYS.indexOf(name);
  const full = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return i < 0 ? "the" : (full[(i + 6) % 7] ?? "the");
}

/**
 * One meal B night's lines.
 *  - meat each day: cook this night's share, reheat the rest, and move the
 *    next night's meat (and the last night's rice) to the fridge;
 *  - meat once: the first night cooks it all and puts the later shares in
 *    the fridge; a later night reheats everything.
 * @param {{
 *   meat: { food: string, qty: number, unit: string }[],
 *   once: boolean,
 *   first: boolean,
 *   laterNames?: string[],
 *   tomorrow?: string | null,
 *   tomorrowIsLast?: boolean,
 * }} o `meat` = what THIS night cooks (all of it, on a once-first night)
 * @returns {string[]}
 */
export function freshNightLines(o) {
  const done = doneLine(o.meat);
  const move = o.tomorrow
    ? o.once
      ? o.tomorrowIsLast
        ? [`Tonight, move ${o.tomorrow}'s rice or noodles from the freezer to the fridge.`]
        : []
      : [
          `Tonight, move ${o.tomorrow}'s meat${o.tomorrowIsLast ? " and rice" : ""} from the freezer to the fridge.`,
        ]
    : [];
  if (o.once && !o.first)
    return ["Reheat the meat and the rest until steaming hot, 165 F.", ...move];
  const later = o.laterNames ?? [];
  return [
    o.once && later.length > 0
      ? `Cook all the meat tonight: ${meatPhrase(o.meat) || "the whole pack"}, for tonight, ${later.join(" and ")}, about 15 to 20 minutes.${done ? ` ${done}` : ""}`
      : `Cook the meat fresh: ${meatPhrase(o.meat) || "this night's portion"}, about 15 minutes.${done ? ` ${done}` : ""}`,
    ...(o.once && later.length > 0
      ? [`Fridge ${later.join(" and ")}'s share within 2 hours; cooked meat keeps 3 to 4 days.`]
      : []),
    "Reheat the rest from Sunday until steaming hot, 165 F.",
    ...move,
  ];
}

/**
 * The lines a meal B night's plan row prints (deriveTables stamps the entry
 * with `proteinFresh`, `freshNights` and `freshMeat`). Empty for any other row.
 * @param {Record<string, any>} entry
 * @param {(iso: string) => string} dayName "2026-11-03" -> "Tue"
 * @returns {string[]}
 */
export function mealBLines(entry, dayName) {
  const mode = entry?.proteinFresh;
  const nights = Array.isArray(entry?.freshNights) ? entry.freshNights : [];
  const i = nights.indexOf(entry?.date);
  if ((mode !== "once" && mode !== "daily") || i < 0) return [];
  const names = nights.map((/** @type {string} */ d) => dayName(d));
  return freshNightLines({
    meat: Array.isArray(entry.freshMeat) ? entry.freshMeat : [],
    once: mode === "once",
    first: i === 0,
    laterNames: names.slice(1),
    tomorrow: names[i + 1] ?? null,
    tomorrowIsLast: nights.length >= 3 && i + 1 === nights.length - 1,
  });
}

/**
 * Sunday's lines for the meal B it preps, from that pot's own plan row.
 * @param {{ proteinFresh?: string, freshNights?: string[] } | null | undefined} b
 * @param {(iso: string) => string} dayName
 * @returns {string[]}
 */
export function mealBSundayLines(b, dayName) {
  if (!b || (b.proteinFresh !== "once" && b.proteinFresh !== "daily")) return [];
  return freshSundayLines(
    (b.freshNights ?? []).map((d) => dayName(d)),
    b.proteinFresh === "once",
  );
}
