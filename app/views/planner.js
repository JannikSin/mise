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
import { SERVINGS_MIN, SERVINGS_MAX } from "../lib/tables.js";

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
 *   todayIso: string,
 *   onWeek: (delta: number) => void,
 *   onDropInto: (date: string, slot: string, drag: DOMStringMap) => void,
 *   onRemove: (id: string) => void,
 *   onTogglePin: (id: string) => void,
 *   onToggleOut: (date: string, slot: string) => void,
 *   onGenerateWeek: () => void,
 *   buildReport: import("../lib/weekbuilder.js").WeekReport | null,
 *   rebuilt: boolean,
 *   houseEvents: { house: string, events: import("../lib/tables.js").HouseEvents }[],
 *   profiles: Record<string, any>[],
 *   me: string,
 *   tableConflicts: { table: import("../lib/tables.js").TableEvent, reasons: string[] }[],
 *   tableCollisions: import("../lib/tables.js").TableEvent[],
 *   tableStale: boolean,
 *   bankRecipes: Record<string, any>[],
 *   onCreateTable: (t: { name: string, date: string, slot: string, recipeId: string, seats: import("../lib/tables.js").Seat[] }) => void,
 *   onRemoveTable: (house: string, id: string) => void,
 *   onPatchSeat: (house: string, tableId: string, patch: Partial<import("../lib/tables.js").Seat>) => void,
 *   onSeatScreen: (recipeId: string) => Promise<Record<string, string[]>>
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
  todayIso,
  onWeek,
  onDropInto,
  onRemove,
  onTogglePin,
  onToggleOut,
  onGenerateWeek,
  buildReport,
  rebuilt,
  houseEvents,
  profiles,
  me,
  tableConflicts,
  tableCollisions,
  tableStale,
  bankRecipes,
  onCreateTable,
  onRemoveTable,
  onPatchSeat,
  onSeatScreen,
}) {
  const rootRef = useRef(/** @type {HTMLElement | null} */ (null));
  // tray meal filter: at ~50 recipes an unfiltered tray is unusable (David)
  const [trayFilter, setTrayFilter] = useState(/** @type {string | null} */ (null));
  // latest-callback ref: the drag engine attaches ONCE and never re-attaches
  // mid-gesture, regardless of parent re-renders
  const dropRef = useRef(onDropInto);
  dropRef.current = onDropInto;
  const todayRef = useRef(todayIso);
  todayRef.current = todayIso;

  const byId = recipesById(recipes);
  const dates = datesOfWeek(weekId);
  const weekSet = new Set(dates);
  const myHouse = /** @type {string} */ (
    (profiles ?? []).find((p) => p.id === me)?.household ?? "home"
  );
  // every table relevant to me this week: I'm seated, or it's at my house
  const myTables = (houseEvents ?? []).flatMap(({ house, events }) =>
    events.tables
      .filter(
        (t) =>
          weekSet.has(t.date) && (house === myHouse || (t.seats ?? []).some((s) => s.id === me)),
      )
      .map((t) => ({ house, t })),
  );
  const conflictIds = new Set((tableConflicts ?? []).map((c) => c.table.id));
  const collisionIds = new Set((tableCollisions ?? []).map((t) => t.id));
  const nameOf = (/** @type {string} */ id) =>
    (profiles ?? []).find((p) => p.id === id)?.name ?? id;

  // CREATE TABLE form state
  const [tableForm, setTableForm] = useState(
    /** @type {null | { name: string, date: string, slot: string, recipeId: string, seats: Record<string, { in: boolean, servings: number }> }} */ (
      null
    ),
  );
  const [seatWarnings, setSeatWarnings] = useState(/** @type {Record<string, string[]>} */ ({}));
  const openTableForm = () => {
    /** @type {Record<string, { in: boolean, servings: number }>} */
    const seats = {};
    for (const p of profiles ?? []) seats[p.id] = { in: p.id === me, servings: 1 };
    const bank = bankRecipes ?? [];
    const firstDinner = bank.find((r) => r.mealType === "dinner");
    setSeatWarnings({});
    setTableForm({
      name: "",
      date: dates.find((d) => !isPast(d)) ?? dates[0] ?? "",
      slot: "dinner",
      recipeId: firstDinner?.id ?? bank[0]?.id ?? "",
      seats,
    });
  };
  const screenRecipe = (/** @type {string} */ recipeId) => {
    setSeatWarnings({});
    void onSeatScreen(recipeId).then(setSeatWarnings);
  };
  useEffect(() => {
    if (tableForm?.recipeId) screenRecipe(tableForm.recipeId);
  }, [tableForm?.recipeId]);
  const submitTable = () => {
    if (!tableForm || !tableForm.recipeId || !tableForm.date) return;
    const seats = Object.entries(tableForm.seats)
      .filter(([, v]) => v.in)
      .map(([id, v]) => ({ id, servings: v.servings }));
    if (seats.length === 0) return;
    onCreateTable({
      name: tableForm.name.trim() || "Table",
      date: tableForm.date,
      slot: tableForm.slot,
      recipeId: tableForm.recipeId,
      seats,
    });
    setTableForm(null);
  };
  const kcalTarget = targets?.macros?.calories ?? 3400;
  const proteinTarget = targets?.macros?.protein ?? 210;
  // a past day is read-only: already eaten, never a drop target, never
  // re-rolled (generateWeek leaves it alone). Only the current week has any.
  const isPast = (/** @type {string} */ d) => Boolean(todayRef.current) && d < todayRef.current;
  const firstLive = dates.find((d) => !isPast(d));
  const midWeek = firstLive != null && dates.some((d) => isPast(d));

  useEffect(() => {
    if (!rootRef.current) return;
    return initDrag(rootRef.current, (drag, drop) => {
      if (!drop.date || !drop.slot) return;
      if (isPast(drop.date)) return; // belt+suspenders: past rows carry no data-drop
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
          disabled=${recipes.length === 0 || Boolean(plan.locked) || firstLive == null}
        >
          ${rebuilt ? "RE-ROLL WEEK" : "✦ GENERATE MY WEEK"}
          <small>
            ${
              plan.locked
                ? "🔒 locked — you shopped for this week. Unlock on the List tab to change it."
                : firstLive == null
                  ? "this week is over, nothing left to plan"
                  : midWeek
                    ? firstLive === dates[6]
                      ? "plans today only · earlier days already eaten · pinned entries are kept"
                      : `plans ${parseLocalIso(firstLive).toLocaleDateString([], { weekday: "short" })}–Sun · earlier days already eaten · pinned entries are kept`
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
          <div class="d">
            fix: add recipes to the bank that fit this profile's diet/phase, or relax its filters in
            SYS.
          </div>
        </div>`
      }
      ${
        plan.buffer &&
        byId.get(plan.buffer.recipeId) &&
        html`<div class="tile buffer">
          <div class="k">🧺 weekly buffer snack</div>
          <div class="d num">
            ${byId.get(plan.buffer.recipeId).name} · ${plan.buffer.portions} portions
            ${midWeek ? "batched at next chance" : "batched Sunday"} ·
            ~${byId.get(plan.buffer.recipeId).nutrition?.calories} kcal ·
            ${byId.get(plan.buffer.recipeId).nutrition?.protein}P each · tally on COOK
          </div>
        </div>`
      }

      <h2 class="block-title">Tables</h2>
      ${
        tableStale &&
        html`<p class="hint">
          ⚠ a table landed after this week was generated — RE-ROLL to plan the day around it and
          rebuild the list.
        </p>`
      }
      ${
        myTables.length === 0 &&
        !tableForm &&
        html`<p class="hint">
          a table is one shared meal: pick a recipe, seat people, everyone eats the same dish at
          their own portion and their day replans around it.
        </p>`
      }
      ${myTables.map(({ house, t }) => {
        const mySeat = (t.seats ?? []).find((s) => s.id === me);
        const skipped = mySeat?.status === "skipped";
        const conflicted = conflictIds.has(t.id);
        return html`
          <div class="tile tablecard ${skipped ? "skipped" : ""}" key=${t.id}>
            <div class="k">
              🍽 ${t.name} · ${parseLocalIso(t.date).toLocaleDateString([], { weekday: "short" })}
              ${SLOT_META[t.slot]?.label ?? t.slot} · ${byId.get(t.recipeId)?.name ?? t.recipeId}
              ${house !== myHouse && html` · at ${house}`}
            </div>
            <div class="d num">
              ${(t.seats ?? [])
                .map(
                  (s) => `${nameOf(s.id)} ×${s.servings}${s.status === "skipped" ? " (out)" : ""}`,
                )
                .join(" · ")}
              · cook total
              ×${(t.seats ?? [])
                .filter((s) => s.status !== "skipped")
                .reduce((sum, s) => sum + (Number(s.servings) || 0), 0)}
            </div>
            ${
              conflicted &&
              html`<div class="d num redflag">
                ⚠ conflicts with your diet list — not added to your plan
              </div>`
            }
            ${
              collisionIds.has(t.id) &&
              html`<div class="d num redflag">
                your ${SLOT_META[t.slot]?.full ?? t.slot} that day is pinned or marked OUT — unpin
                or clear it to sit at this table
              </div>`
            }
            <div class="actions wrap">
              ${
                mySeat &&
                html`<button
                  class="secondary"
                  onClick=${() => onPatchSeat(house, t.id, { status: skipped ? "in" : "skipped" })}
                >
                  ${skipped ? "REJOIN" : "SKIP MINE"}
                </button>`
              }
              ${
                house === myHouse &&
                html`<button class="secondary" onClick=${() => onRemoveTable(house, t.id)}>
                  CANCEL TABLE
                </button>`
              }
            </div>
          </div>
        `;
      })}
      ${
        !tableForm
          ? html`<div class="actions">
              <button class="secondary" onClick=${openTableForm}>+ SET A TABLE</button>
            </div>`
          : html`<div class="tile tableform">
              <div class="k">Set a table</div>
              <input
                aria-label="Table name"
                placeholder="e.g. family dinner"
                value=${tableForm.name}
                onInput=${(/** @type {any} */ e) =>
                  setTableForm({ ...tableForm, name: e.currentTarget.value })}
              />
              <div class="row">
                <select
                  aria-label="Day"
                  value=${tableForm.date}
                  onInput=${(/** @type {any} */ e) =>
                    setTableForm({ ...tableForm, date: e.currentTarget.value })}
                >
                  ${dates.map(
                    (d) =>
                      html`<option value=${d} disabled=${isPast(d)}>
                        ${parseLocalIso(d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
                      </option>`,
                  )}
                </select>
                <select
                  aria-label="Meal slot"
                  value=${tableForm.slot}
                  onInput=${(/** @type {any} */ e) =>
                    setTableForm({ ...tableForm, slot: e.currentTarget.value })}
                >
                  ${SLOTS.map(({ key, full }) => html`<option value=${key}>${full}</option>`)}
                </select>
              </div>
              <select
                aria-label="Recipe everyone shares"
                value=${tableForm.recipeId}
                onInput=${(/** @type {any} */ e) =>
                  setTableForm({ ...tableForm, recipeId: e.currentTarget.value })}
              >
                ${
                  /* bank only: a table on someone's personal recipe variant
                     has no honest macros for the other seats */
                  (bankRecipes ?? []).map((r) => html`<option value=${r.id}>${r.name}</option>`)
                }
              </select>
              ${(profiles ?? []).map((p) => {
                const seat = tableForm.seats[p.id] ?? { in: false, servings: 1 };
                const warns = seatWarnings[p.id] ?? [];
                return html`
                  <div class="row" key=${p.id}>
                    <label class="tickarea">
                      <input
                        type="checkbox"
                        checked=${seat.in}
                        onInput=${(/** @type {any} */ e) =>
                          setTableForm({
                            ...tableForm,
                            seats: {
                              ...tableForm.seats,
                              [p.id]: { ...seat, in: e.currentTarget.checked },
                            },
                          })}
                      />
                      ${p.emoji ?? ""} ${p.name ?? p.id}
                      ${
                        seat.in &&
                        warns.length > 0 &&
                        html`<span class="usesoon">⚠ ${warns.join(", ")}</span>`
                      }
                    </label>
                    ${
                      seat.in &&
                      html`<input
                          class="num seatservings"
                          type="number"
                          min=${SERVINGS_MIN}
                          max=${SERVINGS_MAX}
                          step="0.5"
                          aria-label="Servings for ${p.name ?? p.id}"
                          value=${seat.servings}
                          onInput=${(/** @type {any} */ e) =>
                            setTableForm({
                              ...tableForm,
                              seats: {
                                ...tableForm.seats,
                                [p.id]: { ...seat, servings: Number(e.currentTarget.value) || 1 },
                              },
                            })}
                        /><span class="hint num">servings</span>`
                    }
                  </div>
                `;
              })}
              <div class="actions">
                <button class="secondary" onClick=${() => setTableForm(null)}>CANCEL</button>
                <button class="primary" onClick=${submitTable}>SET TABLE</button>
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
        const past = isPast(date);
        const totals = dayTotals(/** @type {any} */ (plan.entries), byId, date);
        const kcalPct = Math.min(100, Math.round((totals.calories / kcalTarget) * 100));
        const pPct = Math.min(100, Math.round((totals.protein / proteinTarget) * 100));
        // out slots carry an assumed macro credit (dayTotals counts it), so
        // the meters and warn styling stay honest without special-casing
        const dayOut = SLOTS.some(({ key }) => outEntryAt(plan.entries, date, key));
        const dayTable = plan.entries.find((e) => e.date === date && e.table);
        const kcalOk = totals.calories / kcalTarget >= 0.9;
        const pOk = totals.protein / proteinTarget >= 0.9;
        return html`
          <section class="day ${past ? "past" : ""}" key=${date}>
            <h2 class="block-title">
              ${statusDate(parseLocalIso(date))}${past && html`<span class="eaten">✓ eaten</span>`}${dayOut && html`<span class="outday"> · 🍴 out</span>`}${dayTable && html`<span class="outday"> · adjusted around ${dayTable.freeText}</span>`}
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
                if (past) {
                  // read-only: what was eaten, nothing draggable, no controls
                  return html`
                    <div class="slotrow" key=${key}>
                      <span class="t" aria-label=${full}>${label}</span>
                      ${outEntry && html`<span class="outslot">🍴 ate out</span>`}
                      ${!outEntry && stacked.length === 0 && html`<span class="emptyslot">—</span>`}
                      ${
                        stacked.length > 0 &&
                        html`<div class="stack">
                          ${stacked.map((entry) => {
                            const recipe = entry.recipeId ? byId.get(entry.recipeId) : null;
                            return html`
                              <div class="stackline" key=${entry.id}>
                                <div class="fill drag-chip">
                                  <span class="chipbody">
                                    <span class="n">${recipe ? recipe.name : entry.freeText}</span>
                                    ${
                                      recipe &&
                                      html`<span class="m num"
                                        >${recipe.nutrition?.calories} ·
                                        ${recipe.nutrition?.protein}P</span
                                      >`
                                    }
                                  </span>
                                </div>
                              </div>
                            `;
                          })}
                        </div>`
                      }
                    </div>
                  `;
                }
                return html`
                  <div
                    class="slotrow ${outEntry ? "isout" : ""}"
                    data-drop
                    data-date=${date}
                    data-slot=${key}
                    key=${key}
                  >
                    <span class="t" aria-label=${full}>${label}</span>
                    ${
                      outEntry &&
                      html`<span class="outslot">
                        🍴 eating out
                        ${
                          outEntry.estCalories != null
                            ? html` ·
                                <span class="num"
                                  >~${outEntry.estCalories} kcal · ${outEntry.estProtein}P
                                  assumed</span
                                >`
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
                          if (entry.table) {
                            // derived table entry: lives in the house's
                            // events.json, not this plan — read-only here,
                            // managed from the Tables section above
                            return html`
                              <div class="stackline" key=${entry.id}>
                                <div class="fill drag-chip">
                                  <span class="chipbody">
                                    <span class="n">${name}</span>
                                    <span class="m num">
                                      ~${entry.estCalories} · ${entry.estProtein}P · table
                                    </span>
                                  </span>
                                </div>
                              </div>
                            `;
                          }
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
