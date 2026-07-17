import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";

// ?from=<key> in the recipe hash → where the backlink returns; unknown or
// absent keys fall back to the cookbook (the historical behavior)
const ORIGINS = /** @type {Record<string, { hash: string, label: string }>} */ ({
  today: { hash: "#/today", label: "← TODAY" },
  remedies: { hash: "#/remedies", label: "← REMEDIES" },
});
const DEFAULT_ORIGIN = { hash: "#/cookbook", label: "← COOKBOOK" };

/** @param {string | undefined} from */
const originOf = (from) => (from && ORIGINS[from]) || DEFAULT_ORIGIN;

/** @param {string | undefined} from */
const fromSuffix = (from) => (from && ORIGINS[from] ? `?from=${encodeURIComponent(from)}` : "");

/**
 * @param {{ recipe: Record<string, any> | undefined, loading: boolean, from?: string }} props
 */
export function RecipeView({ recipe, loading, from }) {
  const origin = originOf(from);
  if (!recipe)
    return html`<div class="empty">
      ${loading ? "loading…" : "recipe not found"} — <a href=${origin.hash}>go back</a>
    </div>`;
  const n = recipe.nutrition ?? {};
  return html`
    <div class="view detail">
      <a class="backlink" href=${origin.hash}>${origin.label}</a>
      <h1>${recipe.name}</h1>
      <div class="meta num">
        ${recipe.totalTime}m · serves ${recipe.servings} · ${recipe.effort}
        ${(recipe.purpose ?? []).map((/** @type {string} */ p) => html`<span class="tag ${p}">${p === "pre-activity" ? "pre-act" : p}</span>`)}
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

      <div class="actions">
        <button
          class="ask"
          onClick=${() =>
            (location.hash = `#/recipe/${encodeURIComponent(recipe.id)}/cook${fromSuffix(from)}`)}
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
              <div class="k">Sunday batch</div>
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
        ${(recipe.ingredients ?? []).map(
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
 * @param {{ recipe: Record<string, any> | undefined, loading: boolean, from?: string }} props
 */
export function CookView({ recipe, loading, from }) {
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
  // exit lands back on the recipe, keeping its ?from= so the backlink there
  // still points at the tab that started the whole flow
  const back = `#/recipe/${encodeURIComponent(recipe.id)}${fromSuffix(from)}`;

  return html`
    <div class="cook">
      <div class="top">
        <span>${recipe.name}</span>
        <a class="exit" href=${back}>✕ EXIT</a>
      </div>
      <div class="counter num">STEP ${step + 1}/${steps.length}</div>
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
