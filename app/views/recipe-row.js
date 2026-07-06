import { html } from "htm/preact";
import { useRef, useState } from "preact/hooks";
import { datesOfWeek } from "../lib/plan.js";

const DAY_LABELS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/**
 * One tappable recipe row (cookbook list, quiz results). When onPlan is
 * provided, a + button expands a day picker that adds the recipe to the
 * shown week's plan; onPlan returns the slot it landed in so the row can
 * confirm exactly where the recipe went.
 * @param {{
 *   recipe: Record<string, any>,
 *   why?: string,
 *   weekId?: string,
 *   onPlan?: (recipe: Record<string, any>, date: string) => string
 * }} props
 */
export function RecipeRow({ recipe, why, weekId, onPlan }) {
  const [picking, setPicking] = useState(false);
  const [addedTo, setAddedTo] = useState(/** @type {string | null} */ (null));
  const plusRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const n = recipe.nutrition ?? {};
  const tag = (recipe.purpose ?? [])[0];
  const dates = onPlan && weekId ? datesOfWeek(weekId) : [];

  return html`
    <div class="rowwrap">
      <div class="slot">
        <a class="slotlink" href="#/recipe/${encodeURIComponent(recipe.id)}">
          <span class="name">
            ${recipe.name}
            ${
              tag &&
              html`<span class="tag ${tag}">${tag === "pre-activity" ? "pre-act" : tag}</span>`
            }
            ${why && html`<span class="why">${why}</span>`}
          </span>
          <span class="m num"
            ><b>${n.calories}</b> kcal<br />${n.protein}g P · ${recipe.totalTime}m</span
          >
        </a>
        ${
          onPlan &&
          html`
            <button
              ref=${plusRef}
              class="plus ${addedTo ? "done" : ""}"
              aria-label="Add ${recipe.name} to the plan for week ${weekId}"
              aria-expanded=${picking}
              onClick=${() => setPicking(!picking)}
            >
              ${addedTo ? "✓" : "+"}
            </button>
          `
        }
      </div>
      ${
        picking &&
        html`
          <div class="daypick" role="group" aria-label="Pick a day in week ${weekId}">
            <span class="wklabel">${weekId}</span>
            ${dates.map(
              (date, i) => html`
                <button
                  class="chip"
                  key=${date}
                  onClick=${() => {
                    const slot = /** @type {NonNullable<typeof onPlan>} */ (onPlan)(recipe, date);
                    setPicking(false);
                    setAddedTo(`${DAY_LABELS[i]} · ${slot}`);
                    plusRef.current?.focus();
                  }}
                >
                  ${DAY_LABELS[i]} ${date.slice(8)}
                </button>
              `,
            )}
          </div>
        `
      }
      ${addedTo && html`<div class="added-note" role="status">✓ added to ${addedTo}</div>`}
    </div>
  `;
}
