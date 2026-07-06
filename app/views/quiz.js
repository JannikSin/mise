import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { rankRecipes } from "../lib/quiz.js";
import { RecipeRow } from "./recipe-row.js";

const TIME_OPTS = [
  { key: 15, label: "15 MIN" },
  { key: 30, label: "30 MIN" },
  { key: 999, label: "GOT TIME" },
];
const PURPOSE_OPTS = ["recovery", "pre-activity", "long-satiety", "sick-day", "everyday"];
/** @type {{ key: "light" | "heavy", label: string }[]} */
const LOAD_OPTS = [
  { key: "light", label: "LIGHT" },
  { key: "heavy", label: "HEAVY" },
];

/**
 * The opening quiz (blueprint §6.1): three chip questions → ranked picks.
 * @param {{ recipes: Record<string, any>[], useSoonFoods: string[], hasToken: boolean }} props
 */
export function QuizView({ recipes, useSoonFoods, hasToken }) {
  const [time, setTime] = useState(/** @type {number | null} */ (null));
  const [purpose, setPurpose] = useState(/** @type {string | null} */ (null));
  const [load, setLoad] = useState(/** @type {"heavy" | "light" | null} */ (null));

  const ready = time != null;
  const ranked = ready
    ? rankRecipes(recipes, { time: /** @type {number} */ (time), purpose, load, useSoonFoods })
    : [];

  return html`
    <div class="view">
      <a class="backlink" href="#/">← BACK</a>
      <div class="hero">
        <h1>What should<br />I eat?</h1>
      </div>

      <h2 class="block-title">How much time?</h2>
      <div class="chips" role="group" aria-label="Time available">
        ${TIME_OPTS.map(
          (o) => html`
            <button
              class="chip ${time === o.key ? "on" : ""}"
              aria-pressed=${time === o.key}
              onClick=${() => setTime(time === o.key ? null : o.key)}
            >
              ${o.label}
            </button>
          `,
        )}
      </div>

      <h2 class="block-title">What for?</h2>
      <div class="chips" role="group" aria-label="Purpose">
        ${PURPOSE_OPTS.map(
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

      <h2 class="block-title">Heavy or light?</h2>
      <div class="chips" role="group" aria-label="Load">
        ${LOAD_OPTS.map(
          (o) => html`
            <button
              class="chip ${load === o.key ? "on" : ""}"
              aria-pressed=${load === o.key}
              onClick=${() => setLoad(load === o.key ? null : o.key)}
            >
              ${o.label}
            </button>
          `,
        )}
      </div>

      ${
        ready &&
        html`
          <h2 class="block-title">Ranked picks</h2>
          <div class="slots" data-testid="quiz-results">
            ${ranked
              .slice(0, 6)
              .map(
                (s) =>
                  html`<${RecipeRow}
                    key=${s.recipe.id}
                    recipe=${s.recipe}
                    why=${s.reasons.join(" · ")}
                  />`,
              )}
            ${
              ranked.length === 0 &&
              html`<div class="empty">
                ${
                  recipes.length === 0
                    ? hasToken
                      ? "loading recipes…"
                      : "no recipes yet — connect your token in SYS"
                    : "nothing fits that window — loosen the time?"
                }
              </div>`
            }
          </div>
        `
      }
      ${!ready && html`<p class="hint">Pick a time window to get ranked picks.</p>`}
    </div>
  `;
}
