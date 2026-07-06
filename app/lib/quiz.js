// "What should I eat?" ranking (blueprint §6.1): time is a hard gate,
// purpose dominates, load and use-soon pantry items nudge, protein breaks ties.

/**
 * @typedef {{ time: number, purpose: string | null, load: "heavy" | "light" | null, useSoonFoods?: string[] }} QuizAnswers
 * @typedef {Record<string, any>} Recipe
 */

const PURPOSE_POINTS = 3;
const LOAD_POINTS = 2;
const USE_SOON_POINTS = 2;
const HEAVY_KCAL = 700;
const LIGHT_KCAL = 550;

/**
 * @param {Recipe[]} recipes
 * @param {QuizAnswers} answers
 * @returns {{ recipe: Recipe, score: number, reasons: string[] }[]}
 */
export function rankRecipes(recipes, answers) {
  const useSoon = (answers.useSoonFoods ?? []).map((f) => String(f).toLowerCase());
  return recipes
    .filter((r) => (r.totalTime ?? 0) <= answers.time)
    .map((recipe) => {
      let score = 0;
      /** @type {string[]} */
      const reasons = [`fits your ${answers.time >= 999 ? "open" : `${answers.time} min`} window`];
      if (answers.purpose && (recipe.purpose ?? []).includes(answers.purpose)) {
        score += PURPOSE_POINTS;
        reasons.push(`tagged ${answers.purpose}`);
      }
      const kcal = recipe.nutrition?.calories ?? 0;
      if (answers.load === "heavy" && kcal >= HEAVY_KCAL) {
        score += LOAD_POINTS;
        reasons.push(`substantial — ${kcal} kcal`);
      }
      if (answers.load === "light" && kcal <= LIGHT_KCAL) {
        score += LOAD_POINTS;
        reasons.push(`light — ${kcal} kcal`);
      }
      const foods = (recipe.ingredients ?? []).map((/** @type {{ food: unknown }} */ i) =>
        String(i.food).toLowerCase(),
      );
      const soonHit = useSoon.find((s) =>
        foods.some((/** @type {string} */ f) => s.includes(f) || f.includes(s)),
      );
      if (soonHit) {
        score += USE_SOON_POINTS;
        reasons.push(`uses up: ${soonHit}`);
      }
      return { recipe, score, reasons };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.recipe.nutrition?.protein ?? 0) - (a.recipe.nutrition?.protein ?? 0) ||
        String(a.recipe.name).localeCompare(String(b.recipe.name)),
    );
}
