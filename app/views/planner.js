import { html } from "htm/preact";
import { useRef, useState } from "preact/hooks";
import { targetsSanity } from "../lib/targets.js";
import {
  currencyUsed,
  datesOfWeek,
  dayTotals,
  entriesAt,
  outEntryAt,
  recipesById,
  SLOT_KEYS,
  SLOT_META,
} from "../lib/plan.js";
import { parseLocalIso } from "../lib/dates.js";
import { manifestDrifted, manifestLines } from "../lib/manifest.js";
import { CookBlocks } from "./cook-blocks.js";

const SLOTS = SLOT_KEYS.map((key) => ({ key, ...(SLOT_META[key] ?? { label: key, full: key }) }));

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
 * The weekly plan (blueprint §6.3), rebuilt 2026-07-27 around what David
 * actually does with it.
 *
 * Everything that made this a DRAG-AND-DROP planner is gone: the recipe tray,
 * its meal filter chips, the drag grips, and moving a meal between slots. His
 * reasoning, and it is right: he never moved anything, a breakfast is only
 * ever a breakfast so a move is really a cross-DAY move, and that is a rare
 * enough want to cost the whole layout. The grid had to keep six droppable
 * targets legible, which is why a recipe name rendered as "matcha gree…".
 *
 * What replaced them:
 *   TAP A MEAL  opens the recipe as a card over the plan (ingredients + cook),
 *               no longer gated on a scanned receipt.
 *   SWITCH      replaces the meal with another eligible recipe for that slot,
 *               instead of the old ✕ which could only delete. Tapping again
 *               keeps cycling.
 *   OUT         unchanged.
 * PIN is gone from the UI (he did not know what it did). The DATA still
 * honours `pinned`, so a pinned entry from an older device is still kept by
 * GENERATE WEEK; nothing in the app sets one any more.
 * @param {{
 *   recipes: Record<string, any>[],
 *   identityRecipes?: Record<string, any>[],
 *   plan: import("../lib/plan.js").Plan,
 *   targets: Record<string, any> | null,
 *   poolReport: { counts: Record<string, number>, warnings: string[] } | null,
 *   weekId: string,
 *   todayIso: string,
 *   onWeek: (delta: number) => void,
 *   onSwitch: (id: string) => void,
 *   onOpen: (entry: Record<string, any>) => void,
 *   onToggleOut: (date: string, slot: string) => void,
 *   onGenerateWeek: () => void,
 *   buildReport: import("../lib/weekbuilder.js").WeekReport | null,
 *   rebuilt: boolean,
 *   tableStale: boolean,
 *   tableIssues: number,
 *   tableConflicts: { table: import("../lib/tables.js").TableEvent, reasons: string[] }[],
 *   nextPlan: import("../lib/plan.js").Plan | null,
 *   daily: { days?: Record<string, any>[] },
 *   pantry: Record<string, any>,
 *   onPatchDay: (patch: Record<string, any>) => void,
 *   occasionBanner?: {
 *     emoji: string, name: string, when: string, label: string, note: string
 *   } | null,
 *   coverageGaps?: import("../lib/coverage.js").CoverageGap[],
 *   onRestoreFallback?: (() => void) | undefined,
 *   lastWeekReview?: ReturnType<typeof import("../lib/review.js").composeWeekReview> | null
 * }} props
 */
export function PlannerView({
  recipes,
  identityRecipes = undefined,
  plan,
  targets,
  poolReport,
  weekId,
  todayIso,
  onWeek,
  onSwitch,
  onOpen,
  onToggleOut,
  onGenerateWeek,
  buildReport,
  rebuilt,
  tableStale,
  tableIssues,
  tableConflicts,
  nextPlan,
  daily,
  pantry,
  onPatchDay,
  occasionBanner = null,
  coverageGaps = [],
  onRestoreFallback = undefined,
  lastWeekReview = null,
}) {
  const rootRef = useRef(/** @type {HTMLElement | null} */ (null));
  // scoreboard accordion (David's layout pick, 2026-07-23): which days are
  // expanded. Absent = default (today open, everything else collapsed);
  // native <details> does the rest, this map only remembers user toggles
  const [openDays, setOpenDays] = useState(/** @type {Record<string, boolean>} */ ({}));
  const todayRef = useRef(todayIso);
  todayRef.current = todayIso;

  // identity pool when provided: an existing entry must resolve (and count
  // its macros) even when a screen has since removed its recipe from the
  // pickable pool; `recipes` stays the pool SWITCH and the tray pick from
  const byId = recipesById(identityRecipes ?? recipes);
  const dates = datesOfWeek(weekId);
  // P3, no invented person. These two lines used to read `?? 3400` and
  // `?? 210`, which are DAVID'S targets from an earlier phase: any profile
  // whose targets file could not be read was silently measured against his
  // numbers, and every meter on this screen reported a stranger's progress
  // toward a stranger's goal. The fallbacks were dormant on the one device
  // anybody ever tests on, which is exactly why they survived every audit.
  // Absent now means absent: the numbers render with no denominator and the
  // screen says so.
  const kcalTarget = Number(targets?.macros?.calories) || null;
  const proteinTarget = Number(targets?.macros?.protein) || null;
  const noTargets = kcalTarget == null || proteinTarget == null;
  // 7.11: expiring balances (dining swipes etc.) — the planner shows
  // used-of-perWeek so a use-or-lose currency is never silently wasted
  const currencies = /** @type {any[]} */ (targets?.currencies ?? []);
  const hasBuffet = currencies.some((c) => c.venue === "buffet");
  // 7.12: the soft targets gate — loud advisory only when the stated target
  // sits outside the physiological band AND no reason is written down
  const sanity = targetsSanity(targets);
  // a past day is read-only: never a drop target, never re-rolled
  // (generateWeek leaves it alone). Only the current week has any.
  const isPast = (/** @type {string} */ d) => Boolean(todayRef.current) && d < todayRef.current;
  const firstLive = dates.find((d) => !isPast(d));
  const midWeek = firstLive != null && dates.some((d) => isPast(d));
  // the one day expanded by default: today when this week is shown, else the
  // week's first live day (a fully past week opens nothing)
  const defaultOpenDate = dates.includes(todayRef.current ?? "") ? todayRef.current : firstLive;

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

      ${
        // an OCCASION is the loudest thing on this screen while it runs. It is
        // reached from Settings and otherwise invisible, so the day it matters
        // it has to come and find you (David: "hidden-ish, not awful to find").
        occasionBanner &&
        html`<div class="occbanner" role="status">
          <b>${occasionBanner.emoji} ${occasionBanner.name}${occasionBanner.when}</b>
          ${occasionBanner.label}${occasionBanner.note ? html` ${occasionBanner.note}` : ""}
          ${" "}<a href="#/occasions">open</a>
        </div>`
      }
      ${
        // THE FLUID WEEK (canon P4, 7.2): shopping locks the INGREDIENTS,
        // never the plan. The old lock banner died with the lock; in its
        // place, the one governing rule watches every plan edit — bought
        // perishables must still have a meal before they die.
        coverageGaps.length > 0 &&
        html`<div class="tile lockbanner" role="status">
          <div class="k">⚠ bought food with no meal before it dies</div>
          <div class="d">
            ${coverageGaps.map((/** @type {any} */ g, /** @type {number} */ i) => html`<span key=${g.id}>${i > 0 ? " · " : ""}<b>${g.food}</b> <span class="num">(${g.daysLeft}d)</span></span>`)}
            ${" "}— add a meal that uses it, move one earlier, or freeze it.
            ${onRestoreFallback && html`<button class="linktext" onClick=${onRestoreFallback}>↩ back to the shopped plan</button>`}
          </div>
        </div>`
      }

      ${
        noTargets &&
        html`<div class="tile lockbanner" role="status">
          <div class="k">⚠ this profile has no calorie or protein target</div>
          <div class="d">
            Mise will not aim a week at a person it cannot read, so GENERATE is off until a target
            exists. The day numbers below are what the plan delivers, measured against nothing. Run
            the target setup, or set <span class="num">macros.calories</span> and
            <span class="num">macros.protein</span> on this profile.
          </div>
        </div>`
      }
      ${
        sanity.verdict === "outside" &&
        html`<div class="tile lockbanner" role="status">
          <div class="k">⚠ target outside the computed band</div>
          <div class="d">
            Your ${kcalTarget} kcal target sits outside ${sanity.low}–${sanity.high} (computed
            maintenance ≈ ${sanity.maintenance}). That can be deliberate — a fast, a weight-cut, a
            training block — but it needs a written reason: add
            <span class="num">targetReason</span> to your targets, or re-run the target setup.
            Nothing is blocked; the week still generates to your number.
          </div>
        </div>`
      }
      ${
        currencies.length > 0 &&
        html`<p class="hint" role="status">
          ${currencies.map((/** @type {any} */ c, /** @type {number} */ i) => {
            const used = currencyUsed(plan, c.id);
            return html`<span key=${c.id}>${i > 0 ? " · " : ""}🎫 ${c.name}: <span class="num">${used} of ${c.perWeek ?? "?"}</span> planned this week${c.expires === "weekly" && (c.perWeek ?? 0) > used ? html` <span class="hint">(unused ones expire — the 🍴 button on any slot cycles to SWIPE${c.venue === "buffet" ? ", where the buffet eats the protein bill" : ""})</span>` : ""}</span>`;
          })}
        </p>`
      }
      ${
        hasBuffet &&
        html`<div class="actions">
          <a class="linktext" href="#/hall">🍽 BUILD A DINING-HALL TRAY →</a>
        </div>
        <p class="hint">
          Pick a court and a meal and Mise composes a tray from what Purdue is actually serving
          today, aimed at what is left of your day, screened against your allergens.
        </p>`
      }

      <div class="actions">
        <button
          class="ask"
          aria-label=${
            rebuilt ? "Pick different meals for the generated week" : "Generate my week automatically"
          }
          onClick=${onGenerateWeek}
          disabled=${recipes.length === 0 || firstLive == null || noTargets}
        >
          ${rebuilt ? "PICK DIFFERENT MEALS" : "✦ GENERATE MY WEEK"}
          <small>
            ${
              firstLive == null
                ? "this week is over, nothing left to plan"
                : midWeek
                  ? firstLive === dates[6]
                    ? "plans today only · earlier days already eaten"
                    : `plans ${parseLocalIso(firstLive).toLocaleDateString([], { weekday: "short" })}–Sun · earlier days already eaten`
                  : "overlapping ingredients → fewer, bulkier buys"
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
            ${
              // P5, the money axis: protein above the ceiling is budget spent
              // for nothing, and a day the trim could not fit without breaking
              // a floor says so rather than passing quietly.
              (buildReport.proteinOverDays ?? []).length > 0 &&
              html`<div class="d num">
                day over protein ceiling:${" "}
                ${buildReport.proteinOverDays
                  .map((s) => {
                    const day = parseLocalIso(s.date).toLocaleDateString([], { weekday: "short" });
                    // BOUGHT vs EATEN, said out loud (2026-08-23). This line
                    // printed one number and meant two: a dining swipe's
                    // grams are eaten but not bought, and the ceiling is a
                    // MONEY number, so showing the eaten total here read as a
                    // failure on weeks whose grocery bill had actually gone
                    // down. Show both whenever they differ.
                    return s.eaten != null && Math.round(s.eaten) !== Math.round(s.protein)
                      ? `${day} ${Math.round(s.protein)} bought of ${Math.round(s.eaten)} eaten`
                      : `${day} ${Math.round(s.protein)}`;
                  })
                  .join(" · ")}
                / ${buildReport.proteinOverDays[0]?.ceiling} g bought-ceiling · every gram over is bought
              </div>`
            }
          </div>
        `
      }
      ${
        // THE GENERATION MANIFEST (fix list 2.5, council 2026-08-18): what
        // every subsystem did on this week, persisted on the plan so any
        // device sees it. A registered subsystem with no line renders as the
        // failure it is — that is the whole point.
        /** @type {any} */ (plan).manifest &&
        html`
          <details class="tile manifesttile">
            <summary class="block-title">
              ⚙ Generation manifest
              <span class="hint"
                >what every engine did, ${/** @type {any} */ (plan).manifest.generatedAt}</span
              >
            </summary>
            ${
              // drift: never let the report silently describe a plan that no
              // longer exists (PF.1; the fluid week makes edits normal)
              manifestDrifted(/** @type {any} */ (plan).manifest, plan) === true &&
              html`<div class="d num redflag">
                <strong>drift</strong>: plan has CHANGED since this report was composed — its
                numbers describe the plan as generated, not as it stands
              </div>`
            }
            ${manifestLines(/** @type {any} */ (plan).manifest, plan, todayIso).map(
              (l) => html`
                <div class="d num ${l.missing ? "redflag" : ""}" key=${l.key}>
                  <strong>${l.key}</strong>: ${l.text}
                </div>
              `,
            )}
          </details>
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
      ${
        tableStale &&
        html`<p class="hint">
          ⚠ a family dinner landed after this week was generated — PICK DIFFERENT MEALS to plan
          around it and rebuild the list.
        </p>`
      }
      ${
        tableIssues > 0 &&
        html`<p class="hint">
          🍽 ${tableIssues} table ${tableIssues === 1 ? "issue" : "issues"} (diet conflict or a taken
          slot) — details on the Table tab.
        </p>`
      }
      ${dates.map((date) => {
        const past = isPast(date);
        const totals = dayTotals(/** @type {any} */ (plan.entries), byId, date);
        const kcalPct = kcalTarget ? Math.min(100, Math.round((totals.calories / kcalTarget) * 100)) : 0;
        const pPct = proteinTarget ? Math.min(100, Math.round((totals.protein / proteinTarget) * 100)) : 0;
        // out slots carry an assumed macro credit (dayTotals counts it), so
        // the meters and warn styling stay honest without special-casing
        const dayTable = plan.entries.find((e) => e.date === date && e.table);
        // no target means no verdict: an absent number can never make a day
        // read as a miss, which would be the invented person wearing a warning
        const kcalOk = kcalTarget ? totals.calories / kcalTarget >= 0.9 : true;
        const pOk = proteinTarget ? totals.protein / proteinTarget >= 0.9 : true;
        // the dinner whisper is GONE (David 2026-08-19: "why dinner over any
        // other meal? We don't need it" — his ruling supersedes the
        // Historian's 2026-07 condition). The collapsed row keeps only the
        // honest-state badges below.
        const isOpen = openDays[date] ?? date === defaultOpenDate;
        const dayName = parseLocalIso(date).toLocaleDateString([], { weekday: "short" });
        // honest-state (David, 2026-07-23): a past DATE never implies eaten.
        // "✓ eaten" only when every cookable meal that day carries a cooked
        // confirmation from the DONE button; "not logged" only when there WAS
        // something to confirm (an out/table-only day has nothing to log and
        // gets no badge either way); otherwise the past day just dims.
        const cookable = plan.entries.filter(
          (e) => e.date === date && e.recipeId && !e.out && !e.table,
        );
        const dayEaten = cookable.length > 0 && cookable.every((e) => e.cookedAt);
        const dayUnlogged = cookable.length > 0 && !dayEaten;
        return html`
          <details
            class="day dayrow ${past ? "past" : ""}"
            key=${date}
            open=${isOpen}
            onToggle=${(/** @type {any} */ e) =>
              setOpenDays({ ...openDays, [date]: e.currentTarget.open })}
          >
            <summary
              aria-label="${dayName} ${monthDay(date)}: ${totals.calories}${kcalTarget ? ` of ${kcalTarget}` : ""} calories, ${totals.protein}${proteinTarget ? ` of ${proteinTarget}` : ""} grams protein${dayEaten ? ", eaten" : dayUnlogged && past ? ", past, cooking not logged" : past ? ", past" : ""}"
            >
              <span class="dsum-day">
                ${dayName}
                <small class="num">${monthDay(date)}</small>
              </span>
              <span class="dsum-meters">
                <span class="mline ${kcalOk ? "" : "warn"}">
                  <b class="num">${totals.calories}${kcalTarget ? ` / ${kcalTarget}` : ""}</b>
                  <span class="meter" aria-hidden="true">
                    <i style=${`width:${kcalPct}%`}></i>
                  </span>
                </span>
                <span class="mline ${pOk ? "" : "warn"}">
                  <b class="num">${totals.protein}${proteinTarget ? ` / ${proteinTarget}` : ""}P</b>
                  <span class="meter" aria-hidden="true">
                    <i style=${`width:${pPct}%`}></i>
                  </span>
                </span>
                ${
                  past &&
                  (dayEaten || dayUnlogged) &&
                  html`<span class="dsum-whisper">
                    <span class="eaten">${dayEaten ? "✓ eaten" : "not logged"}</span>
                  </span>`
                }
              </span>
              <span class="dsum-status ${past ? "" : kcalOk && pOk ? "ok" : "shortfall"}">
                ${past ? "" : kcalOk && pOk ? "✓" : "short"}
              </span>
            </summary>
            <div class="daymeals">
              ${
                dayTable &&
                html`<p class="hint">
                  ${
                    // cookTotal only exists on the cook's own device — the one
                    // honest "it's your night" signal available in this view
                    /** @type {any} */ (dayTable).cookTotal
                      ? html`🍽 family dinner — <strong>👨‍🍳 your night to cook</strong> (cooking for
                          everyone seated)`
                      : html`🍽 family dinner — you're seated, nothing to
                        shop${
                          /** @type {any} */ (dayTable).cookName
                            ? html` ·
                                <strong>👨‍🍳 ${/** @type {any} */ (dayTable).cookName} cooks</strong>`
                            : ""
                        }`
                  }
                  ${" "}· <a href="#/tables">Table tab</a>
                </p>`
              }
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
                                  <div class="fill">
                                    <span class="chipbody">
                                      <span class="n"
                                        >${recipe ? recipe.name : entry.freeText}</span
                                      >
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
                  // ONE renderer for live and locked weeks. They used to be
                  // two near-identical blocks that differed only in which
                  // controls rendered; with dragging gone and tapping always
                  // opening the recipe, the only real difference left is that
                  // a bought week cannot be switched or marked out.
                  return html`
                    <div class="slotrow ${outEntry ? "isout" : ""}" key=${key}>
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
                            // a table entry's dish is openable through
                            // viewRecipeId without entering the shopping or
                            // dayTotals recipeId paths
                            const rid = entry.recipeId ?? entry.viewRecipeId;
                            const recipe = rid ? byId.get(rid) : null;
                            const name = recipe ? recipe.name : entry.freeText;
                            return html`
                              <div class="stackline" key=${entry.id}>
                                <button
                                  class="fill mealbtn"
                                  disabled=${!recipe}
                                  aria-label=${
                                    recipe ? `Open ${name}` : /** @type {string} */ (name)
                                  }
                                  onClick=${() => recipe && onOpen(entry)}
                                >
                                  <span class="chipbody">
                                    <span class="n">
                                      ${name}${entry.table && html` <span class="usesoon">table</span>`}
                                      ${entry.cookTotal && html` <span class="usesoon">you cook</span>`}
                                      ${entry.cookedAt && html` <span class="usesoon cookedchip">✓ cooked</span>`}
                                      ${
                                        /** @type {any} */ (entry).plate &&
                                        html`<span class="hint plateline"
                                          >✨ ${/** @type {any} */ (entry).plate.join(" · ")}</span
                                        >`
                                      }
                                    </span>
                                    ${
                                      recipe &&
                                      html`<span class="m num"
                                        >${recipe.nutrition?.calories} ·
                                        ${recipe.nutrition?.protein}P</span
                                      >`
                                    }
                                    ${
                                      !recipe &&
                                      entry.table &&
                                      html`<span class="m num"
                                        >~${entry.estCalories} · ${entry.estProtein}P · table</span
                                      >`
                                    }
                                  </span>
                                </button>
                                ${
                                  // SWITCH replaces the meal with another
                                  // eligible recipe for this slot instead of
                                  // only deleting it (David: "instead of being
                                  // able to only get rid of I want an automatic
                                  // replacement"). Tapping again keeps cycling.
                                  // A table entry is not ours to rewrite: it
                                  // lives in the house's events.json.
                                  // the fluid week (7.2): SWITCH works after
                                  // shopping too — the coverage banner is the
                                  // guard now, not a lock
                                  !entry.table &&
                                  entry.recipeId &&
                                  html`<button
                                    class="switchbtn"
                                    aria-label="Switch ${name} for another ${full.toLowerCase()}"
                                    onClick=${() => onSwitch(entry.id)}
                                  >
                                    ⇄
                                  </button>`
                                }
                              </div>
                            `;
                          })}
                        </div>`
                      }
                      ${
                        // 7.11: with a buffet currency the tap cycles
                        // planned → OUT → SWIPE → empty; the swipe state
                        // carries buffet estimates (protein piled where its
                        // marginal cost is zero)
                        html`<button
                          class="outbtn ${outEntry ? "on" : ""}"
                          aria-pressed=${Boolean(outEntry)}
                          aria-label=${
                            outEntry
                              ? /** @type {any} */ (outEntry).currency
                                ? `${full} ${monthDay(date)} is a dining swipe (buffet — load up on protein), tap to clear`
                                : hasBuffet
                                  ? `${full} ${monthDay(date)} is eating out, tap to make it a dining swipe`
                                  : `${full} ${monthDay(date)} is eating out, tap to plan a meal again`
                              : `Mark ${full} ${monthDay(date)} as eating out: clears the slot, nothing shopped or re-rolled`
                          }
                          onClick=${() => onToggleOut(date, key)}
                        >
                          ${/** @type {any} */ (outEntry)?.currency ? "🎫 SWIPE" : "🍴 EATING OUT"}
                        </button>`
                      }
                      ${
                        // A SWIPE IS NOW SOMETHING YOU CAN OPEN. Until today
                        // the placeholder said "dining swipe" and that was the
                        // end of it: the tray composer existed and there was no
                        // way to reach it from the meal it was for. The date
                        // and the meal are already known, so the hall screen is
                        // handed both rather than asking again.
                        /** @type {any} */ (outEntry)?.currency &&
                        html`<a
                          class="linktext"
                          href=${`#/hall?date=${date}&meal=${key}`}
                          aria-label=${`Pick what to eat at the dining hall for ${full} ${monthDay(date)}`}
                          >🍽 PICK MY TRAY →</a
                        >`
                      }
                    </div>
                  `;
                })}
              </div>
            </div>
          </details>
        `;
      })}

      ${
        // THE WEEK ENDS IN A REVIEW (P11, read side of 7.1): plan against
        // reality on every axis that has data, each axis honest about being
        // dark. The write side (fridge photo, free-text, generation reading
        // the output) is the remaining 7.1 build.
        lastWeekReview?.hasData &&
        html`<div class="tile buildreport" role="note">
          <div class="k">Last week, reviewed</div>
          <div class="d num">
            cooked ${lastWeekReview.cooked.done} of ${lastWeekReview.cooked.planned} planned
            ${lastWeekReview.spend ? html` · spent $${lastWeekReview.spend.total.toFixed(2)}${lastWeekReview.spend.budget ? ` of $${lastWeekReview.spend.budget}` : ""} (${lastWeekReview.spend.receipts} receipt${lastWeekReview.spend.receipts === 1 ? "" : "s"})` : html` · spend: no receipts scanned`}
            ${lastWeekReview.tossed.count > 0 ? html` · tossed ${lastWeekReview.tossed.count}: ${lastWeekReview.tossed.foods.join(", ")}` : html` · nothing tossed ✓`}
            ${lastWeekReview.time ? html` · ${lastWeekReview.time.timed} timed cook${lastWeekReview.time.timed === 1 ? "" : "s"}: ${lastWeekReview.time.recordedMin}m real vs ${lastWeekReview.time.statedMin}m stated` : html` · no cooks timed`}${" "}
            · weigh-ins ${lastWeekReview.weighIns.count}/${lastWeekReview.weighIns.days}
          </div>
        </div>`
      }

      <${CookBlocks}
        recipes=${identityRecipes ?? recipes}
        plan=${plan}
        tableConflicts=${tableConflicts}
        nextPlan=${nextPlan}
        daily=${daily}
        pantry=${pantry}
        onPatchDay=${onPatchDay}
      />
    </div>
  `;
}
