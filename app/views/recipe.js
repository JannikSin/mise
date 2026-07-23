import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { cookPlan } from "../lib/portions.js";

// ?from=<key> in the recipe hash → where the backlink returns; unknown or
// absent keys fall back to the cookbook (the historical behavior)
const ORIGINS = /** @type {Record<string, { hash: string, label: string }>} */ ({
  today: { hash: "#/today", label: "← TODAY" },
  remedies: { hash: "#/remedies", label: "← REMEDIES" },
});
const DEFAULT_ORIGIN = { hash: "#/cookbook", label: "← COOKBOOK" };

/** @param {string | undefined} from */
const originOf = (from) => (from && ORIGINS[from]) || DEFAULT_ORIGIN;

/**
 * Query suffix carrying the backlink origin AND the planned portion through to
 * Cook mode, so cooking stays scaled to the meal.
 * @param {string | undefined} from
 * @param {number} [servings]
 */
const cookSuffix = (from, servings) => {
  const parts = [];
  if (from && ORIGINS[from]) parts.push(`from=${encodeURIComponent(from)}`);
  if (servings && servings > 0) parts.push(`servings=${servings}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

/**
 * @param {{ recipe: Record<string, any> | undefined, loading: boolean, from?: string, servings?: number }} props
 */
export function RecipeView({ recipe, loading, from, servings }) {
  const origin = originOf(from);
  if (!recipe)
    return html`<div class="empty">
      ${loading ? "loading…" : "recipe not found"} — <a href=${origin.hash}>go back</a>
    </div>`;
  const n = recipe.nutrition ?? {};
  // portion-aware: cook exactly what the plan says to eat, not the whole
  // recipe (the fix for cooking a serves-2 dish and eating both portions)
  const plan = cookPlan(recipe, servings);
  return html`
    <div class="view detail">
      <a class="backlink" href=${origin.hash}>${origin.label}</a>
      <h1>${recipe.name}</h1>
      <div class="meta num">
        ${recipe.totalTime}m ·${" "}
        ${
          plan.mode === "single"
            ? html`cooking ${plan.cookServings} of ${recipe.servings}`
            : html`serves ${recipe.servings}`
        }
        · ${recipe.effort}
        ${(recipe.purpose ?? []).map((/** @type {string} */ p) => html`<span class="tag ${p}">${p === "pre-activity" ? "pre-act" : p}</span>`)}
        ${
          // provenance (council 2026-07-23): an AI-invented meal never
          // passes itself off as an audited bank recipe
          (recipe.tags ?? []).includes("ai-special") &&
          html`<span class="tag">✨ AI special · estimated macros</span>`
        }
      </div>
      <p class="hint">${recipe.description}</p>

      <div class="macros4">
        <div class="tile">
          <div class="k">kcal</div>
          <div class="v">${n.calories}</div>
        </div>
        <div class="tile">
          <div class="k">Protein</div>
          <div class="v">${n.protein}<small>g</small></div>
        </div>
        <div class="tile">
          <div class="k">Carbs</div>
          <div class="v">${n.carbs}<small>g</small></div>
        </div>
        <div class="tile">
          <div class="k">Fat</div>
          <div class="v">${n.fat}<small>g</small></div>
        </div>
      </div>

      ${
        plan.note &&
        html`<div class="tile portion ${plan.mode}" role="note">
          <div class="k">
            ${plan.mode === "batch" ? "🍲 batch — save the extra" : plan.mode === "single" ? "🍽️ cooking your portion" : "portion"}
          </div>
          <div class="d">${plan.note}</div>
        </div>`
      }

      <div class="actions">
        <button
          class="ask"
          onClick=${() =>
            (location.hash = `#/recipe/${encodeURIComponent(recipe.id)}/cook${cookSuffix(from, servings)}`)}
        >
          COOK MODE
          <small>big text · step by step</small>
        </button>
      </div>

      ${
        recipe.batchPrep &&
        html`<div class="batch">
          ${
            recipe.batchPrep.sundayComponent &&
            html`<div>
              <div class="k">Batch prep</div>
              ${recipe.batchPrep.sundayComponent}
            </div>`
          }
          ${
            recipe.batchPrep.weekdayAssembly &&
            html`<div>
              <div class="k">Weekday assembly</div>
              ${recipe.batchPrep.weekdayAssembly}
            </div>`
          }
        </div>`
      }

      <h2 class="block-title">Ingredients</h2>
      <div>
        ${plan.ingredients.map(
          (/** @type {Record<string, any>} */ i) => html`
            <div class="ing ${i.staple ? "staple" : ""}">
              <span>
                ${i.food}${i.note ? html` <span class="note">— ${i.note}</span>` : ""}
                ${i.staple ? html` <span class="pantry-mark">pantry</span>` : ""}
              </span>
              <span class="q">${i.qty} ${i.unit}</span>
            </div>
          `,
        )}
      </div>

      <h2 class="block-title">Steps</h2>
      <ol class="steps">
        ${(recipe.instructions ?? []).map(
          (/** @type {{ step: number, text: string }} */ s) =>
            html`<li key=${s.step}>${s.text}</li>`,
        )}
      </ol>
    </div>
  `;
}

/**
 * Full-screen cooking mode: one big step at a time, screen kept awake.
 * @param {{ recipe: Record<string, any> | undefined, loading: boolean, from?: string, servings?: number }} props
 */
export function CookView({ recipe, loading, from, servings }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    /** @type {any} */
    let lock = null;
    if ("wakeLock" in navigator) {
      /** @type {any} */ (navigator).wakeLock.request("screen").then(
        (/** @type {any} */ l) => {
          lock = l;
        },
        () => {},
      );
    }
    return () => {
      if (lock) lock.release().catch(() => {});
    };
  }, []);

  if (!recipe)
    return html`<div class="empty">
      ${loading ? "loading…" : "recipe not found"} —
      <a href="#/cookbook">back to cookbook</a>
    </div>`;
  const steps = recipe.instructions ?? [];
  const last = steps.length - 1;
  const plan = cookPlan(recipe, servings);
  // exit lands back on the recipe, keeping ?from= AND the portion so the
  // recipe there stays scaled to the same meal
  const back = `#/recipe/${encodeURIComponent(recipe.id)}${cookSuffix(from, servings)}`;

  return html`
    <div class="cook">
      <div class="top">
        <span>${recipe.name}</span>
        <a class="exit" href=${back}>✕ EXIT</a>
      </div>
      <div class="counter num">STEP ${step + 1}/${steps.length}</div>
      ${step === 0 && plan.note && html`<div class="cook-portion">${plan.note}</div>`}
      <div class="steptext">${steps[step]?.text}</div>
      <div class="nav">
        <button onClick=${() => setStep(Math.max(0, step - 1))} disabled=${step === 0}>
          ← PREV
        </button>
        ${
          step < last
            ? html`<button class="next" onClick=${() => setStep(step + 1)}>NEXT →</button>`
            : html`<button class="next" onClick=${() => (location.hash = back)}>DONE ✓</button>`
        }
      </div>
    </div>
  `;
}
