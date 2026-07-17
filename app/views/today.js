import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { localIsoDate, parseLocalIso } from "../lib/dates.js";
import { datesOfWeek, recipesById, SLOT_KEYS, SLOT_META } from "../lib/plan.js";

/**
 * Cook view: a day's planned meals in full (moved out of Home), each
 * tapping through to its recipe, plus a link out to the full recipe
 * library. Defaults to today, and the ‹ › arrows page through the week's
 * other days so meals can be pre-cooked ahead ("flip to Monday, prep its
 * breakfast and lunch, flip to Tuesday, ...").
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
  const isSunday = parseLocalIso(today).getDay() === 0;

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
                    <a
                      class="todayrow"
                      href="#/recipe/${encodeURIComponent(entry.recipeId)}?from=today"
                      key=${entry.id}
                    >
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
          <summary class="block-title">
            Batch prep <span class="hint">${sundayComponents.length} to prep, tap to open</span>
          </summary>
          ${sundayComponents.map(
            (r) =>
              html`<div class="batch" key=${r.id}>
                <div class="k">Sunday · ${r.name}</div>
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

      <div class="actions">
        <a class="secondary linkbtn" href="#/cookbook">browse all recipes →</a>
      </div>
    </div>
  `;
}
