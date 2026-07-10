import { html } from "htm/preact";
import { computeStreak, templateForDate } from "../lib/fitness.js";
import { weightTrend } from "../lib/weight.js";
import { DozenTally } from "./dozen-tally.js";

/**
 * Plain-English read of the gain-phase weight trend (targets.adjustmentRule:
 * +0.25 to +0.75 lb/wk is on target).
 * @param {import("../lib/weight.js").WeightTrend} trend
 * @returns {string}
 */
function trendLine(trend) {
  if (trend.lbPerWeek === null) return "weigh in for a few more mornings to set a baseline";
  if (trend.verdict === "too-slow") return "flat 2 weeks, add ~200 cal";
  if (trend.verdict === "too-fast") return "gaining fast, trim ~200 cal";
  const sign = trend.lbPerWeek >= 0 ? "+" : "";
  return `${sign}${trend.lbPerWeek.toFixed(1)} lb/wk, on target`;
}

/**
 * Landing view: the daily check-in (sleep/weight/pushups/water/supplements/
 * streak, absorbed from the old fitness DAILY segment) plus a compact today
 * summary linking out to Cook and Train, and a quiet remedies link.
 * @param {{
 *   recipes: Record<string, any>[],
 *   plan: { week: string, entries: Record<string, any>[] },
 *   hasToken: boolean,
 *   repo: Record<string, any> | null,
 *   daily: { days: Record<string, any>[] },
 *   targets: Record<string, any> | null,
 *   workouts: { templates: Record<string, any>[], sessions: Record<string, any>[], schedule?: Record<string, string | null> },
 *   today: string,
 *   loading: boolean,
 *   onPatchDay: (patch: Record<string, any>) => void
 * }} props
 */
export function HomeView({
  recipes,
  plan,
  hasToken,
  repo,
  daily,
  targets,
  workouts,
  today,
  loading,
  onPatchDay,
}) {
  const day = daily.days.find((d) => d.date === today) ?? { date: today };
  const supplements = day.supplements ?? {};
  const trend = weightTrend(daily.days, today);

  const patchNum = (/** @type {string} */ field, /** @type {string} */ v) => {
    const n = Number(v);
    if (v !== "" && Number.isFinite(n)) onPatchDay({ [field]: n });
  };

  const mealCount = plan.entries.filter((e) => e.date === today).length;
  const mealsLabel =
    mealCount === 0 ? "nothing planned" : `${mealCount} meal${mealCount === 1 ? "" : "s"} planned`;

  // one source of truth with Train (app/views/fitness.js): the fixed weekly
  // schedule, not a picker (Phase 8: zero-guesswork Train)
  const hasSchedule = workouts.schedule !== undefined;
  const scheduledTemplate = templateForDate(workouts.schedule, workouts.templates, today);
  const workoutLabel = !hasSchedule ? null : (scheduledTemplate?.name ?? "rest day");

  return html`
    <div class="view">
      <div class="hero">
        <h1>Mise<span>.</span></h1>
        <div class="sub">
          ${recipes.length} recipes · ${" "}
          ${
            hasToken
              ? repo?.auth === "invalid"
                ? html`<a href="#/system"><b>token needs renewing: SYS</b></a>`
                : "data connected"
              : html`<b>connect token in SYS</b>`
          }
        </div>
      </div>

      <h2 class="block-title">Today</h2>
      <div class="todaylist">
        <a class="todayrow" href="#/today">
          <span class="t">Cook</span>
          <span class="n">${mealsLabel}</span>
          <span class="m num">›</span>
        </a>
        ${
          workoutLabel &&
          html`<a class="todayrow" href="#/train">
            <span class="t">Train</span>
            <span class="n">${workoutLabel}</span>
            <span class="m num">›</span>
          </a>`
        }
      </div>

      <h2 class="block-title">${today} — morning check-in</h2>
      ${loading && html`<p class="hint">loading today's numbers…</p>`}
      <div class="grid">
        <label class="tile">
          <span class="k">Sleep h</span>
          <input
            class="dailynum num"
            type="number"
            inputmode="decimal"
            step="0.5"
            aria-label="Sleep hours"
            value=${day.sleepHours ?? ""}
            onChange=${(/** @type {any} */ e) => patchNum("sleepHours", e.currentTarget.value)}
          />
        </label>
        <label class="tile">
          <span class="k">Weight lb</span>
          <input
            class="dailynum num"
            type="number"
            inputmode="decimal"
            step="0.1"
            aria-label="Weight in pounds"
            value=${day.weight ?? ""}
            onChange=${(/** @type {any} */ e) => patchNum("weight", e.currentTarget.value)}
          />
        </label>
      </div>
      <div class="tile">
        <div class="k">Weight trend</div>
        <div class="v num">
          ${trend.current ?? "—"}<small> lb</small>
        </div>
        <div class="d num">
          7-day avg ${trend.avg7 !== null ? trend.avg7.toFixed(1) : "—"} · ${trendLine(trend)}
        </div>
      </div>
      <p class="hint">weigh right after waking, after the bathroom, before eating or drinking, no clothes. same routine every time.</p>
      <div class="slots counters">
        <div class="checkrow counter">
          <button
            class="stepbtn"
            aria-label="Remove 20 pushups (now ${day.pushups ?? 0})"
            onClick=${() => onPatchDay({ pushups: Math.max(0, (day.pushups ?? 0) - 20) })}
          >
            −20
          </button>
          <span class="food">Pushups</span>
          <span class="countnum num"
            >${day.pushups ?? 0}<small>/${targets?.pushupsPerDay ?? 200}</small></span
          >
          <button
            class="stepbtn plus"
            aria-label="Add 20 pushups (now ${day.pushups ?? 0} of ${targets?.pushupsPerDay ?? 200})"
            onClick=${() => onPatchDay({ pushups: (day.pushups ?? 0) + 20 })}
          >
            +20
          </button>
        </div>
        <div class="checkrow counter">
          <button
            class="stepbtn"
            aria-label="Remove a quarter liter of water (now ${day.water ?? 0} liters)"
            onClick=${() => onPatchDay({ water: Math.max(0, ((day.water ?? 0) * 4 - 1) / 4) })}
          >
            −¼
          </button>
          <span class="food">Water</span>
          <span class="countnum num"
            >${day.water ?? 0}<small>/${targets?.macros?.waterLiters ?? 3.5} L</small></span
          >
          <button
            class="stepbtn plus"
            aria-label="Add a quarter liter of water — a cup is about 250ml (now ${day.water ?? 0} liters)"
            onClick=${() => onPatchDay({ water: ((day.water ?? 0) * 4 + 1) / 4 })}
          >
            +¼
          </button>
        </div>
      </div>
      <p class="hint">water in liters — a cup ≈ ¼, a bottle = 1. mis-taps: use −.</p>
      <h2 class="block-title">Supplements</h2>
      <div class="slots">
        ${(targets?.supplementPlan ?? []).map(
          (/** @type {Record<string, any>} */ s) => html`
            <div class="checkrow ${supplements[s.id] ? "done" : ""}" key=${s.id}>
              <button
                class="tickarea"
                aria-pressed=${Boolean(supplements[s.id])}
                onClick=${() =>
                  onPatchDay({ supplements: { ...supplements, [s.id]: !supplements[s.id] } })}
              >
                <span class="box" aria-hidden="true">${supplements[s.id] ? "✓" : ""}</span>
                <span class="food">${s.name}</span>
                <span class="q num">${s.dose}</span>
              </button>
            </div>
          `,
        )}
        ${
          (targets?.supplementPlan ?? []).length === 0 &&
          html`<div class="empty">${loading ? "loading…" : "no supplement plan in targets"}</div>`
        }
      </div>
      <h2 class="block-title">Daily Dozen</h2>
      <${DozenTally} day=${day} targets=${targets} onPatchDay=${onPatchDay} />
      <h2 class="block-title">Streak</h2>
      <div class="tile streaktile">
        <div class="v num">
          ${computeStreak(
            /** @type {any} */ (daily.days),
            (targets?.supplementPlan ?? []).map((/** @type {any} */ s) => s.id),
            targets?.pushupsPerDay ?? 200,
            targets?.macros?.waterLiters ?? 3.5,
            today,
          )}<small> day streak</small>
        </div>
        <div class="d">
          a day counts: sleep logged · pushups done · water done · all supplements ✓
        </div>
      </div>

      <a class="secondary linkbtn remedy" href="#/remedies">feeling off? → remedies</a>
    </div>
  `;
}
