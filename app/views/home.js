import { html } from "htm/preact";
import { localIsoDate } from "../lib/dates.js";
import { SLOT_KEYS } from "../lib/plan.js";

/** @type {Record<string, string>} */
const SLOT_LABEL = {
  breakfast: "BRK",
  lunch: "LUN",
  dinner: "DIN",
  smoothie: "SMO",
  snack: "SNK",
};

/**
 * Landing view: today's planned meals (tap → recipe + steps), the ask button,
 * quick stats under it.
 * @param {{ recipes: Record<string, any>[], plan: { week: string, entries: Record<string, any>[] }, sync: Record<string, any>, hasToken: boolean, repo: Record<string, any> | null }} props
 */
export function HomeView({ recipes, plan, sync, hasToken, repo }) {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const today = localIsoDate(new Date());
  const todayEntries = plan.entries
    .filter((e) => e.date === today)
    .sort((a, b) => SLOT_KEYS.indexOf(a.slot) - SLOT_KEYS.indexOf(b.slot));

  return html`
    <div class="view">
      <div class="hero">
        <h1>Mise<span>.</span></h1>
        <div class="sub">
          ${recipes.length} recipes · ${" "}
          ${hasToken ? "data connected" : html`<b>connect token in SYS</b>`}
        </div>
      </div>

      <h2 class="block-title">Today</h2>
      ${
        todayEntries.length === 0
          ? html`<p class="hint">nothing planned for today — <a href="#/plan">open PLAN</a></p>`
          : html`<div class="todaylist">
              ${todayEntries.map((entry) => {
                const recipe = entry.recipeId ? byId.get(entry.recipeId) : null;
                const label = SLOT_LABEL[entry.slot] ?? entry.slot;
                if (!recipe) {
                  return html`
                    <div class="todayrow" key=${entry.id}>
                      <span class="t">${label}</span>
                      <span class="n">${entry.freeText ?? "…"}</span>
                    </div>
                  `;
                }
                return html`
                  <a class="todayrow" href="#/recipe/${entry.recipeId}" key=${entry.id}>
                    <span class="t">${label}</span>
                    <span class="n">${recipe.name}</span>
                    <span class="m num"
                      >${recipe.nutrition?.calories} · ${recipe.nutrition?.protein}P ›</span
                    >
                  </a>
                `;
              })}
            </div>`
      }

      <button class="ask" onClick=${() => (location.hash = "#/quiz")}>
        WHAT SHOULD I EAT?
        <small>time · purpose · load → ranked picks</small>
      </button>

      <div class="actions">
        <a class="secondary linkbtn remedy" href="#/remedies">FEELING OFF? → REMEDIES</a>
      </div>

      <div class="grid">
        <a class="tile" href="#/cookbook">
          <div class="k">Cookbook</div>
          <div class="v">${recipes.length}<small> recipes</small></div>
          <div class="d">purpose-tagged · macro'd</div>
        </a>
        <div class="tile ${sync.pending ? "warn" : ""}">
          <div class="k">Sync</div>
          <div class="v">${sync.pending}<small> queued</small></div>
          <div class="d">
            ${
              !sync.pending
                ? html`<b>all pushed</b>`
                : repo?.auth === "invalid"
                  ? html`<b>token needs renewing — SYS</b>`
                  : html`<b>waiting for signal</b>`
            }
          </div>
        </div>
      </div>
    </div>
  `;
}
