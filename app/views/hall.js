import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { COURTS, MEALS, loadMeal, mealsOn, quotaFor } from "../lib/hall.js";
import { composeTray } from "../lib/dininghall.js";
import { localIsoDate } from "../lib/dates.js";

/**
 * THE DINING HALL, made reachable (P10).
 *
 * The composer in `dininghall.js` has been correct and tested since it
 * shipped and had zero importers, so "choose a hall and get a tray" was not
 * something a person could do. This is the screen.
 *
 * Three deliberate choices:
 *  - The QUOTA is the day's remaining need, not a third of the day. A tray is
 *    picked knowing what has already been eaten.
 *  - Allergens are a HARD screen, from Purdue's own per-item table, which is
 *    better data than a photographed menu. P3's obligation, recorded on P10.
 *  - The caution is not fine print. A court serving is whatever the server
 *    puts on the plate, so the tray is a shape, not a measurement, and the
 *    screen says so where it cannot be missed.
 *
 * @param {{
 *   targets?: Record<string, any> | null,
 *   onAddToPlan?: (meal: string, tray: Record<string, any>, court: string) => void
 * }} props
 */
export function HallView({ targets = null, onAddToPlan }) {
  const today = localIsoDate(new Date());
  const [court, setCourt] = useState(COURTS[0]?.id ?? "Earhart");
  const [date, setDate] = useState(today);
  const [meal, setMeal] = useState("Dinner");
  const [state, setState] = useState(/** @type {"idle"|"loading"|"done"|"error"} */ ("idle"));
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(/** @type {any} */ (null));
  // what the rest of the day already provides, typed by the person: the app
  // cannot know what a buffet plate weighed
  const [eatenCal, setEatenCal] = useState("");
  const [eatenPro, setEatenPro] = useState("");
  const abortRef = useRef(/** @type {AbortController | null} */ (null));

  useEffect(() => () => abortRef.current?.abort(), []);

  const dayTarget = {
    calories: Number(targets?.macros?.calories) || 0,
    protein: Number(targets?.macros?.protein) || 0,
  };
  const already = { calories: Number(eatenCal) || 0, protein: Number(eatenPro) || 0 };
  // MEALS LEFT, not 1. Defaulting to "the whole day" produced a tray of three
  // turkey burgers, three queso dips and two slices of Boston cream pie
  // totalling 3,972 kcal, which is a day at one sitting and not a meal. The
  // profile's own slot count is the honest default; a person eating their
  // last meal of the day sets it to 1 and gets the rest of the budget.
  const slotCount = Array.isArray(targets?.mealSlots) ? targets.mealSlots.length : 3;
  const [mealsLeft, setMealsLeft] = useState(String(Math.max(1, slotCount)));
  const quota = quotaFor(dayTarget, already, Number(mealsLeft) || 1);
  const avoid = Array.isArray(targets?.avoidAllergens) ? targets.avoidAllergens : [];

  const load = async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState("loading");
    setErr("");
    setLoaded(null);
    setProgress({ done: 0, total: 0 });
    try {
      const r = await loadMeal(court, date, meal, {
        onProgress: (done, total) => setProgress({ done, total }),
      });
      // a stale request must not overwrite a newer one: the fetch itself is
      // no longer abortable (it goes through the Worker), so the guard moves
      // here rather than disappearing
      if (ac.signal.aborted) return;
      setLoaded(r);
      setState("done");
    } catch (e) {
      if (ac.signal.aborted) return;
      setErr(e instanceof Error ? e.message : "that did not load");
      setState("error");
    }
  };

  const tray = loaded?.priced?.length
    ? composeTray(loaded.priced, quota, { avoidAllergens: avoid })
    : null;

  const availableMeals = loaded?.day ? mealsOn(loaded.day) : MEALS;

  return html`
    <section class="card">
      <h2>Dining hall</h2>
      <p class="hint">
        Pick a court and a meal and Mise builds a tray from what they are actually serving today,
        aimed at what is left of your day. Purdue publishes the numbers; the tray is composed from
        them, not guessed.
      </p>

      <div class="row">
        <span class="k">Court</span>
        <select
          aria-label="Dining court"
          value=${court}
          onChange=${(/** @type {any} */ e) => setCourt(e.currentTarget.value)}
        >
          ${COURTS.map((c) => html`<option key=${c.id} value=${c.id}>${c.label}</option>`)}
        </select>
      </div>
      <div class="row">
        <span class="k">Meal</span>
        <select
          aria-label="Meal"
          value=${meal}
          onChange=${(/** @type {any} */ e) => setMeal(e.currentTarget.value)}
        >
          ${availableMeals.map((m) => html`<option key=${m} value=${m}>${m}</option>`)}
        </select>
      </div>
      <div class="row">
        <span class="k">Date</span>
        <input
          type="date"
          aria-label="Date"
          value=${date}
          onInput=${(/** @type {any} */ e) => setDate(e.currentTarget.value)}
        />
      </div>

      <p class="hint">
        Already eaten today, if you know it. Leave blank and the tray aims at your whole day, which
        is only right if this is your first meal.
      </p>
      <div class="row">
        <span class="k">kcal so far</span>
        <input
          inputmode="numeric"
          aria-label="Calories already eaten today"
          placeholder="0"
          value=${eatenCal}
          onInput=${(/** @type {any} */ e) => setEatenCal(e.currentTarget.value)}
        />
      </div>
      <div class="row">
        <span class="k">protein so far</span>
        <input
          inputmode="numeric"
          aria-label="Protein already eaten today"
          placeholder="0"
          value=${eatenPro}
          onInput=${(/** @type {any} */ e) => setEatenPro(e.currentTarget.value)}
        />
      </div>

      <div class="row">
        <span class="k">meals left today</span>
        <input
          inputmode="numeric"
          aria-label="Meals left to eat today, including this one"
          value=${mealsLeft}
          onInput=${(/** @type {any} */ e) => setMealsLeft(e.currentTarget.value)}
        />
      </div>
      <p class="hint">
        Including this one. Set it to 1 if this is your last meal of the day and the tray should
        carry everything you have left.
      </p>

      <div class="row">
        <span class="k">This tray aims at</span>
        <span class="status num">${quota.calories} kcal · ${quota.protein} g</span>
      </div>

      <div class="actions">
        <button class="primary" onClick=${load} disabled=${state === "loading"}>
          ${state === "loading" ? "READING THE MENU…" : "BUILD MY TRAY"}
        </button>
      </div>

      ${
        state === "loading" &&
        progress.total > 0 &&
        html`<p class="hint">
          reading ${progress.done} of ${progress.total} dishes — each one's numbers are a separate
          lookup, which is why this is not instant
        </p>`
      }
      ${state === "error" && html`<p class="hint">⚠️ ${err}</p>`}
      ${
        state === "done" &&
        loaded &&
        loaded.published === false &&
        html`<p class="hint">⚠️ ${court} has not published this menu yet.</p>`
      }
      ${
        state === "done" &&
        loaded &&
        loaded.listed.length === 0 &&
        html`<p class="hint">${court} is not serving ${meal} on ${date}.</p>`
      }
    </section>

    ${
      tray &&
      html`<section class="card">
        <h3>${court} · ${meal}</h3>
        <p class="hint">
          ${loaded.priced.length} of ${loaded.listed.length} dishes published numbers. The rest
          cannot be composed with and are listed below.
        </p>

        ${
          tray.picks.length === 0
            ? html`<p class="hint">
                Nothing on this menu can meet that quota without breaking your allergen rules. Try
                another court, or another meal.
              </p>`
            : html`<ul class="tray">
                ${tray.picks.map(
                  (/** @type {any} */ p) => html`<li key=${p.name}>
                    <strong>${p.servings}×</strong> ${p.name}
                    <small class="hint">
                      ${Math.round(p.calories)} kcal · ${Math.round(p.protein)} g</small
                    >
                  </li>`,
                )}
              </ul>`
        }

        <div class="row">
          <span class="k">Tray total</span>
          <span class="status num"
            >${Math.round(tray.calories)} kcal · ${Math.round(tray.protein)} g</span
          >
        </div>
        <div class="row">
          <span class="k">Against the quota</span>
          <span class="status ${tray.meets.calories && tray.meets.protein ? "ok" : "warn"}">
            ${tray.meets.protein ? "protein ✓" : "protein short"} ·
            ${tray.meets.calories ? "calories ✓" : "calories short"}
          </span>
        </div>

        <p class="hint">⚠️ ${tray.caution}</p>

        ${
          tray.excluded.length > 0 &&
          html`<details>
            <summary class="hint">${tray.excluded.length} dishes it could not use</summary>
            <ul class="hint">
              ${tray.excluded
                .slice(0, 25)
                .map(
                  (/** @type {any} */ x) =>
                    html`<li key=${x.name}>${x.name} — ${x.because.join(", ")}</li>`,
                )}
            </ul>
          </details>`
        }

        ${
          onAddToPlan &&
          tray.picks.length > 0 &&
          html`<div class="actions">
            <button class="secondary" onClick=${() => onAddToPlan(meal, tray, court)}>
              PUT THIS ON ${date === today ? "TODAY" : "THAT DAY"}'S PLAN
            </button>
          </div>`
        }
      </section>`
    }
  `;
}
