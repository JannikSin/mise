import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { SYMPTOMS, protocolFor } from "../lib/remedies.js";

/**
 * Sick/down mode (blueprint §6.7): pick symptoms → merged protocol.
 * Rules-based and fully offline (the rules ship with the app).
 * @param {{ recipes: Record<string, any>[] }} props
 */
export function RemediesView({ recipes }) {
  const [picked, setPicked] = useState(/** @type {string[]} */ ([]));
  const protocol = protocolFor(picked);
  const byId = new Map(recipes.map((r) => [r.id, r]));

  const toggle = (/** @type {string} */ id) =>
    setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);

  /** @param {string} title @param {string[]} items */
  const section = (title, items) =>
    items.length > 0 &&
    html`
      <h2 class="block-title">${title}</h2>
      <ul class="protolist">
        ${items.map((i) => html`<li key=${i}>${i}</li>`)}
      </ul>
    `;

  return html`
    <div class="view">
      <a class="backlink" href="#/">← BACK</a>
      <div class="hero"><h1>Feeling off?</h1></div>

      <h2 class="block-title">What's going on</h2>
      <div class="chips wrapchips" role="group" aria-label="Symptoms">
        ${SYMPTOMS.map(
          (s) => html`
            <button
              class="chip ${picked.includes(s.id) ? "on" : ""}"
              aria-pressed=${picked.includes(s.id)}
              onClick=${() => toggle(s.id)}
            >
              ${s.label}
            </button>
          `,
        )}
      </div>

      ${!protocol && html`<p class="hint">pick what applies — combinations merge.</p>`}
      ${
        protocol &&
        html`
          ${section("Drink", protocol.teas)} ${section("Eat", protocol.foods)}
          ${section("Avoid", protocol.avoid)} ${section("Do", protocol.notes)}
          ${
            protocol.recipeIds.length > 0 &&
            html`
              <h2 class="block-title">From the cookbook</h2>
              <div class="slots">
                ${protocol.recipeIds.map((id) => {
                const r = byId.get(id);
                return html`
                  <div class="slot" key=${id}>
                    <a class="slotlink" href="#/recipe/${encodeURIComponent(id)}">
                      <span class="name">${r ? r.name : id}</span>
                      ${
                      r &&
                      html`<span class="m num"
                        ><b>${r.nutrition?.calories}</b> kcal · ${r.totalTime}m</span
                      >`
                    }
                    </a>
                  </div>
                `;
              })}
              </div>
            `
          }
          <p class="hint">
            Home care, not medical advice — fever past 3 days, trouble breathing, or anything scary:
            see a real doctor. Complex cases: ask Claude in Cowork.
          </p>
        `
      }
    </div>
  `;
}
