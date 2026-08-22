// THE ENGINE HOLDS NO PHILOSOPHY (P12).
//
// A nutrition philosophy is a BUNDLE: data, living in the data repo, naming
// which facts it scores and how much each is worth. This module is the
// generic scorer that reads one. It contains no philosophy's name, no
// philosophy's numbers, and no opinion about food. Swap the bundle and the
// same code produces a different ranking; that is the whole test.
//
// Council 2026-08-22 (Greger, Attia, Phillips, Gardner, Longo, isolated) set
// the bar this has to clear, and it is deliberately falsifiable:
//
//   A second bundle counts as a second VOICE only if it RE-RANKS THE BANK:
//   Spearman rho below 0.8 across the bank, and at least 15 recipes crossing
//   the pass/fail line.
//
// Without that test you can author a bundle, satisfy P12's wording, and have
// learned nothing. `rankAgreement` below is that test, and it is what the
// promise suite asserts rather than the existence of a second file.
//
// Two seats independently made the same architectural point: philosophies
// cannot be data while the weights are constants. So every weight, floor and
// ceiling here comes from the bundle, and a bundle that names a fact this
// scorer cannot compute is REFUSED rather than silently scored as zero — the
// same discipline the bank already applies by refusing to promise a nutrient
// it cannot measure.

import {
  isAddedSugar,
  isProcessedRedMeat,
  isRefinedGrain,
  isWholeGrain,
  plantSpeciesOf,
  processingTier,
  proteinSourceOf,
} from "./foodclass.js";
import { partOf } from "./synth.js";

/**
 * Every fact a bundle is allowed to score, and how to compute it from ONE
 * recipe. Each returns a 0..1 fraction, or null when the recipe carries no
 * rows the fact applies to (a smoothie has no grains; scoring it 0 for
 * whole-grain share would punish it for not being a grain dish).
 *
 * FLAVOR ROWS ARE EXCLUDED EVERYWHERE via partOf, which P8 already debugged:
 * black pepper once read as a vegetable and beef broth as beef. A pinch of
 * cayenne must not move a food-quality score.
 * @type {Record<string, (rows: any[]) => number | null>}
 */
export const FACTS = {
  /** share of substantive rows that are whole foods (tier 0) */
  wholeFoodShare: (rows) => frac(rows, (f) => processingTier(f) === 0),

  /** share of substantive rows that are industrially formulated (tier 2) */
  formulatedShare: (rows) => frac(rows, (f) => processingTier(f) === 2),

  /** of the grain rows, how many are whole */
  wholeGrainShare: (rows) => {
    const grains = rows.filter((r) => isWholeGrain(r.food) || isRefinedGrain(r.food));
    if (grains.length === 0) return null;
    return grains.filter((r) => isWholeGrain(r.food)).length / grains.length;
  },

  /** of the protein rows, how many are plant-sourced */
  plantProteinShare: (rows) => {
    const prot = rows.filter((r) => proteinSourceOf(r.food) !== null);
    if (prot.length === 0) return null;
    return prot.filter((r) => proteinSourceOf(r.food) === "plant").length / prot.length;
  },

  /** share of substantive rows that are an added sugar */
  addedSugarShare: (rows) => frac(rows, isAddedSugar),

  /** share of substantive rows that are processed red meat */
  processedRedMeatShare: (rows) => frac(rows, isProcessedRedMeat),
};

/** @param {any[]} rows @param {(food: string) => boolean} pred */
function frac(rows, pred) {
  if (rows.length === 0) return null;
  return rows.filter((r) => pred(r.food)).length / rows.length;
}

/**
 * The rows a food-quality judgment is entitled to look at: everything the
 * plate solver calls substantive, which is everything that is not flavor.
 * @param {Record<string, any>} recipe
 */
export function substantiveRows(recipe) {
  return (recipe?.ingredients ?? [])
    .filter((/** @type {any} */ i) => partOf(i) !== "flavor")
    .map((/** @type {any} */ i) => ({ food: String(i?.food ?? "").toLowerCase().trim() }))
    .filter((/** @type {any} */ r) => r.food);
}

/**
 * A bundle names facts and weights. Refuse one that names a fact this
 * scorer cannot compute, rather than scoring it zero and pretending.
 * @param {Record<string, any>} bundle
 * @returns {string[]} the problems, empty when the bundle is scoreable
 */
export function validateBundle(bundle) {
  const problems = [];
  if (!bundle || typeof bundle !== "object") return ["bundle is not an object"];
  if (!bundle.id) problems.push("bundle has no id");
  const weights = bundle.weights ?? {};
  if (Object.keys(weights).length === 0) problems.push("bundle scores nothing");
  for (const k of Object.keys(weights)) {
    if (!(k in FACTS)) problems.push(`bundle scores "${k}", which no fact computes`);
    if (!Number.isFinite(Number(weights[k]))) problems.push(`weight for "${k}" is not a number`);
  }
  return problems;
}

/**
 * Score one recipe under one bundle, 0..100.
 *
 * A fact that does not apply to this recipe (no grains, no protein rows) is
 * dropped from BOTH the numerator and the denominator, so a dish is never
 * punished for not being a kind of dish it is not.
 * @param {Record<string, any>} bundle
 * @param {Record<string, any>} recipe
 * @returns {{ score: number, breakdown: Record<string, number>, applied: string[] }}
 */
export function scoreRecipe(bundle, recipe) {
  const rows = substantiveRows(recipe);
  /** @type {Record<string, number>} */
  const breakdown = {};
  const applied = [];
  let total = 0;
  let weightSum = 0;
  for (const [fact, rawWeight] of Object.entries(bundle?.weights ?? {})) {
    const fn = FACTS[fact];
    if (!fn) continue;
    const v = fn(rows);
    if (v === null) continue;
    const w = Number(rawWeight);
    // a NEGATIVE weight means "less is better" (added sugar, formulated
    // share); the fact stays a plain fraction and the bundle owns the sign
    const contribution = w >= 0 ? v * w : (1 - v) * -w;
    breakdown[fact] = Math.round(v * 1000) / 1000;
    applied.push(fact);
    total += contribution;
    weightSum += Math.abs(w);
  }
  const score = weightSum === 0 ? 0 : Math.round((total / weightSum) * 100);
  return { score, breakdown, applied };
}

/**
 * Rank a whole bank under a bundle, highest score first, id as a stable
 * tiebreak so the same bank always yields the same ranking.
 * @param {Record<string, any>} bundle
 * @param {Record<string, any>[]} recipes
 * @returns {{ id: string, score: number }[]}
 */
export function rankBank(bundle, recipes) {
  return recipes
    .map((r) => ({ id: String(r.id), score: scoreRecipe(bundle, r).score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * THE COUNCIL'S TEST, and the thing P12 is actually proven by.
 *
 * Spearman rho between two bundles' rankings of the same bank, plus how many
 * recipes cross a pass/fail line. Two bundles that agree at rho 0.9 are one
 * philosophy wearing two labels, however different their prose.
 * @param {Record<string, any>} bundleA
 * @param {Record<string, any>} bundleB
 * @param {Record<string, any>[]} recipes
 * @param {number} [passMark] the pass/fail line, 0..100
 * @returns {{ rho: number, crossings: number, n: number }}
 */
export function rankAgreement(bundleA, bundleB, recipes, passMark = 50) {
  const a = rankBank(bundleA, recipes);
  const b = rankBank(bundleB, recipes);
  const rankA = new Map(a.map((r, i) => [r.id, i]));
  const rankB = new Map(b.map((r, i) => [r.id, i]));
  const ids = [...rankA.keys()];
  const n = ids.length;
  if (n < 2) return { rho: 1, crossings: 0, n };
  let d2 = 0;
  for (const id of ids) {
    const d = /** @type {number} */ (rankA.get(id)) - /** @type {number} */ (rankB.get(id));
    d2 += d * d;
  }
  // Spearman without tie correction. Ties inflate rho slightly, which makes
  // this CONSERVATIVE for our purpose: it is harder to pass, not easier.
  const rho = 1 - (6 * d2) / (n * (n * n - 1));
  const scoreA = new Map(a.map((r) => [r.id, r.score]));
  const scoreB = new Map(b.map((r) => [r.id, r.score]));
  let crossings = 0;
  for (const id of ids) {
    const pa = /** @type {number} */ (scoreA.get(id)) >= passMark;
    const pb = /** @type {number} */ (scoreB.get(id)) >= passMark;
    if (pa !== pb) crossings += 1;
  }
  return { rho: Math.round(rho * 1000) / 1000, crossings, n };
}

/**
 * Week-level floors, which is the shape the engine did not previously have:
 * the incumbent bundle enforces per-DAY food-group floors, and a bundle whose
 * content is "eat a wider variety across the week" cannot be expressed that
 * way. Two council seats independently called this the tell that the engine
 * genuinely holds no philosophy.
 * @param {Record<string, any>} bundle
 * @param {Record<string, any>[]} weekRecipes
 * @returns {{ distinctPlantSpecies: number, meets: Record<string, boolean> }}
 */
export function scoreWeek(bundle, weekRecipes) {
  /** @type {Set<string>} */
  const species = new Set();
  for (const r of weekRecipes) {
    for (const row of substantiveRows(r)) {
      const s = plantSpeciesOf(row.food);
      if (s) species.add(s);
    }
  }
  /** @type {Record<string, boolean>} */
  const meets = {};
  const floors = bundle?.weekFloors ?? {};
  if (Number.isFinite(Number(floors.distinctPlantSpecies))) {
    meets.distinctPlantSpecies = species.size >= Number(floors.distinctPlantSpecies);
  }
  return { distinctPlantSpecies: species.size, meets };
}
