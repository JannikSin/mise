import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { RecipeRow } from "./recipe-row.js";

const PURPOSES = ["recovery", "pre-activity", "long-satiety", "sick-day", "everyday"];
const TIMES = [
  { key: "15", label: "≤15M", max: 15 },
  { key: "30", label: "≤30M", max: 30 },
  { key: "long", label: "30M+", min: 31 },
];

/**
 * @param {{
 *   recipes: Record<string, any>[],
 *   hasToken: boolean,
 *   weekId: string,
 *   onPlan: (recipe: Record<string, any>, date: string) => void
 * }} props
 */
export function CookbookView({ recipes, hasToken, weekId, onPlan }) {
  const [purpose, setPurpose] = useState(/** @type {string | null} */ (null));
  const [time, setTime] = useState(/** @type {string | null} */ (null));

  const t = TIMES.find((x) => x.key === time);
  const filtered = recipes.filter(
    (r) =>
      (!purpose || (r.purpose ?? []).includes(purpose)) &&
      (!t || ((t.max == null || r.totalTime <= t.max) && (t.min == null || r.totalTime >= t.min))),
  );

  return html`
    <div class="view">
      <a class="backlink" href="#/today">← COOK</a>
      <div class="hero">
        <h1>Cookbook <span class="num">${recipes.length}</span></h1>
      </div>
      <div class="chips" role="group" aria-label="Filter by purpose">
        ${PURPOSES.map(
          (p) => html`
            <button
              class="chip ${purpose === p ? "on" : ""}"
              aria-pressed=${purpose === p}
              onClick=${() => setPurpose(purpose === p ? null : p)}
            >
              ${p}
            </button>
          `,
        )}
      </div>
      <div class="chips" role="group" aria-label="Filter by time">
        ${TIMES.map(
          (x) => html`
            <button
              class="chip ${time === x.key ? "on" : ""}"
              aria-pressed=${time === x.key}
              onClick=${() => setTime(time === x.key ? null : x.key)}
            >
              ${x.label}
            </button>
          `,
        )}
      </div>
      <div class="slots">
        ${filtered.map(
          (r) => html`<${RecipeRow} key=${r.id} recipe=${r} weekId=${weekId} onPlan=${onPlan} />`,
        )}
        ${
          filtered.length === 0 &&
          html`<div class="empty">
            ${
              recipes.length === 0
                ? hasToken
                  ? "loading recipes…"
                  : "no recipes yet — connect your token in SYS"
                : "nothing matches those filters"
            }
          </div>`
        }
      </div>
    </div>
  `;
}
