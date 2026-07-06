import { html } from "htm/preact";

/**
 * One tappable recipe row (cookbook list, quiz results).
 * @param {{ recipe: Record<string, any>, why?: string }} props
 */
export function RecipeRow({ recipe, why }) {
  const n = recipe.nutrition ?? {};
  const tag = (recipe.purpose ?? [])[0];
  return html`
    <a class="slot" href="#/recipe/${encodeURIComponent(recipe.id)}">
      <span class="name">
        ${recipe.name}
        ${tag && html`<span class="tag ${tag}">${tag === "pre-activity" ? "pre-act" : tag}</span>`}
        ${why && html`<span class="why">${why}</span>`}
      </span>
      <span class="m num"
        ><b>${n.calories}</b> kcal<br />${n.protein}g P · ${recipe.totalTime}m</span
      >
    </a>
  `;
}
