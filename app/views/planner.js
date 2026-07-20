import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { initDrag } from "../lib/drag.js";
import {
  datesOfWeek,
  dayTotals,
  entriesAt,
  outEntryAt,
  OUT_TEXT,
  recipesById,
  SLOT_KEYS,
  SLOT_META,
} from "../lib/plan.js";
import { parseLocalIso, statusDate } from "../lib/dates.js";

const SLOTS = SLOT_KEYS.map((key) => ({ key, ...(SLOT_META[key] ?? { label: key, full: key }) }));

// OUT_TEXT by reference, not a copied literal: main.js routes a dropped chip
// with exactly that text through the slot's OUT toggle
const FREE_TEXT = ["leftovers", OUT_TEXT];

/**
 * @param {string} isoDate
 */
function monthDay(isoDate) {
  return parseLocalIso(isoDate).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

/**
 * Drag-and-drop weekly planner (blueprint §6.3). Drag a recipe chip from the
 * tray into a slot; drag a filled slot to another slot to move it; ✕ removes,
 * PIN protects an entry from GENERATE MY WEEK / RE-ROLL WEEK. GENERATE MY
 * WEEK clears and rebuilds every unpinned entry across all 7 days; a second
 * tap is a RE-ROLL over the same pinned base.
 * Known gap (accepted for Phase 1, fast-follow planned): add is drag-only —
 * no keyboard/switch-control path yet; remove is a plain button.
 * @param {{
 *   recipes: Record<string, any>[],
 *   plan: import("../lib/plan.js").Plan,
 *   targets: Record<string, any> | null,
 *   poolReport: { counts: Record<string, number>, warnings: string[] } | null,
 *   hasToken: boolean,
 *   loading: boolean,
 *   weekId: string,
 *   onWeek: (delta: number) => void,
 *   onDropInto: (date: string, slot: string, drag: DOMStringMap) => void,
 *   onRemove: (id: string) => void,
 *   onTogglePin: (id: string) => void,
 *   onToggleOut: (date: string, slot: string) => void,
 *   onGenerateWeek: () => void,
 *   buildReport: import("../lib/weekbuilder.js").WeekReport | null,
 *   rebuilt: boolean
 * }} props
 */
export function PlannerView({
  recipes,
  plan,
  targets,
  poolReport,
  hasToken,
  loading,
  weekId,
  onWeek,
  onDropInto,
  onRemove,
  onTogglePin,
  onToggleOut,
  onGenerateWeek,
  buildReport,
  rebuilt,
}) {
  const rootRef = useRef(/** @type {HTMLElement | null} */ (null));
  // tray meal filter: at ~50 recipes an unfiltered tray is unusable (David)
  const [trayFilter, setTrayFilter] = useState(/** @type {string | null} */ (null));
  // latest-callback ref: the drag engine attaches ONCE and never re-attaches
  // mid-gesture, regardless of parent re-renders
  const dropRef = useRef(onDropInto);
  dropRef.current = onDropInto;

  const byId = recipesById(recipes);
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

      <div class="actions">
        <button
          class="ask"
          aria-label=${
            plan.locked
              ? "Locked — unlock from the List tab to regenerate"
              : rebuilt
                ? "Re-roll the generated week"
                : "Generate my week automatically"
          }
          onClick=${onGenerateWeek}
          disabled=${recipes.length === 0 || Boolean(plan.locked)}
        >
          ${rebuilt ? "RE-ROLL WEEK" : "✦ GENERATE MY WEEK"}
          <small>
            ${
              plan.locked
                ? "🔒 locked — you shopped for this week. Unlock on the List tab to change it."
                : "overlapping ingredients → fewer, bulkier buys · pinned entries are kept"
            }
          </small>
        </button>
      </div>
      ${
        buildReport &&
        html`
          <div class="tile buildreport" role="status">
            <div class="k">This week shares</div>
            <div class="d num">
              ${
                buildReport.shared
                  .slice(0, 6)
                  .map((s) => `${s.food} ×${s.count}`)
                  .join(" · ") || "no overlap found"
              }
            </div>
            <div class="d num">${buildReport.distinctItems} distinct items to shop</div>
            ${
              buildReport.proteinShortDays.length > 0 &&
              html`<div class="d num redflag">
                ⚠ protein short:${" "}
                ${buildReport.proteinShortDays
                  .map(
                    (s) =>
                      `${parseLocalIso(s.date).toLocaleDateString([], { weekday: "short" })} ${s.protein}g`,
                  )
                  .join(" · ")}
                / ${buildReport.proteinShortDays[0]?.target}g — stack a slot or add a snack
              </div>`
            }
            ${
              buildReport.calorieShortDays.length > 0 &&
              html`<div class="d num redflag">
                ⚠ calories short:${" "}
                ${buildReport.calorieShortDays
                  .map(
                    (s) =>
                      `${parseLocalIso(s.date).toLocaleDateString([], { weekday: "short" })} ${s.calories}`,
                  )
                  .join(" · ")}
                / ${buildReport.calorieShortDays[0]?.target} — stack a slot or add a snack
              </div>`
            }
            ${
              buildReport.foodGroupGapsWeekly.length > 0 &&
              html`<div class="d num redflag">
                ⚠ nutrient gaps (week):${" "}
                ${buildReport.foodGroupGapsWeekly
                  .map((g) => `${g.group} ${g.have}/${g.target}`)
                  .join(" · ")}
              </div>`
            }
            ${
              buildReport.poolInsufficient.length > 0 &&
              html`<div class="d num redflag">
                ⚠ recipe pool:${" "}
                ${buildReport.poolInsufficient.map((p) => `${p.reason} — ${p.suggestion}`).join(" · ")}
              </div>`
            }
            ${
              (buildReport.outDays ?? []).length > 0 &&
              html`<div class="d num">
                🍴 eating out:${" "}
                ${buildReport.outDays
                  .map(
                    (o) =>
                      `${parseLocalIso(o.date).toLocaleDateString([], { weekday: "short" })} ${o.slots
                        .map((s) => SLOT_META[s]?.label ?? s)
                        .join("+")} ~${o.estCalories} kcal assumed`,
                  )
                  .join(" · ")}
                · not shopped, rest of the day planned around it
              </div>`
            }
            ${
              buildReport.calorieOverDays.length > 0 &&
              html`<div class="d num">
                day over calorie ceiling:${" "}
                ${buildReport.calorieOverDays
                  .map(
                    (s) =>
                      `${parseLocalIso(s.date).toLocaleDateString([], { weekday: "short" })} ${s.calories}`,
                  )
                  .join(" · ")}
                / ${buildReport.calorieOverDays[0]?.ceiling} ceiling
              </div>`
            }
          </div>
        `
      }

      ${
        // pool-adequacy warnings (new/edited profiles): the bank may simply
        // lack recipes for this profile's filters or calorie tier — say so
        // here, where the mystery of repeats would otherwise surface
        poolReport &&
        poolReport.warnings.length > 0 &&
        html`<div class="tile" role="status">
          <div class="k">⚠ recipe pool check</div>
          ${poolReport.warnings.map((w) => html`<div class="d num redflag" key=${w}>${w}</div>`)}
          <div class="d">fix: add recipes to the bank that fit this profile's diet/phase, or relax its filters in SYS.</div>
        </div>`
      }
      ${
        plan.buffer &&
        byId.get(plan.buffer.recipeId) &&
        html`<div class="tile buffer">
          <div class="k">🧺 weekly buffer snack</div>
          <div class="d num">
            ${byId.get(plan.buffer.recipeId).name} · ${plan.buffer.portions} portions batched Sunday
            · ~${byId.get(plan.buffer.recipeId).nutrition?.calories} kcal ·
            ${byId.get(plan.buffer.recipeId).nutrition?.protein}P each · tally on COOK
          </div>
        </div>`
      }

      <div class="chips" role="group" aria-label="Filter tray by meal">
        ${SLOTS.map(
          ({ key, label, full }) => html`
            <button
              class="chip ${trayFilter === key ? "on" : ""}"
              aria-pressed=${trayFilter === key}
              aria-label="Show ${full} recipes"
              key=${key}
              onClick=${() => setTrayFilter(trayFilter === key ? null : key)}
            >
              ${label}
            </button>
          `,
        )}
      </div>

      <div class="tray" aria-label="Drag a recipe into a day">
        ${recipes
          .filter((r) => !trayFilter || r.mealType === trayFilter)
          .map(
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
        // out slots carry an assumed macro credit (dayTotals counts it), so
        // the meters and warn styling stay honest without special-casing
        const dayOut = SLOTS.some(({ key }) => outEntryAt(plan.entries, date, key));
        const kcalOk = totals.calories / kcalTarget >= 0.9;
        const pOk = totals.protein / proteinTarget >= 0.9;
        return html`
          <section class="day" key=${date}>
            <h2 class="block-title">
              ${statusDate(parseLocalIso(date))}${dayOut && html`<span class="outday"> · 🍴 out</span>`}
            </h2>
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
                const outEntry = outEntryAt(plan.entries, date, key);
                const stacked = entriesAt(plan.entries, date, key).filter((e) => !e.out);
                return html`
                  <div class="slotrow ${outEntry ? "isout" : ""}" data-drop data-date=${date} data-slot=${key} key=${key}>
                    <span class="t" aria-label=${full}>${label}</span>
                    ${
                      outEntry &&
                      html`<span class="outslot">
                        🍴 eating out
                        ${
                          outEntry.estCalories != null
                            ? html` · <span class="num">~${outEntry.estCalories} kcal · ${outEntry.estProtein}P assumed</span>`
                            : " · not planned, not re-rolled"
                        }
                      </span>`
                    }
                    ${!outEntry && stacked.length === 0 && html`<span class="emptyslot">—</span>`}
                    ${
                      // real entries render even next to a placeholder: a
                      // two-device merge can resurrect a meal into an out
                      // slot, and hiding it would leave it silently shopped
                      stacked.length > 0 &&
                      html`<div class="stack">
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
                                    class="pin ${entry.pinned ? "on" : ""}"
                                    aria-pressed=${Boolean(entry.pinned)}
                                    aria-label=${
                                      entry.pinned
                                        ? `Unpin ${name} — GENERATE WEEK may replace it`
                                        : `Pin ${name} — GENERATE WEEK will keep it`
                                    }
                                    onClick=${() => onTogglePin(entry.id)}
                                  >
                                    PIN
                                  </button>
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
                    <button
                      class="outbtn ${outEntry ? "on" : ""}"
                      aria-pressed=${Boolean(outEntry)}
                      aria-label=${
                        outEntry
                          ? `${full} ${monthDay(date)} is eating out, tap to plan a meal again`
                          : `Mark ${full} ${monthDay(date)} as eating out: clears the slot, nothing shopped or re-rolled`
                      }
                      onClick=${() => onToggleOut(date, key)}
                    >
                      🍴 OUT
                    </button>
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
