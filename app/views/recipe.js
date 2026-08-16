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
 * Query suffix carrying the backlink origin, the planned portion, the
 * plan-entry id AND the table id through to Cook mode, so cooking stays
 * scaled to the meal and the last step can confirm the right thing cooked
 * (a plan entry, or a table via the serve step).
 * @param {string | undefined} from
 * @param {number} [servings]
 * @param {string} [entryId]
 * @param {string} [tableId]
 */
const cookSuffix = (from, servings, entryId, tableId) => {
  const parts = [];
  if (from && ORIGINS[from]) parts.push(`from=${encodeURIComponent(from)}`);
  if (servings && servings > 0) parts.push(`servings=${servings}`);
  if (entryId) parts.push(`entry=${encodeURIComponent(entryId)}`);
  if (tableId) parts.push(`table=${encodeURIComponent(tableId)}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

/**
 * @param {{ recipe: Record<string, any> | undefined, loading: boolean, from?: string, servings?: number, entryId?: string, tableId?: string, potRows?: { food: string, unit: string, qty: number }[], unshopped?: boolean }} props
 */
export function RecipeView({
  recipe,
  loading,
  from,
  servings,
  entryId,
  tableId,
  potRows,
  unshopped = false,
}) {
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
  const basePlan = cookPlan(recipe, servings);
  // SOLVED tables (per-person-plates spec §7.5/§11.5): the ingredient
  // column shows TONIGHT'S pot for this table — arithmetic, not AI; same
  // name, same steps, SAME WORDS forever, only the numbers change. So the
  // pot quantities are merged ONTO the recipe's own rows by index, keeping
  // prep notes and pantry marks, and only when every row's food+unit
  // matches — a personal variant of the same id must never render the
  // bank's foods (the potFromBank bug class). Batch recipes keep their
  // save-the-extra note: the leftovers instruction is safety-relevant.
  const plan = (() => {
    const ings = basePlan.ingredients ?? [];
    if (!potRows || potRows.length !== ings.length) return basePlan;
    const merged = ings.map((ing, i) => {
      const p = potRows[i];
      return p && p.food === ing.food && p.unit === ing.unit ? { ...ing, qty: p.qty } : null;
    });
    if (merged.some((x) => x === null)) return basePlan;
    return {
      ...basePlan,
      ingredients: /** @type {Record<string, any>[]} */ (merged),
      mode: basePlan.mode === "batch" ? basePlan.mode : "scaled",
      note: basePlan.mode === "batch" ? basePlan.note : "Amounts for tonight's table.",
    };
  })();
  return html`
    <div class="view detail">
      <a class="backlink" href=${origin.hash}>${origin.label}</a>
      <h1>${recipe.name}</h1>
      <div class="meta num">
        ${recipe.totalTime}m ·${" "}
        ${
          // NO SERVING COUNTS (David, 2026-08-10). "cooking 0.75 of 3" and
          // "makes 9.75 servings" are the app talking to itself. A serving is
          // only a denominator for the macros; it is not an amount of food any
          // particular person should eat, and printing it invites exactly the
          // wrong reading ("am I eating three servings?"). The amounts listed
          // below are already scaled to whoever is cooking, so say WHOSE food
          // this is and let the ingredient list carry the quantity.
          plan.mode === "single"
            ? html`your plate`
            : plan.mode === "scaled"
              ? html`the whole pot`
              : html`makes extra on purpose`
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
            ${
              plan.mode === "batch"
                ? "🍲 batch — save the extra"
                : plan.mode === "single"
                  ? "🍽️ cooking your portion"
                  : plan.mode === "scaled"
                    ? "👨‍🍳 family batch — amounts scaled up"
                    : "portion"
            }
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
            (location.hash = `#/recipe/${encodeURIComponent(recipe.id)}/cook${cookSuffix(from, servings, entryId, tableId)}`)}
        >
          COOK MODE
          <small>big text · step by step</small>
        </button>
      </div>

      ${
        recipe.batchPrep &&
        html`<div class="tile portion batch" role="note">
          ${
            recipe.batchPrep.sundayComponent &&
            html`<div>
              <div class="k">🍲 BATCH PREP — cook this AHEAD, the steps below assume it's done</div>
              <div class="d">${recipe.batchPrep.sundayComponent}</div>
            </div>`
          }
          ${
            recipe.batchPrep.weekdayAssembly &&
            html`<div>
              <div class="k">Day-of assembly</div>
              <div class="d">${recipe.batchPrep.weekdayAssembly}</div>
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
 *
 * When opened from a TABLE (tableId + serve), the SERVE STEP is appended as
 * the final step (per-person-plates-design §7.2): you cannot mark a shared
 * meal cooked without passing the screen that says who gets what. That is
 * structural, not a hope that people scroll.
 * @param {{ recipe: Record<string, any> | undefined, loading: boolean, from?: string, servings?: number, entryId?: string, cooked?: boolean, onCooked?: (entryId: string) => void, tableId?: string, serve?: import("../lib/serve.js").ServeModel | null, onCookedTable?: (tableId: string) => void }} props
 */
export function CookView({
  recipe,
  loading,
  from,
  servings,
  entryId,
  cooked,
  onCooked,
  tableId,
  serve,
  onCookedTable,
}) {
  const [rawStep, setStep] = useState(0);
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
  // batch-prep becomes STEP 0 in cook mode (David, 2026-08-03: the nicoise
  // told him to "use the batch chicken" and never said how — the ahead-of-
  // time work must live in the same step flow, not on a tile he already
  // scrolled past)
  // the serve step is the LAST step of a table cook, and its button is the
  // COOKED button — who-gets-what is on the way out, not on a card nobody
  // finds (spec §6.1/§7.2: "that is the same disease relocated")
  const hasServe = Boolean(tableId && serve && serve.rows.length > 0);
  const steps = [
    ...(recipe.batchPrep?.sundayComponent
      ? [
          {
            step: 0,
            text: `AHEAD OF TIME (batch prep — skip if already done): ${recipe.batchPrep.sundayComponent}`,
          },
        ]
      : []),
    ...(recipe.instructions ?? []),
    ...(hasServe ? [{ serve: true, text: "" }] : []),
  ];
  const last = steps.length - 1;
  // clamp: if the serve step vanishes mid-cook (a housemate toggles
  // sameForEveryone and the sync lands), a user parked on the old last step
  // must land on the new one, never a blank STEP n+1/n
  const step = Math.min(rawStep, last);
  const onServe = hasServe && step === last;
  const plan = cookPlan(recipe, servings);
  // exit lands back on the recipe, keeping ?from= AND the portion so the
  // recipe there stays scaled to the same meal
  const back = `#/recipe/${encodeURIComponent(recipe.id)}${cookSuffix(from, servings, entryId, tableId)}`;
  const finish = () => {
    // mutually exclusive on purpose: app-built links carry one or the other,
    // and a hand-crafted URL carrying both must not confirm two things with
    // one tap (security review L2). Table wins: the serve step is its gate.
    if (tableId && onCookedTable && !cooked) onCookedTable(tableId);
    else if (entryId && onCooked && !cooked) onCooked(entryId);
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
      ${
        onServe
          ? html`<div class="serve">
              <div class="serve-title">SERVE</div>
              <div class="serve-sub">Amounts for tonight's table.</div>
              ${serve?.rows.map((r) =>
                r.kind === "aside"
                  ? html`<div class="serve-seat aside" key=${r.id}>
                      <div class="serve-name">SET ASIDE</div>
                      <div class="serve-line">
                        ${r.name.toUpperCase()}'s portion, ${r.fraction}, set
                        apart${r.note ? ` (${r.note})` : ""}
                      </div>
                    </div>`
                  : html`<div class="serve-seat" key=${r.id}>
                      <div class="serve-name">${r.name.toUpperCase()}</div>
                      ${
                        r.lines && r.lines.length > 0
                          ? r.lines.map(
                              (line, i) => html`<div class="serve-line" key=${i}>${line}</div>`,
                            )
                          : html`<div class="serve-line">${r.fraction}</div>`
                      }
                      ${r.note && html`<div class="serve-line hint">${r.note}</div>`}
                    </div>`,
              )}
              ${serve?.cookNotes.map((c, i) => html`<div class="hint" key=${i}>👨‍🍳 ${c}</div>`)}
            </div>`
          : html`<div class="steptext">${steps[step]?.text}</div>`
      }
      <div class="nav">
        <button onClick=${() => setStep(Math.max(0, step - 1))} disabled=${step === 0}>
          ← PREV
        </button>
        ${
          step < last
            ? html`<button class="next" onClick=${() => setStep(step + 1)}>NEXT →</button>`
            : html`<button class="next" onClick=${finish}>
                ${(entryId || tableId) && !cooked ? "COOKED ✓" : "DONE ✓"}
              </button>`
        }
      </div>
    </div>
  `;
}
