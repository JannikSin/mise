import { html } from "htm/preact";
import { localIsoDate, parseLocalIso } from "../lib/dates.js";
import { recipesById, SLOT_KEYS, SLOT_META } from "../lib/plan.js";

/**
 * Cook view: today's planned meals in full (moved out of Home), each
 * tapping through to its recipe, plus a link out to the full recipe
 * library.
 * @param {{
 *   recipes: Record<string, any>[],
 *   plan: { week: string, entries: Record<string, any>[] },
 *   hasToken: boolean,
 *   loading: boolean
 * }} props
 */
export function TodayView({ recipes, plan, hasToken, loading }) {
  const byId = recipesById(recipes);
  const today = localIsoDate(new Date());
  const todayEntries = plan.entries
    .filter((e) => e.date === today)
    .sort((a, b) => SLOT_KEYS.indexOf(a.slot) - SLOT_KEYS.indexOf(b.slot));

  // 7b: Sunday batch-prep block — every recipe in THIS week's plan with
  // batchPrep data. sundayComponent is deduped by recipe (cook it once,
  // regardless of how many days it's stacked on); weekdayAssembly is kept
  // per planned day since the reheat note is about that day, not the dish.
  const seenSunday = new Set();
  const sundayComponents = [];
  const weekdayAssembly = [];
  for (const entry of plan.entries) {
    if (!entry.recipeId) continue;
    const recipe = byId.get(entry.recipeId);
    const bp = recipe?.batchPrep;
    if (!bp) continue;
    if (bp.sundayComponent && !seenSunday.has(recipe.id)) {
      seenSunday.add(recipe.id);
      sundayComponents.push({ id: recipe.id, name: recipe.name, text: bp.sundayComponent });
    }
    if (bp.weekdayAssembly) {
      weekdayAssembly.push({ id: entry.id, date: entry.date, name: recipe.name, text: bp.weekdayAssembly });
    }
  }
  weekdayAssembly.sort((a, b) => a.date.localeCompare(b.date));
  const hasBatchPrep = sundayComponents.length > 0 || weekdayAssembly.length > 0;
  const isSunday = parseLocalIso(today).getDay() === 0;

  return html`
    <div class="view">
      <div class="hero"><h1>Cook</h1></div>

      <h2 class="block-title">Today's meals</h2>
      ${
        loading
          ? html`<p class="hint">loading…</p>`
          : todayEntries.length === 0
            ? html`<p class="hint">
                ${
                  hasToken
                    ? html`nothing planned for today — <a href="#/plan">open PLAN</a>`
                    : "no recipes yet — connect your token in SYS"
                }
              </p>`
            : html`<div class="todaylist">
                ${todayEntries.map((entry) => {
                  const recipe = entry.recipeId ? byId.get(entry.recipeId) : null;
                  const label = SLOT_META[entry.slot]?.label ?? entry.slot;
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
      ${
        hasBatchPrep &&
        html`<details class="batchprep" open=${isSunday}>
          <summary class="block-title">Batch prep</summary>
          ${sundayComponents.map(
            (r) => html`<div class="batch" key=${r.id}>
              <div class="k">${r.name} — Sunday</div>
              ${r.text}
            </div>`,
          )}
          ${weekdayAssembly.map(
            (w) => html`<div class="batch" key=${w.id}>
              <div class="k">
                ${parseLocalIso(w.date).toLocaleDateString([], { weekday: "short" })} · ${w.name}
              </div>
              ${w.text}
            </div>`,
          )}
        </details>`
      }

      <div class="actions">
        <a class="secondary linkbtn" href="#/cookbook">browse all recipes →</a>
      </div>
    </div>
  `;
}
