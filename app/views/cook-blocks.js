import { html } from "htm/preact";
import { localIsoDate, parseLocalIso } from "../lib/dates.js";
import { datesOfWeek, prepSundayOf, recipesById } from "../lib/plan.js";
import { perishableStatus } from "../lib/shopping.js";

/**
 * The WEEK-level half of what used to be the Cook tab.
 *
 * David, 2026-07-25: Home only ever linked to Cook, and Cook and Plan showed
 * the same week twice. Plan absorbed Cook, so the per-day meal list now lives
 * in Plan's expanded day rows, where it was always a duplicate. What is left
 * here is everything about the WEEK rather than one day, rendered below
 * Plan's seven rows: what is about to spoil, the weekly buffer snack, the
 * batch-prep block, and the links out to the cooking tools.
 *
 * Kept as its own module rather than inlined so Plan stays readable. The
 * logic is unchanged from the Cook tab that shipped it.
 * @param {{
 *   recipes: Record<string, any>[],
 *   plan: import("../lib/plan.js").Plan,
 *   tableConflicts: { table: import("../lib/tables.js").TableEvent, reasons: string[] }[],
 *   nextPlan: import("../lib/plan.js").Plan | null,
 *   daily: { days?: Record<string, any>[] },
 *   pantry: Record<string, any>,
 *   onPatchDay: (patch: Record<string, any>) => void
 * }} props
 */
export function CookBlocks({ recipes, plan, tableConflicts, nextPlan, daily, pantry, onPatchDay }) {
  const byId = recipesById(recipes);
  const today = localIsoDate(new Date());
  const weekDates = datesOfWeek(plan.week);

  // batch-prep block, day-aware (docs/day-aware-weeks-design.md). The block
  // always describes the week you can still batch FOR: the shown week while
  // its prep Sunday is ahead ("Sunday batch") or while it's underway
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
  // batch components ticked done TODAY (honest-state: batching is confirmed
  // by the DONE tap, stored on today's daily-log day)
  const todayBatched = /** @type {string[]} */ (days.find((d) => d.date === today)?.batched ?? []);
  const toggleBatched = (/** @type {string} */ id) =>
    onPatchDay({
      batched: todayBatched.includes(id)
        ? todayBatched.filter((b) => b !== id)
        : [...todayBatched, id],
    });
  const bufferToday = days.find((d) => d.date === today)?.buffer ?? 0;
  const bufferWeek = weekDates.reduce(
    (s, d) => s + (days.find((x) => x.date === d)?.buffer ?? 0),
    0,
  );
  const bufferLeft = Math.max(0, (plan.buffer?.portions ?? 0) - bufferWeek);
  // the +/- counter logs against TODAY, so it only appears while the week
  // being shown is the one you are actually living
  const showingThisWeek = weekDates.includes(today);

  // perishables in their last 2 days (or hand-flagged useSoon): cook these
  // first — the pantry auto-expiry will bin them otherwise
  const useSoon = (pantry?.perishables ?? [])
    .map((/** @type {Record<string, any>} */ p) => ({ ...p, ...perishableStatus(p, today) }))
    .filter((/** @type {any} */ p) => p.useSoon || (p.daysLeft != null && p.daysLeft <= 2))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99));

  return html`
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
          href="#/recipe/${encodeURIComponent(bufferRecipe.id)}?from=plan&servings=1"
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
            showingThisWeek
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
                  ? "No plan for next week yet. Generate it above, then batch from here."
                  : "Nothing in next week's plan needs batching."
            }
          </div>`
        }
        ${sundayComponents.map(
          (r) =>
            html`<div class="batch" key=${r.id}>
              <div class="k">
                ${catchUp ? "Catch-up" : "Sunday"} · ${r.name}
                ${todayBatched.includes(r.id) && html`<span class="usesoon cookedchip">✓ done</span>`}
              </div>
              ${r.text}
              <div class="actions">
                <button class="secondary" onClick=${() => toggleBatched(r.id)}>
                  ${todayBatched.includes(r.id) ? "UNDO" : "✓ DONE"}
                </button>
              </div>
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
  `;
}
