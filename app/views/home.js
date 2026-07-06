import { html } from "htm/preact";

/**
 * Landing view: the ask button front and center, quick stats under it.
 * @param {{ recipes: Record<string, any>[], sync: Record<string, any>, hasToken: boolean, repo: Record<string, any> | null }} props
 */
export function HomeView({ recipes, sync, hasToken, repo }) {
  return html`
    <div class="view">
      <div class="hero">
        <h1>Mise<span>.</span></h1>
        <div class="sub">
          ${recipes.length} recipes · ${" "}
          ${hasToken ? "data connected" : html`<b>connect token in SYS</b>`}
        </div>
      </div>

      <button class="ask" onClick=${() => (location.hash = "#/quiz")}>
        WHAT SHOULD I EAT?
        <small>time · purpose · load → ranked picks</small>
      </button>

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

      <h2 class="block-title">Coming online</h2>
      <p class="hint">
        Planner, shopping list, pantry and training land in the next build phases. The console grows
        a tab as each one ships.
      </p>
    </div>
  `;
}
