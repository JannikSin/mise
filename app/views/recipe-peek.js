import { html } from "htm/preact";
import { useEffect } from "preact/hooks";
import { cookPlan } from "../lib/portions.js";
import { formatRecipeQty } from "../lib/shopping.js";

/**
 * The recipe a planned meal opens into (David, 2026-07-27: with dragging gone,
 * "when you click on an item you should get a pop up of the recipe and be able
 * to see ingredients and cook").
 *
 * A card over the plan rather than a page navigation, because the question it
 * answers is "what is this and do I have the stuff", which you ask standing in
 * the kitchen and then dismiss. Cooking is still a full page: once you press
 * COOK you want the whole screen and the wake lock.
 *
 * NOT GATED. It used to be: steps waited behind a scanned receipt. David,
 * 2026-07-27: "it is not good for people to not be able to access recipes when
 * not given receipt yet cause sometimes we do have the food." The receipt is
 * now a NOTE on the card, not a lock on it.
 *
 * Escape hatches, per the overlay rule: a CLOSE button that always renders, a
 * tap on the backdrop, and Escape. None of them sit behind a conditional.
 * @param {{
 *   recipe: Record<string, any> | null,
 *   servings?: number,
 *   entryId?: string,
 *   tableId?: string,
 *   unshopped?: boolean,
 *   onClose: () => void
 * }} props
 */
export function RecipePeek({ recipe, servings, entryId, tableId, unshopped = false, onClose }) {
  useEffect(() => {
    const onKey = (/** @type {KeyboardEvent} */ e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!recipe) return null;
  const plan = cookPlan(recipe, servings);
  // Cook Mode is gone (2026-08-19): both buttons land on the recipe page,
  // which carries the timer (entry) and the serve tile (table). The params
  // ride on BOTH links — FULL RECIPE used to drop them, which is exactly how
  // David ended up on a recipe page with no timer and nowhere to find one.
  const cookHref = `#/recipe/${encodeURIComponent(recipe.id)}?from=plan&servings=${
    servings && servings > 0 ? servings : (recipe.servings ?? 1)
  }${entryId ? `&entry=${encodeURIComponent(entryId)}` : ""}${
    tableId ? `&table=${encodeURIComponent(tableId)}` : ""
  }`;

  return html`
    <div
      class="peek-overlay"
      role="dialog"
      aria-modal="true"
      aria-label=${recipe.name}
      onClick=${(/** @type {any} */ e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="peek-card">
        <div class="peek-head">
          <h2>${recipe.name}</h2>
          <button class="peek-close" aria-label="Close recipe" onClick=${onClose}>✕</button>
        </div>
        <div class="d num peekmacros">
          ${recipe.nutrition?.calories} kcal · ${recipe.nutrition?.protein}P ·
          ${recipe.nutrition?.carbs}C · ${recipe.nutrition?.fat}F
          ${plan.eatServings ? html` · ${plan.eatServings} serving${plan.eatServings === 1 ? "" : "s"}` : ""}
        </div>
        ${plan.note && html`<p class="hint">${plan.note}</p>`}
        ${
          unshopped &&
          html`<p class="hint peekreceipt">
            No receipt scanned for this week yet, so nothing here is confirmed bought. Cook it
            anyway if you already have the food. <a href="#/list">scan the receipt →</a>
          </p>`
        }
        <h3 class="block-title">Ingredients</h3>
        <div class="slots">
          ${plan.ingredients.map(
            (/** @type {any} */ ing, /** @type {number} */ i) => html`
              <div class="checkrow static" key=${`${ing.food}-${i}`}>
                <span class="food"
                  >${ing.food}${ing.staple ? html` <span class="tag">staple</span>` : ""}</span
                >
                <span class="q num">${formatRecipeQty(ing.qty, ing.unit)}</span>
              </div>
            `,
          )}
          ${
            (plan.ingredients ?? []).length === 0 &&
            html`<div class="empty">no ingredients recorded</div>`
          }
        </div>
        <div class="actions wrap peekactions">
          <a class="ask linkbtn" href=${cookHref} onClick=${onClose}>👩‍🍳 COOK IT
            <small>full recipe · timer · steps</small>
          </a>
        </div>
      </div>
    </div>
  `;
}
