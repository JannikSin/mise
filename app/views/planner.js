import { html } from "htm/preact";
import { useEffect, useRef } from "preact/hooks";
import { initDrag } from "../lib/drag.js";
import { datesOfWeek, dayTotals, entriesAt, SLOT_KEYS } from "../lib/plan.js";
import { statusDate } from "../lib/dates.js";

/** @type {Record<string, { label: string, full: string }>} */
const SLOT_META = {
  breakfast: { label: "BRK", full: "Breakfast" },
  lunch: { label: "LUN", full: "Lunch" },
  dinner: { label: "DIN", full: "Dinner" },
  smoothie: { label: "SMO", full: "Smoothie" },
  snack: { label: "SNK", full: "Snack" },
};

const SLOTS = SLOT_KEYS.map((key) => ({ key, ...(SLOT_META[key] ?? { label: key, full: key }) }));

const FREE_TEXT = ["leftovers", "eating out"];

/**
 * @param {string} isoDate
 */
function monthDay(isoDate) {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

/**
 * Drag-and-drop weekly planner (blueprint §6.3). Drag a recipe chip from the
 * tray into a slot; drag a filled slot to another slot to move it; ✕ removes.
 * Known gap (accepted for Phase 1, fast-follow planned): add is drag-only —
 * no keyboard/switch-control path yet; remove is a plain button.
 * @param {{
 *   recipes: Record<string, any>[],
 *   plan: import("../lib/plan.js").Plan,
 *   targets: Record<string, any> | null,
 *   hasToken: boolean,
 *   loading: boolean,
 *   weekId: string,
 *   onWeek: (delta: number) => void,
 *   onDropInto: (date: string, slot: string, drag: DOMStringMap) => void,
 *   onRemove: (id: string) => void
 * }} props
 */
export function PlannerView({
  recipes,
  plan,
  targets,
  hasToken,
  loading,
  weekId,
  onWeek,
  onDropInto,
  onRemove,
}) {
  const rootRef = useRef(/** @type {HTMLElement | null} */ (null));
  // latest-callback ref: the drag engine attaches ONCE and never re-attaches
  // mid-gesture, regardless of parent re-renders
  const dropRef = useRef(onDropInto);
  dropRef.current = onDropInto;

  const byId = new Map(recipes.map((r) => [r.id, r]));
  const dates = datesOfWeek(weekId);
  const kcalTarget = targets?.macros?.calories ?? 3400;
  const proteinTarget = targets?.macros?.protein ?? 210;

  useEffect(() => {
    if (!rootRef.current) return;
    return initDrag(rootRef.current, (drag, drop) => {
      if (!drop.date || !drop.slot) return;
      dropRef.current(drop.date, drop.slot, drag);
    });
  }, []);

  return html`
    <div class="view" ref=${rootRef}>
      <div class="hero weeknav">
        <button class="wk" aria-label="Previous week" onClick=${() => onWeek(-1)}>‹</button>
        <div class="wkmid">
          <h1>Plan <span class="num">${weekId.split("-")[1]}</span></h1>
          <div class="sub num">${monthDay(dates[0] ?? "")} – ${monthDay(dates[6] ?? "")}</div>
        </div>
        <button class="wk" aria-label="Next week" onClick=${() => onWeek(1)}>›</button>
      </div>

      <div class="tray" aria-label="Drag a recipe into a day">
        ${recipes.map(
          (r) => html`
            <div class="drag-chip" data-drag="recipe" data-recipe=${r.id} key=${r.id}>
              <span class="grip" aria-hidden="true">⠿</span>
              <span class="chipbody">
                <span class="n">${r.name}</span>
                <span class="m num">${r.nutrition?.calories} · ${r.nutrition?.protein}P</span>
              </span>
            </div>
          `,
        )}
        ${FREE_TEXT.map(
          (t) => html`
            <div class="drag-chip text" data-drag="text" data-text=${t} key=${t}>
              <span class="grip" aria-hidden="true">⠿</span>
              <span class="chipbody"><span class="n">${t}</span></span>
            </div>
          `,
        )}
        ${
          recipes.length === 0 &&
          html`<div class="empty traymsg">
            ${hasToken ? (loading ? "loading recipes…" : "no recipes yet") : "connect token in SYS to load recipes"}
          </div>`
        }
      </div>
      <p class="hint traylabel">
        drag down into a slot · scroll tray sideways ${!targets && html` · using default targets`}
      </p>

      ${dates.map((date) => {
        const totals = dayTotals(/** @type {any} */ (plan.entries), byId, date);
        const kcalPct = Math.min(100, Math.round((totals.calories / kcalTarget) * 100));
        const pPct = Math.min(100, Math.round((totals.protein / proteinTarget) * 100));
        const kcalOk = totals.calories / kcalTarget >= 0.9;
        const pOk = totals.protein / proteinTarget >= 0.9;
        return html`
          <section class="day" key=${date}>
            <h2 class="block-title">${statusDate(new Date(`${date}T12:00:00`))}</h2>
            <div class="meters">
              <div class="meterline ${kcalOk ? "" : "warn"}">
                <span class="k num">${totals.calories} / ${kcalTarget} kcal</span>
                <div
                  class="meter"
                  role="progressbar"
                  aria-label="Calories planned"
                  aria-valuenow=${totals.calories}
                  aria-valuemin="0"
                  aria-valuemax=${kcalTarget}
                >
                  <i style=${`width:${kcalPct}%`}></i>
                </div>
              </div>
              <div class="meterline ${pOk ? "" : "warn"}">
                <span class="k num">${totals.protein} / ${proteinTarget}g P</span>
                <div
                  class="meter"
                  role="progressbar"
                  aria-label="Protein planned"
                  aria-valuenow=${totals.protein}
                  aria-valuemin="0"
                  aria-valuemax=${proteinTarget}
                >
                  <i style=${`width:${pPct}%`}></i>
                </div>
              </div>
            </div>
            <div class="slotgrid">
              ${SLOTS.map(({ key, label, full }) => {
                const stacked = entriesAt(plan.entries, date, key);
                return html`
                  <div class="slotrow" data-drop data-date=${date} data-slot=${key} key=${key}>
                    <span class="t" aria-label=${full}>${label}</span>
                    ${
                      stacked.length === 0
                        ? html`<span class="emptyslot">—</span>`
                        : html`<div class="stack">
                            ${stacked.map((entry) => {
                              const recipe = entry.recipeId ? byId.get(entry.recipeId) : null;
                              const name = recipe ? recipe.name : entry.freeText;
                              return html`
                                <div class="stackline" key=${entry.id}>
                                  <div class="fill drag-chip" data-drag="move" data-id=${entry.id}>
                                    <span class="grip" aria-hidden="true">⠿</span>
                                    <span class="chipbody">
                                      <span class="n">${name}</span>
                                      ${
                                        recipe &&
                                        html`<span class="m num"
                                          >${recipe.nutrition?.calories} ·
                                          ${recipe.nutrition?.protein}P</span
                                        >`
                                      }
                                    </span>
                                  </div>
                                  <button
                                    class="rm"
                                    aria-label="Remove ${name} from ${label}"
                                    onClick=${() => onRemove(entry.id)}
                                  >
                                    ✕
                                  </button>
                                </div>
                              `;
                            })}
                          </div>`
                    }
                  </div>
                `;
              })}
            </div>
          </section>
        `;
      })}
    </div>
  `;
}
