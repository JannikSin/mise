import { html } from "htm/preact";
import { useEffect } from "preact/hooks";
import { cookPlan, scaleQty } from "../lib/portions.js";
import { formatRecipeQty } from "../lib/shopping.js";
import { rotateComponents, rotates, rotationNoun } from "../lib/rotate.js";
import { localIsoDate } from "../lib/dates.js";

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
 *   date?: string,
 *   entryId?: string,
 *   tableId?: string,
 *   unshopped?: boolean,
 *   onClose: () => void
 * }} props
 */
export function RecipePeek({
  recipe,
  servings,
  date = undefined,
  entryId,
  tableId,
  unshopped = false,
  onClose,
}) {
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
  }${date ? `&date=${encodeURIComponent(date)}` : ""}`;
  // TODAY'S BOWL, ONE LIST (David 2026-09-07): a rotating recipe used to open
  // as its whole pool at the table's pooled total ("all 12 ingredients", 1.5
  // cup), then the recipe page said 7 of 12 at 1 cup. The card now shows the
  // same thing the page does: this day's picks, scaled to this eater's bowl.
  const rotating = rotates(recipe);
  const noun = rotationNoun(recipe);
  const rotationDate = date ?? localIsoDate(new Date());
  const chosen = rotating ? rotateComponents(recipe.rotation, rotationDate) : null;
  const ratio = plan.eatServings / Math.max(1, Number(recipe.servings) || 1);
  const rows = chosen
    ? chosen.picks.map((/** @type {any} */ c) => ({
        ...c,
        qty: scaleQty(Number(c.qty) || 0, c.unit, ratio),
      }))
    : plan.ingredients;
  const picked = new Set((chosen?.picks ?? []).map((/** @type {any} */ c) => c.food));
  const offShelf = chosen
    ? (recipe.rotation.pool ?? [])
        .filter((/** @type {any} */ c) => !picked.has(c.food))
        .map((/** @type {any} */ c) => c.food)
    : [];

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
          ${
            // a bowl is one bowl; "0.75 servings" beside "ONE bowl: yours" is
            // the app talking to itself (the 2026-08-10 no-serving-counts rule)
            plan.eatServings && plan.mode !== "bowl"
              ? html` · ${plan.eatServings} serving${plan.eatServings === 1 ? "" : "s"}`
              : ""
          }
        </div>
        ${plan.note && html`<p class="hint">${plan.note}</p>`}
        ${
          unshopped &&
          html`<p class="hint peekreceipt">
            No receipt scanned for this week yet, so nothing here is confirmed bought. Cook it
            anyway if you already have the food. <a href="#/list">scan the receipt →</a>
          </p>`
        }
        <h3 class="block-title">${rotating ? `Ingredients · today's ${noun}` : "Ingredients"}</h3>
        ${
          chosen &&
          html`<p class="hint">
            ${`${chosen.rotated.length} of ${recipe.rotation.pool.length} toppings, chosen for ${rotationDate}. Same day, same ${noun}.`}
          </p>`
        }
        <div class="slots">
          ${rows.map(
            (/** @type {any} */ ing, /** @type {number} */ i) => html`
              <div class="checkrow static" key=${`${ing.food}-${i}`}>
                <span class="food"
                  >${ing.food}${ing.staple ? html` <span class="tag">staple</span>` : ""}</span
                >
                <span class="q num">${formatRecipeQty(ing.qty, ing.unit)}</span>
              </div>
            `,
          )}
          ${(rows ?? []).length === 0 && html`<div class="empty">no ingredients recorded</div>`}
        </div>
        ${
          offShelf.length > 0 &&
          html`<p class="hint">${`Not in today's ${noun}: ${offShelf.join(" · ")}`}</p>`
        }
        <div class="actions wrap peekactions">
          <a class="ask linkbtn" href=${cookHref} onClick=${onClose}
            >👩‍🍳 COOK IT
            <small>full recipe · timer · steps</small>
          </a>
        </div>
      </div>
    </div>
  `;
}
