import { html } from "htm/preact";
import { localIsoDate, parseLocalIso } from "../lib/dates.js";
import { datesOfWeek, prepSundayOf, recipesById } from "../lib/plan.js";
import { isDatedItem, pantryItems, perishableStatus } from "../lib/shopping.js";
import { isParked } from "../lib/parked.js";
import { splitSteps } from "../lib/cadence.js";

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** ["Sun", "Mon"] -> "Sun and Mon" */
const andList = (/** @type {string[]} */ names) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");

/**
 * WHAT A SUNDAY POT FEEDS, on BATCH PREP (shrike item 13, 10/25): "For Sun and
 * Mon dinners, 2 people"; meal B adds when its meat is cooked. "" for a
 * component that is not a shared pot.
 * @param {Record<string, any>} entry
 * @param {Record<string, any>[]} entries the week's plan entries
 * @param {{ id: string, seats?: { status?: string }[], guests?: number }[]} tables
 * @returns {string}
 */
export function potFeeds(entry, entries, tables) {
  // dinner pots only: a breakfast or snack batch is not "Sun dinner"
  if (!entry?.table || entry.leftoverOf || entry.slot !== "dinner") return "";
  const dayOf = (/** @type {string} */ iso) => DAY_SHORT[parseLocalIso(iso).getDay()] ?? "";
  const nights = (
    Array.isArray(entry.freshNights)
      ? entry.freshNights
      : [entry.date, ...entries.filter((e) => e.leftoverOf === entry.table).map((e) => e.date)]
  )
    .slice()
    .sort();
  const t = tables.find((x) => x.id === entry.table);
  const people =
    (t?.seats ?? []).filter((s) => s.status !== "skipped").length + (Number(t?.guests) || 0);
  const meat =
    entry.proteinFresh === "once"
      ? `, meat cooked ${dayOf(String(nights[0]))}`
      : entry.proteinFresh === "daily"
        ? ", meat cooked each night"
        : "";
  return `For ${andList(nights.map(dayOf))} dinner${nights.length > 1 ? "s" : ""}${
    people > 0 ? `, ${people} ${people === 1 ? "person" : "people"}` : ""
  }${meat}.`;
}

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
 *   daily: { days?: Record<string, any>[] },
 *   pantry: Record<string, any>,
 *   onPatchDay: (patch: Record<string, any>) => void,
 *   tables?: { id: string, seats?: { status?: string }[], guests?: number }[]
 * }} props `tables` = the kitchen's tables, so each pot names how many it feeds
 */
export function CookBlocks({ recipes, plan, tableConflicts, daily, pantry, onPatchDay, tables = [] }) {
  const byId = recipesById(recipes);
  const today = localIsoDate(new Date());
  const weekDates = datesOfWeek(plan.week);

  // batch-prep block, day-aware (docs/day-aware-weeks-design.md). Since the
  // week opens on SUNDAY (David 2026-09-05) the batch day is the shown week's
  // own first day, so the block always describes the week you are looking
  // at: "Sunday batch" while that Sunday is today or ahead, "catch-up" once
  // it has passed with the week still underway. A fully past week shows
  // nothing. (The old "closing Sunday preps NEXT week" special case died
  // with Monday-start weeks: on Sunday the app already shows the new week.)
  // sundayComponent is deduped by recipe (cook it once, regardless of how
  // many days it's stacked on); weekdayAssembly is kept per planned day
  // since the reheat note is about that day, not the dish.
  const pastWeek = today > (weekDates[6] ?? "");
  const catchUp = !pastWeek && today > (weekDates[0] ?? "");
  const batchEntries = plan.entries;
  const seenSunday = new Set();
  const sundayComponents = [];
  for (const entry of batchEntries) {
    // a shared (brigade) meal carries its dish as viewRecipeId, never
    // recipeId; reading only recipeId left the Sunday batch block blind to
    // the whole shared week (engine audit, 2026-10-16)
    const rid = entry.recipeId ?? /** @type {any} */ (entry).viewRecipeId;
    if (!rid) continue;
    // mid-week, an already-eaten day contributes nothing: no assembly note,
    // and no catch-up component for a dish with no remaining day to eat it
    // (a recipe also planned on a live day is still caught by that entry)
    if (catchUp && entry.date < today) continue;
    // a shared meal is Sunday prep only when it is made on the week's own
    // Sunday: Sunday's own meals and the pot prepared then for later nights.
    // Friday's pot is cooked Friday, and leftovers are never cooked again.
    if (
      /** @type {any} */ (entry).table &&
      (/** @type {any} */ (entry).leftoverOf ||
        (entry.date !== weekDates[0] && /** @type {any} */ (entry).preparedOn !== weekDates[0]))
    )
      continue;
    const recipe = byId.get(rid);
    const feeds = potFeeds(/** @type {any} */ (entry), batchEntries, tables);
    // MEAL B (2026-10-25): Sunday does every step that leaves the meat alone,
    // read from the recipe itself; the meat waits for its night
    const fresh = /** @type {any} */ (entry).proteinFresh;
    if ((fresh === "once" || fresh === "daily") && recipe && !seenSunday.has(recipe.id)) {
      seenSunday.add(recipe.id);
      const steps = splitSteps(recipe).sunday;
      sundayComponents.push({
        id: recipe.id,
        name: recipe.name,
        text: "All but the meat:",
        steps,
        feeds,
      });
      continue;
    }
    const bp = recipe?.batchPrep;
    if (!bp) continue;
    if (bp.sundayComponent && !seenSunday.has(recipe.id)) {
      seenSunday.add(recipe.id);
      sundayComponents.push({ id: recipe.id, name: recipe.name, text: bp.sundayComponent, feeds });
    }
  }
  const hasBatchPrep = sundayComponents.length > 0;
  // auto-open when the batching is TODAY: the shown week's own Sunday
  const openBatch = today === prepSundayOf(plan.week);

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
  const useSoon = pantryItems(pantry)
    .filter(isDatedItem)
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
              ${c.reasons.join(", ")}, not added to your plan
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
      hasBatchPrep &&
      html`<details class="batchprep" open=${openBatch}>
        <summary class="block-title">
          Batch prep${" "}
          <span class="hint">
            ${
              catchUp
                ? `Sunday passed · ${sundayComponents.length} to catch up, tap to open`
                : `${sundayComponents.length} to prep, tap to open`
            }
          </span>
        </summary>
        ${sundayComponents.map(
          (r) =>
            html`<div class="batch" key=${r.id}>
              <div class="k">
                ${catchUp ? "Catch-up" : "Sunday"} · ${r.name}
                ${todayBatched.includes(r.id) && html`<span class="usesoon cookedchip">✓ done</span>`}
              </div>
              ${r.feeds && html`<div class="hint potfeeds">${r.feeds}</div>`}
              ${r.text}
              ${
                (r.steps ?? []).length > 0 &&
                html`<ol class="hint">
                  ${(r.steps ?? []).map((st, i) => html`<li key=${i}>${st}</li>`)}
                </ol>`
              }
              <div class="actions">
                <button class="secondary" onClick=${() => toggleBatched(r.id)}>
                  ${todayBatched.includes(r.id) ? "UNDO" : "✓ DONE"}
                </button>
              </div>
            </div>`,
        )}
      </details>`
    }

    ${
      (!isParked("dinnerchat") || !isParked("menu") || !isParked("cookbook")) &&
      html`<div class="actions wrap">
        ${
          !isParked("dinnerchat") &&
          html`<a class="secondary linkbtn" href="#/dinner">💬 what should dinner be? →</a>`
        }
        ${
          !isParked("menu") &&
          html`<a class="secondary linkbtn" href="#/menu">🍴 eating out? scan the menu →</a>`
        }
        ${
          !isParked("cookbook") &&
          html`<a class="secondary linkbtn" href="#/cookbook">browse all recipes →</a>`
        }
      </div>`
    }
  `;
}
