import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { recipesById, SLOT_KEYS, SLOT_META } from "../lib/plan.js";
import { parseLocalIso } from "../lib/dates.js";
import { SERVINGS_MIN, SERVINGS_MAX } from "../lib/tables.js";

const SLOTS = SLOT_KEYS.map((key) => ({ key, ...(SLOT_META[key] ?? { label: key, full: key }) }));

/**
 * Tables tab: every shared meal I'm part of, managed in one place (moved off
 * the top of Plan, where a mid-week table used to hijack the feed). Lists
 * today-onward tables across every relevant house, hosts the create form and
 * the AI plate-tailoring. Plan keeps only the read-only derived entries in
 * its day grid. This tab is the seed of the future group tab.
 * @param {{
 *   houseEvents: { house: string, events: import("../lib/tables.js").HouseEvents }[],
 *   profiles: Record<string, any>[],
 *   me: string,
 *   todayIso: string,
 *   hasToken: boolean,
 *   repo: Record<string, any> | null,
 *   tableConflicts: { table: import("../lib/tables.js").TableEvent, reasons: string[] }[],
 *   tableCollisions: import("../lib/tables.js").TableEvent[],
 *   bankRecipes: Record<string, any>[],
 *   onCreateTable: (t: { name: string, date: string, slot: string, recipeId: string, seats: import("../lib/tables.js").Seat[] }) => void,
 *   onRemoveTable: (house: string, id: string) => void,
 *   onPatchSeat: (house: string, tableId: string, patch: Partial<import("../lib/tables.js").Seat>) => void,
 *   onSeatScreen: (recipeId: string) => Promise<Record<string, string[]>>,
 *   onTailorTable: (house: string, tableId: string) => Promise<void>
 * }} props
 */
export function TablesView({
  houseEvents,
  profiles,
  me,
  todayIso,
  hasToken,
  repo,
  tableConflicts,
  tableCollisions,
  bankRecipes,
  onCreateTable,
  onRemoveTable,
  onPatchSeat,
  onSeatScreen,
  onTailorTable,
}) {
  const byId = recipesById(bankRecipes ?? []);
  const myHouse = /** @type {string} */ (
    (profiles ?? []).find((p) => p.id === me)?.household ?? "home"
  );
  // every upcoming table relevant to me: I'm seated, or it's at my house.
  // Past tables are the money ledger's business, not this list's.
  const myTables = (houseEvents ?? [])
    .flatMap(({ house, events }) =>
      events.tables
        .filter(
          (t) =>
            typeof t.date === "string" &&
            t.date >= todayIso &&
            (house === myHouse || (t.seats ?? []).some((s) => s.id === me)),
        )
        .map((t) => ({ house, t })),
    )
    .sort((a, b) => a.t.date.localeCompare(b.t.date) || a.t.slot.localeCompare(b.t.slot));
  const conflictIds = new Set((tableConflicts ?? []).map((c) => c.table.id));
  const collisionIds = new Set((tableCollisions ?? []).map((t) => t.id));
  const nameOf = (/** @type {string} */ id) =>
    (profiles ?? []).find((p) => p.id === id)?.name ?? id;
  const tokenBlocked = !hasToken || repo?.auth === "invalid";

  // AI plate-tailoring per table: busy flag + last error, keyed by table id
  const [tailorBusy, setTailorBusy] = useState(/** @type {string | null} */ (null));
  const [tailorErr, setTailorErr] = useState(/** @type {Record<string, string>} */ ({}));
  const runTailor = async (/** @type {string} */ house, /** @type {string} */ tableId) => {
    if (tailorBusy) return;
    setTailorBusy(tableId);
    setTailorErr({ ...tailorErr, [tableId]: "" });
    try {
      await onTailorTable(house, tableId);
    } catch (err) {
      setTailorErr({
        ...tailorErr,
        [tableId]: err instanceof Error ? err.message : "tailoring failed — try again",
      });
    }
    setTailorBusy(null);
  };

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
      date: todayIso,
      slot: "dinner",
      recipeId: firstDinner?.id ?? bank[0]?.id ?? "",
      seats,
    });
  };
  useEffect(() => {
    if (!tableForm?.recipeId) return;
    setSeatWarnings({});
    void onSeatScreen(tableForm.recipeId).then(setSeatWarnings);
  }, [tableForm?.recipeId]);
  const submitTable = () => {
    if (!tableForm || !tableForm.recipeId || !tableForm.date) return;
    if (tableForm.date < todayIso) return; // past tables can't be set
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

  return html`
    <div class="view">
      <div class="hero"><h1>Table</h1></div>
      <p class="hint">
        a table is one shared meal: pick a recipe, seat people, everyone eats the same dish at their
        own portion and their day replans around it. Money from finished tables settles on the List
        tab.
      </p>
      ${
        tokenBlocked &&
        myTables.length > 0 &&
        html`<p class="hint">
          ✨ plate tailoring needs the token —
          ${repo?.auth === "invalid" ? "renew it in SYS" : "connect it in SYS"}
        </p>`
      }
      ${
        myTables.length === 0 &&
        !tableForm &&
        html`<p class="hint">
          no upcoming tables — set one below, or talk it out on
          <a href="#/dinner">tonight's dinner</a>.
        </p>`
      }
      ${myTables.map(({ house, t }) => {
        const mySeat = (t.seats ?? []).find((s) => s.id === me);
        const skipped = mySeat?.status === "skipped";
        const conflicted = conflictIds.has(t.id);
        return html`
          <div class="tile tablecard ${skipped ? "skipped" : ""}" key=${t.id}>
            <div class="k">
              🍽 ${t.name} ·
              ${`${parseLocalIso(t.date).toLocaleDateString([], {
                weekday: "short",
                month: "short",
                day: "numeric",
              })} ${SLOT_META[t.slot]?.label ?? t.slot}`}
              · ${byId.get(t.recipeId)?.name ?? t.recipeId}
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
            ${
              t.tailor &&
              html`<div class="d" role="status">
                ${Object.entries(t.tailor.seats ?? {}).map(
                  ([sid, notes]) => html`
                    <div class="d" key=${sid}>
                      ✨ ${nameOf(sid)}: ${notes.plate.join(" · ")}
                      <span class="num"> · ~${notes.estCalories} kcal · ${notes.estProtein}P</span>
                    </div>
                  `,
                )}
                ${(t.tailor.cook ?? []).map(
                  (/** @type {string} */ c) => html`<div class="hint" key=${c}>👨‍🍳 ${c}</div>`,
                )}
              </div>`
            }
            ${
              tailorErr[t.id] &&
              html`<div class="d num redflag" role="status">${tailorErr[t.id]}</div>`
            }
            <div class="actions wrap">
              ${
                mySeat &&
                html`<button
                  class="secondary"
                  disabled=${
                    tailorBusy === t.id ||
                    tokenBlocked ||
                    (t.seats ?? []).every((s) => s.status === "skipped")
                  }
                  onClick=${() => runTailor(house, t.id)}
                >
                  ${
                    tailorBusy === t.id
                      ? "TAILORING…"
                      : t.tailor
                        ? "✨ RE-TAILOR"
                        : "✨ TAILOR PLATES"
                  }
                </button>`
              }
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
                <input
                  type="date"
                  aria-label="Day"
                  min=${todayIso}
                  max=${`${Number(todayIso.slice(0, 4)) + 1}${todayIso.slice(4)}`}
                  value=${tableForm.date}
                  onInput=${(/** @type {any} */ e) =>
                    setTableForm({ ...tableForm, date: e.currentTarget.value })}
                />
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
      <div class="actions">
        <a class="secondary linkbtn" href="#/dinner">💬 what should dinner be? →</a>
      </div>
    </div>
  `;
}
