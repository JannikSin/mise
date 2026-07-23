import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { localIsoDate, parseLocalIso } from "../lib/dates.js";
import { datesOfWeek, prepSundayOf, recipesById, SLOT_KEYS, SLOT_META } from "../lib/plan.js";
import { perishableStatus } from "../lib/shopping.js";

/**
 * Cook view: a day's planned meals in full (moved out of Home), each
 * tapping through to its recipe, plus a link out to the full recipe
 * library. Defaults to today, and the ‹ › arrows page through the week's
 * other days so meals can be pre-cooked ahead ("flip to Monday, prep its
 * breakfast and lunch, flip to Tuesday, ...").
 * Also hosts the weekly BUFFER snack tally: the one batch-prepped fridge
 * stand-by GENERATE picks per week (plan.buffer), with a per-day counter
 * stored in the daily check-in log — hunger gets a measured answer, not an
 * unplanned raid.
 * @param {{
 *   recipes: Record<string, any>[],
 *   plan: import("../lib/plan.js").Plan,
 *   tableConflicts: { table: import("../lib/tables.js").TableEvent, reasons: string[] }[],
 *   tableStale: boolean,
 *   nextPlan: import("../lib/plan.js").Plan | null,
 *   daily: { days?: Record<string, any>[] },
 *   pantry: Record<string, any>,
 *   onPatchDay: (patch: Record<string, any>) => void,
 *   hasToken: boolean,
 *   loading: boolean
 * }} props
 */
export function TodayView({
  recipes,
  plan,
  tableConflicts,
  tableStale,
  nextPlan,
  daily,
  pantry,
  onPatchDay,
  hasToken,
  loading,
}) {
  const byId = recipesById(recipes);
  const today = localIsoDate(new Date());
  const weekDates = datesOfWeek(plan.week);
  const todayIdx = weekDates.indexOf(today);
  // day being viewed, as an index into the week's Mon..Sun dates; today when
  // today is in the shown week, else Monday
  const [dayIdx, setDayIdx] = useState(todayIdx >= 0 ? todayIdx : 0);
  const selectedDate = weekDates[Math.min(dayIdx, weekDates.length - 1)] ?? today;
  const isToday = selectedDate === today;
  const dayLabel = isToday
    ? "Today"
    : parseLocalIso(selectedDate).toLocaleDateString([], { weekday: "long" });
  const daySub = parseLocalIso(selectedDate).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
  const todayEntries = plan.entries
    .filter((e) => e.date === selectedDate)
    .sort((a, b) => SLOT_KEYS.indexOf(a.slot) - SLOT_KEYS.indexOf(b.slot));

  // 7b: batch-prep block, day-aware (docs/day-aware-weeks-design.md). The
  // block always describes the week you can still batch FOR: the shown week
  // while its prep Sunday is ahead ("Sunday batch") or while it's underway
  // ("catch-up": that Sunday already passed), and on the shown week's own
  // closing Sunday the NEXT week — that evening's cooking preps the week
  // ahead, not the week ending tonight. A fully past week shows nothing.
  // sundayComponent is deduped by recipe (cook it once, regardless of how
  // many days it's stacked on); weekdayAssembly is kept per planned day
  // since the reheat note is about that day, not the dish.
  const batchForNext = today === weekDates[6];
  const pastWeek = !batchForNext && today > (weekDates[6] ?? "");
  const catchUp = !batchForNext && !pastWeek && today >= (weekDates[0] ?? "");
  const batchEntries = batchForNext ? (nextPlan?.entries ?? []) : plan.entries;
  const seenSunday = new Set();
  const sundayComponents = [];
  const weekdayAssembly = [];
  for (const entry of batchEntries) {
    if (!entry.recipeId) continue;
    // mid-week, an already-eaten day contributes nothing: no assembly note,
    // and no catch-up component for a dish with no remaining day to eat it
    // (a recipe also planned on a live day is still caught by that entry)
    if (catchUp && entry.date < today) continue;
    const recipe = byId.get(entry.recipeId);
    const bp = recipe?.batchPrep;
    if (!bp) continue;
    if (bp.sundayComponent && !seenSunday.has(recipe.id)) {
      seenSunday.add(recipe.id);
      sundayComponents.push({ id: recipe.id, name: recipe.name, text: bp.sundayComponent });
    }
    if (bp.weekdayAssembly) {
      weekdayAssembly.push({
        id: entry.id,
        date: entry.date,
        name: recipe.name,
        text: bp.weekdayAssembly,
      });
    }
  }
  weekdayAssembly.sort((a, b) => a.date.localeCompare(b.date));
  const hasBatchPrep = sundayComponents.length > 0 || weekdayAssembly.length > 0;
  // auto-open when the batching is TODAY: next week's on the closing Sunday,
  // or the shown future week's on its own prep Sunday
  const openBatch = batchForNext || today === prepSundayOf(plan.week);

  // weekly buffer snack: recipe, today's tally, and how much of the batch
  // the week has already eaten (sum of every day's counter)
  const bufferRecipe = plan.buffer ? byId.get(plan.buffer.recipeId) : null;
  const days = daily?.days ?? [];
  const bufferToday = days.find((d) => d.date === today)?.buffer ?? 0;
  const bufferWeek = weekDates.reduce(
    (s, d) => s + (days.find((x) => x.date === d)?.buffer ?? 0),
    0,
  );
  const bufferLeft = Math.max(0, (plan.buffer?.portions ?? 0) - bufferWeek);

  // perishables in their last 2 days (or hand-flagged useSoon): cook these
  // first — the pantry auto-expiry will bin them otherwise
  const useSoon = (pantry?.perishables ?? [])
    .map((/** @type {Record<string, any>} */ p) => ({ ...p, ...perishableStatus(p, today) }))
    .filter((/** @type {any} */ p) => p.useSoon || (p.daysLeft != null && p.daysLeft <= 2))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99));

  return html`
    <div class="view">
      <div class="hero weeknav">
        <button
          class="wk"
          aria-label="Previous day"
          onClick=${() => setDayIdx(Math.max(0, dayIdx - 1))}
          disabled=${dayIdx <= 0}
        >
          ‹
        </button>
        <div class="wkmid">
          <h1>Cook</h1>
          <div class="sub num">${dayLabel} · ${daySub}</div>
        </div>
        <button
          class="wk"
          aria-label="Next day"
          onClick=${() => setDayIdx(Math.min(weekDates.length - 1, dayIdx + 1))}
          disabled=${dayIdx >= weekDates.length - 1}
        >
          ›
        </button>
      </div>

      ${
        useSoon.length > 0 &&
        html`<div class="tile usesoontile">
          <div class="k">🕒 USE SOON · cook these first or lose them</div>
          <div class="d num">
            ${useSoon
              .map(
                (/** @type {any} */ p) =>
                  `${p.food}${p.daysLeft != null ? ` (${p.daysLeft <= 0 ? "today" : `${p.daysLeft}d`})` : ""}`,
              )
              .join(" · ")}
          </div>
        </div>`
      }

      <h2 class="block-title">${isToday ? "Today's meals" : `${dayLabel}'s meals`}</h2>
      ${
        !isToday &&
        html`<p class="hint">
          planning ahead — these are ${dayLabel}'s meals, tap one to open the recipe and pre-cook
          what you can.
          <button class="chip" onClick=${() => setDayIdx(todayIdx >= 0 ? todayIdx : 0)}>
            back to today
          </button>
        </p>`
      }
      ${
        loading
          ? html`<p class="hint">loading…</p>`
          : todayEntries.length === 0
            ? html`<p class="hint">
                ${
                  hasToken
                    ? html`nothing planned for ${isToday ? "today" : dayLabel} —${" "}
                        <a href="#/plan">open PLAN</a>`
                    : "no recipes yet — connect your token in SYS"
                }
              </p>`
            : html`<div class="todaylist">
                ${todayEntries.map((entry) => {
                  // viewRecipeId: a table entry's dish, linkable here without
                  // ever entering the shopping/dayTotals recipeId paths
                  const rid = entry.recipeId ?? entry.viewRecipeId;
                  const recipe = rid ? byId.get(rid) : null;
                  const label = SLOT_META[entry.slot]?.label ?? entry.slot;
                  if (!recipe) {
                    return html`
                      <div class="todayrow" key=${entry.id}>
                        <span class="t">${label}</span>
                        <span class="n">
                          ${entry.out ? "🍴 eating out · nothing to cook" : (entry.freeText ?? "…")}
                        </span>
                        ${
                          entry.table &&
                          html`<span class="m num"
                            >~${entry.estCalories} · ${entry.estProtein}P</span
                          >`
                        }
                      </div>
                    `;
                  }
                  return html`
                    <a
                      class="todayrow"
                      href="#/recipe/${encodeURIComponent(rid ?? "")}?from=today&servings=${entry.cookTotal ?? entry.servings ?? 1}"
                      key=${entry.id}
                    >
                      <span class="t">${label}</span>
                      <span class="n">
                        ${recipe.name}${entry.table && html` <span class="usesoon">table</span>`}
                        ${entry.cookTotal && html` <span class="usesoon">cook ×${entry.cookTotal} total</span>`}
                        ${
                          // my seat's AI plate-tailoring (set on the table
                          // from Plan or the dinner discussion)
                          /** @type {any} */ (entry).plate &&
                          html`<span class="hint plateline"
                            >✨ ${/** @type {any} */ (entry).plate.join(" · ")}</span
                          >`
                        }
                      </span>
                      <span class="m num"
                        >${recipe.nutrition?.calories} · ${recipe.nutrition?.protein}P ›</span
                      >
                    </a>
                  `;
                })}
              </div>`
      }
      ${
        todayEntries.some((e) => e.table) &&
        html`<p class="hint">
          ${
            tableStale
              ? "🍽 a table landed after this week was planned — RE-ROLL on Plan to adjust the day and rebuild the list."
              : `🍽 a shared table is fixed for ${isToday ? "today" : dayLabel} — the other meals were planned around it so your day still lands on target.`
          }
        </p>`
      }
      ${
        (tableConflicts ?? []).length > 0 &&
        html`<div class="tile" role="status">
          <div class="k">⚠ table conflicts</div>
          ${tableConflicts.map(
            (c) =>
              html`<div class="d num redflag" key=${c.table.id}>
                ${c.table.name}
                (${parseLocalIso(c.table.date).toLocaleDateString([], { weekday: "short" })}):
                ${c.reasons.join(", ")} — not added to your plan
              </div>`,
          )}
        </div>`
      }
      ${
        bufferRecipe &&
        html`<div class="tile buffer">
          <div class="k">🧺 WEEKLY BUFFER · still hungry? this, measured</div>
          <a
            class="todayrow"
            href="#/recipe/${encodeURIComponent(bufferRecipe.id)}?from=today&servings=1"
          >
            <span class="n">${bufferRecipe.name}</span>
            <span class="m num"
              >${bufferRecipe.nutrition?.calories} · ${bufferRecipe.nutrition?.protein}P / portion
              ›</span
            >
          </a>
          <div class="bufferrow">
            <span class="d num"
              >${bufferLeft} of ${plan.buffer?.portions ?? 0} portions left this week</span
            >
            ${
              isToday
                ? html`
                    <button
                      class="wk"
                      aria-label="Remove one buffer portion from today"
                      disabled=${bufferToday <= 0}
                      onClick=${() => onPatchDay({ buffer: Math.max(0, bufferToday - 1) })}
                    >
                      −
                    </button>
                    <span class="num bufcount" aria-label="Buffer portions eaten today"
                      >${bufferToday}</span
                    >
                    <button
                      class="wk"
                      aria-label="Log one buffer portion eaten today"
                      onClick=${() => onPatchDay({ buffer: bufferToday + 1 })}
                    >
                      +
                    </button>
                    <span class="d num">
                      today
                      ${bufferToday > 0 ? `· +${bufferToday * (bufferRecipe.nutrition?.calories ?? 0)} kcal` : ""}
                    </span>
                  `
                : html`<span class="d">log portions on the day itself</span>`
            }
          </div>
        </div>`
      }
      ${
        !pastWeek &&
        (hasBatchPrep || batchForNext) &&
        html`<details class="batchprep" open=${openBatch}>
          <summary class="block-title">
            Batch prep${" "}
            <span class="hint">
              ${
                batchForNext
                  ? `for next week · ${sundayComponents.length} to prep`
                  : catchUp
                    ? `Sunday passed · ${sundayComponents.length} to catch up, tap to open`
                    : `${sundayComponents.length} to prep, tap to open`
              }
            </span>
          </summary>
          ${
            // three distinct Sunday states: still fetching next week's plan,
            // genuinely no plan yet, and a plan whose recipes need no batching
            batchForNext &&
            !hasBatchPrep &&
            html`<div class="batch">
              ${
                nextPlan == null
                  ? "loading next week…"
                  : nextPlan.entries.length === 0
                    ? "No plan for next week yet. Generate it on the Plan tab, then batch from here."
                    : "Nothing in next week's plan needs batching."
              }
            </div>`
          }
          ${sundayComponents.map(
            (r) =>
              html`<div class="batch" key=${r.id}>
                <div class="k">${catchUp ? "Catch-up" : "Sunday"} · ${r.name}</div>
                ${r.text}
              </div>`,
          )}
          ${weekdayAssembly.map(
            (w) =>
              html`<div class="batch" key=${w.id}>
                <div class="k">
                  ${parseLocalIso(w.date).toLocaleDateString([], { weekday: "short" })} · ${w.name}
                </div>
                ${w.text}
              </div>`,
          )}
        </details>`
      }

      <div class="actions wrap">
        <a class="secondary linkbtn" href="#/dinner">💬 what should dinner be? →</a>
        <a class="secondary linkbtn" href="#/menu">🍴 eating out? scan the menu →</a>
        <a class="secondary linkbtn" href="#/cookbook">browse all recipes →</a>
      </div>
    </div>
  `;
}
