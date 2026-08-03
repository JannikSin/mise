import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { cookPlan } from "../lib/portions.js";
import { formatRecipeQty } from "../lib/shopping.js";
import { keepAwake } from "../lib/awake.js";
import { pickForRecipe } from "../lib/music.js";

// ?from=<key> in the recipe hash → where the backlink returns; unknown or
// absent keys fall back to the cookbook (the historical behavior)
const ORIGINS = /** @type {Record<string, { hash: string, label: string }>} */ ({
  // #/today is a legacy alias kept for recipe URLs bookmarked before Plan
  // absorbed Cook; both land on the merged tab
  plan: { hash: "#/plan", label: "← PLAN" },
  today: { hash: "#/plan", label: "← PLAN" },
  remedies: { hash: "#/remedies", label: "← REMEDIES" },
});
const DEFAULT_ORIGIN = { hash: "#/cookbook", label: "← COOKBOOK" };

/** @param {string | undefined} from */
const originOf = (from) => (from && ORIGINS[from]) || DEFAULT_ORIGIN;

/**
 * Query suffix carrying the backlink origin, the planned portion, AND the
 * plan-entry id through to Cook mode, so cooking stays scaled to the meal
 * and DONE can confirm the right entry as cooked.
 * @param {string | undefined} from
 * @param {number} [servings]
 * @param {string} [entryId]
 */
const cookSuffix = (from, servings, entryId) => {
  const parts = [];
  if (from && ORIGINS[from]) parts.push(`from=${encodeURIComponent(from)}`);
  if (servings && servings > 0) parts.push(`servings=${servings}`);
  if (entryId) parts.push(`entry=${encodeURIComponent(entryId)}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

/**
 * @param {{ recipe: Record<string, any> | undefined, loading: boolean, from?: string, servings?: number, entryId?: string, unshopped?: boolean }} props
 */
export function RecipeView({ recipe, loading, from, servings, entryId, unshopped = false }) {
  const origin = originOf(from);
  // the recipe page holds the screen as well as Cook mode. Reading the steps
  // off THIS page with full hands is exactly when it used to sleep, because
  // only Cook mode ever asked for a lock.
  const [awake, setAwake] = useState(
    /** @type {import("../lib/awake.js").AwakeState} */ ({
      held: false,
      supported: true,
      reason: "",
    }),
  );
  const [tune, setTune] = useState(0);
  useEffect(() => keepAwake(setAwake), []);
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
      ${
        // Something to put on, themed to the food (David, 2026-07-27). It is a
        // LINK, not a player: on the phone this opens the Music app. Offered,
        // never forced, and it remembers nothing.
        (() => {
          const p = pickForRecipe(recipe, tune);
          return html`<div class="tile tunetile">
            <div class="row">
              <span class="k">🎧 put something on?</span>
              <button
                class="linktext"
                aria-label="Suggest something else"
                onClick=${() => setTune(tune + 1)}
              >
                something else ↻
              </button>
            </div>
            <a class="secondary linkbtn tunelink" href=${p.url} rel="noopener noreferrer">
              ${p.label}${p.why ? html` <span class="hint">· ${p.why}</span>` : ""}
            </a>
          </div>`;
        })()
      }
      ${!awake.held && awake.reason && html`<p class="hint awakewhy">☀ ${awake.reason}</p>`}
      <div class="actions">
        <button
          class="ask"
          onClick=${() =>
            (location.hash = `#/recipe/${encodeURIComponent(recipe.id)}/cook${cookSuffix(from, servings, entryId)}`)}
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
              <span class="q">${formatRecipeQty(i.qty, i.unit)}</span>
            </div>
          `,
        )}
      </div>

      <h2 class="block-title">Steps</h2>
      ${
        // NOT A GATE any more (David, 2026-07-27: "it is not good for people
        // to not be able to access recipes when not given receipt yet cause
        // sometimes we do have the food"). The steps used to wait behind a
        // scanned receipt; now the receipt is a NOTE. The original worry it
        // was built for was real (cooking a week nobody bought), but the
        // failure it actually produced was worse: a locked recipe for food
        // already in the fridge.
        unshopped &&
        html`<p class="hint receiptnote">
          No receipt scanned for this week yet, so nothing here is confirmed bought. Cook it anyway
          if you already have the food. <a href="#/list">scan the receipt →</a>
        </p>`
      }
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
 * Full-screen cooking mode: one big step at a time, screen kept awake. When
 * opened from a planned meal (entryId), the last step's button confirms the
 * meal COOKED — the honest-state rule: only a confirmation marks it eaten.
 * @param {{ recipe: Record<string, any> | undefined, loading: boolean, from?: string, servings?: number, entryId?: string, cooked?: boolean, onCooked?: (entryId: string) => void }} props
 */
export function CookView({ recipe, loading, from, servings, entryId, cooked, onCooked }) {
  const [step, setStep] = useState(0);
  const [awake, setAwake] = useState(
    /** @type {import("../lib/awake.js").AwakeState} */ ({
      held: false,
      supported: true,
      reason: "",
    }),
  );
  // hands covered in egg, next step is time-critical: this is the one screen
  // in the app that must not sleep, and if it cannot hold the screen it has
  // to SAY so rather than fail silently
  useEffect(() => keepAwake(setAwake), []);

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
  const back = `#/recipe/${encodeURIComponent(recipe.id)}${cookSuffix(from, servings, entryId)}`;
  const finish = () => {
    if (entryId && onCooked && !cooked) onCooked(entryId);
    location.hash = back;
  };

  return html`
    <div class="cook">
      <div class="top">
        <span>${recipe.name}</span>
        <a class="exit" href=${back}>✕ EXIT</a>
      </div>
      <div class="counter num">
        STEP ${step + 1}/${steps.length}
        ${
          // an honest indicator. A silent failure here is what left him with
          // eggy hands at a locked phone, so this says which of the two it is.
          awake.held
            ? html`<span class="awakechip on" title="This screen will not sleep">☀ screen on</span>`
            : html`<span class="awakechip">☀ screen may sleep</span>`
        }
      </div>
      ${
        !awake.held &&
        awake.reason &&
        html`<div class="cook-portion awakewhy">⚠ ${awake.reason}</div>`
      }
      ${step === 0 && plan.note && html`<div class="cook-portion">${plan.note}</div>`}
      <div class="steptext">${steps[step]?.text}</div>
      <div class="nav">
        <button onClick=${() => setStep(Math.max(0, step - 1))} disabled=${step === 0}>
          ← PREV
        </button>
        ${
          step < last
            ? html`<button class="next" onClick=${() => setStep(step + 1)}>NEXT →</button>`
            : html`<button class="next" onClick=${finish}>
                ${entryId && !cooked ? "COOKED ✓" : "DONE ✓"}
              </button>`
        }
      </div>
    </div>
  `;
}
