import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { localIsoDate, parseLocalIso } from "../lib/dates.js";
import {
  lastSetsFor,
  formatSets,
  personalRecords,
  seriesFor,
  setTopSet,
  templateForDate,
} from "../lib/fitness.js";
import { IntervalTimer } from "./interval-timer.js";

const SEGMENTS = ["train", "log", "targets"];
const PRIMARY_LIFTS = ["Squat", "Bench Press", "Deadlift or Barbell Row", "Overhead Press"];
const REST_SECONDS = 90;

/** "lower-a" -> "Lower A" — short label for the rest-day "next up" line. */
const shortName = (/** @type {string} */ id) =>
  id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/**
 * Short label for the next scheduled session after today, e.g. "Pull A
 * tomorrow" — names what's coming instead of leaving the rest-day state
 * blank.
 * @param {Record<string, string | null> | undefined} schedule
 * @param {Record<string, any>[]} templates
 * @param {string} todayIso
 * @returns {string | null}
 */
function nextSessionLabel(schedule, templates, todayIso) {
  const cursor = parseLocalIso(todayIso);
  for (let i = 1; i <= 7; i++) {
    cursor.setDate(cursor.getDate() + 1);
    const t = templateForDate(schedule, templates, localIsoDate(cursor));
    if (t) return i === 1 ? `${shortName(t.id)} tomorrow` : `${shortName(t.id)} in ${i} days`;
  }
  return null;
}

/**
 * Single-series progression sparkline (dataviz: 2px line, endpoint marker,
 * values as adjacent text in text tokens, aria summary, no legend needed).
 * @param {{ series: { date: string, top: number }[], label: string, loading: boolean }} props
 */
function Sparkline({ series, label, loading }) {
  if (series.length < 2) {
    return html`<div class="spark-empty hint">
      ${
        loading
          ? "loading…"
          : series.length === 1
            ? `one session — ${series[0]?.top || "bw"}`
            : "no sessions yet"
      }
    </div>`;
  }
  const W = 100;
  const H = 28;
  const PAD = 3;
  const tops = series.map((p) => p.top);
  const min = Math.min(...tops);
  const max = Math.max(...tops);
  const span = max - min || 1;
  const x = (/** @type {number} */ i) => PAD + (i * (W - 2 * PAD)) / (series.length - 1);
  const y = (/** @type {number} */ v) => H - PAD - ((v - min) * (H - 2 * PAD)) / span;
  const points = series.map((p, i) => `${x(i).toFixed(1)},${y(p.top).toFixed(1)}`).join(" ");
  const last = series[series.length - 1];
  const desc = `${label}: ${series.length} sessions, ${series[0]?.top} to ${last?.top}, best ${max}`;
  return html`
    <div class="spark">
      <svg viewBox="0 0 ${W} ${H}" class="sparksvg" role="img" aria-label=${desc}>
        <line x1="0" y1=${H - 1} x2=${W} y2=${H - 1} class="spark-base" />
        <polyline points=${points} class="spark-line" />
        <circle cx=${x(series.length - 1)} cy=${y(last?.top ?? min)} r="2.5" class="spark-dot" />
      </svg>
      <span class="spark-vals num">${last?.top} <small>best ${max}</small></span>
    </div>
  `;
}

/**
 * Fitness page (blueprint §6.6): TRAIN / LOG / TARGETS. The in-progress
 * session (draft) lives in App state so tab navigation can never discard
 * logged sets. The daily check-in (sleep/weight/pushups/water/supplements/
 * streak) moved to Home — see app/views/home.js.
 * @param {{
 *   workouts: { templates: Record<string, any>[], sessions: Record<string, any>[], schedule?: Record<string, string | null> },
 *   targets: Record<string, any> | null,
 *   today: string,
 *   hasToken: boolean,
 *   repo: Record<string, any> | null,
 *   loading: boolean,
 *   draft: { templateId: string | null, session: Record<string, any> | null, inputs: Record<string, { w: string, r: string }> },
 *   onDraft: (d: { templateId: string | null, session: Record<string, any> | null, inputs: Record<string, { w: string, r: string }> }) => void,
 *   onSaveSession: (session: Record<string, any>) => void
 * }} props
 */
export function FitnessView({
  workouts,
  targets,
  today,
  hasToken,
  repo,
  loading,
  draft,
  onDraft,
  onSaveSession,
}) {
  const [seg, setSeg] = useState("train");
  const [rest, setRest] = useState(0);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [invalid, setInvalid] = useState(/** @type {string | null} */ (null));
  const [showPicker, setShowPicker] = useState(false);
  const restRef = useRef(/** @type {ReturnType<typeof setInterval> | null} */ (null));

  useEffect(() => {
    return () => {
      if (restRef.current) clearInterval(restRef.current);
    };
  }, []);

  const startRest = () => {
    if (restRef.current) clearInterval(restRef.current);
    setRest(REST_SECONDS);
    restRef.current = setInterval(() => {
      setRest((r) => {
        if (r <= 1 && restRef.current) clearInterval(restRef.current);
        return Math.max(0, r - 1);
      });
    }, 1000);
  };

  const { session, inputs } = draft;
  // Phase 8: Train shows today's session from the fixed schedule, nothing to
  // pick. draft.templateId only gets set when David explicitly overrides via
  // the escape hatch — that pick wins over the schedule for this draft.
  const hasSchedule = workouts.schedule !== undefined;
  const scheduled = templateForDate(
    workouts.schedule,
    /** @type {any} */ (workouts.templates),
    today,
  );
  const pickedTemplate = draft.templateId
    ? workouts.templates.find((t) => t.id === draft.templateId)
    : null;
  const template = hasSchedule ? (pickedTemplate ?? scheduled) : pickedTemplate;
  const nextLabel = hasSchedule
    ? nextSessionLabel(
        /** @type {any} */ (workouts.schedule),
        /** @type {any} */ (workouts.templates),
        today,
      )
    : null;
  const prs = personalRecords(/** @type {any} */ (workouts.sessions));
  const tokenBroken = repo?.auth === "invalid";

  const logSet = (/** @type {string} */ name) => {
    const inp = inputs[name] ?? { w: "", r: "" };
    const weight = Number(inp.w);
    const reps = Number(inp.r);
    // a BLANK weight is invalid (0 must be an explicit bodyweight entry) —
    // silently logging 0 would corrupt PRs for weighted lifts
    if (
      inp.w.trim() === "" ||
      !Number.isFinite(weight) ||
      weight < 0 ||
      !Number.isInteger(reps) ||
      reps <= 0
    ) {
      setInvalid(name);
      setTimeout(() => setInvalid(null), 1200);
      return;
    }
    const base = session ?? { date: today, templateId: template?.id ?? null, exercises: [] };
    onDraft({
      ...draft,
      session: setTopSet(/** @type {any} */ (base), name, { weight, reps }),
    });
  };

  const finishSession = () => {
    if (!session || session.exercises.length === 0) return;
    if (!confirmFinish) {
      setConfirmFinish(true);
      setTimeout(() => setConfirmFinish(false), 4000);
      return;
    }
    onSaveSession(session);
    onDraft({ templateId: null, session: null, inputs: {} });
    setConfirmFinish(false);
    setShowPicker(false);
  };

  return html`
    <div class="view">
      ${rest > 0 && html`<div class="restpill num" role="timer">REST ${rest}s</div>`}
      <div class="hero"><h1>Train</h1></div>

      ${
        tokenBroken &&
        html`<p class="hint">
          not syncing — token needs renewing in SYS (sets still save locally)
        </p>`
      }

      <div class="chips" role="group" aria-label="Fitness section">
        ${SEGMENTS.map(
          (s) => html`
            <button
              class="chip ${seg === s ? "on" : ""}"
              aria-pressed=${seg === s}
              onClick=${() => setSeg(s)}
            >
              ${s.toUpperCase()}
            </button>
          `,
        )}
      </div>

      ${
        seg === "train" &&
        html`
          ${
            !hasSchedule &&
            html`<p class="hint">
              no schedule set yet — add one to fitness/workouts.json in SYS. pick a session for now.
            </p>`
          }
          ${
            !template &&
            hasSchedule &&
            html`
              <h2 class="block-title">Rest day</h2>
              <p class="hint">${nextLabel ? `next: ${nextLabel}.` : "nothing scheduled next."}</p>
            `
          }
          ${
            template &&
            html`
              <div class="actions wrap">
                <button class="primary" onClick=${startRest}>REST ${REST_SECONDS}s</button>
                <button
                  class="secondary ${confirmFinish ? "arm" : ""}"
                  onClick=${finishSession}
                  disabled=${!session || session.exercises.length === 0}
                >
                  ${confirmFinish ? "TAP AGAIN TO FINISH" : "FINISH SESSION"}
                </button>
              </div>
              <h2 class="block-title">${template.name}</h2>
              <div class="slots">
                ${template.exercises.map((/** @type {Record<string, any>} */ ex) => {
                  const last = lastSetsFor(/** @type {any} */ (workouts.sessions), ex.name);
                  const logged = session?.exercises.find(
                    (/** @type {any} */ e) => e.name === ex.name,
                  );
                  const inp = inputs[ex.name] ?? { w: "", r: "" };
                  return html`
                    <div class="lift" key=${ex.name}>
                      <div class="liftrow">
                        <span class="food">${ex.name}</span>
                        <span class="q num">${ex.targetSets}×${ex.targetReps}</span>
                      </div>
                      <div class="liftmeta num">
                        last: ${last ? formatSets(last) : "—"}
                        ${logged && html` <b>· now: ${formatSets(logged.sets)}</b>`}
                      </div>
                      ${ex.note && html`<div class="hint">${ex.note}</div>`}
                      <div class="setform ${invalid === ex.name ? "inputerr" : ""}">
                        <input
                          type="number"
                          inputmode="decimal"
                          placeholder="lb"
                          aria-label="Weight for ${ex.name} (0 for bodyweight)"
                          value=${inp.w}
                          onInput=${(/** @type {any} */ e) =>
                            onDraft({
                              ...draft,
                              inputs: {
                                ...inputs,
                                [ex.name]: { ...inp, w: e.currentTarget.value },
                              },
                            })}
                        />
                        <input
                          type="number"
                          inputmode="numeric"
                          placeholder="reps"
                          aria-label="Reps for ${ex.name}"
                          value=${inp.r}
                          onInput=${(/** @type {any} */ e) =>
                            onDraft({
                              ...draft,
                              inputs: {
                                ...inputs,
                                [ex.name]: { ...inp, r: e.currentTarget.value },
                              },
                            })}
                        />
                        <button class="primary" onClick=${() => logSet(ex.name)}>LOG</button>
                      </div>
                    </div>
                  `;
                })}
              </div>
            `
          }
          ${
            hasSchedule &&
            html`<button class="secondary" onClick=${() => setShowPicker((s) => !s)}>
              ${showPicker ? "hide session picker" : "log a different session"}
            </button>`
          }
          ${
            ((hasSchedule && showPicker) || (!hasSchedule && !template)) &&
            html`
              <h2 class="block-title">
                ${hasSchedule ? "Pick a different session" : "Pick today's split"}
              </h2>
              <div class="slots">
                ${workouts.templates.map(
                  (t) => html`
                    <button
                      class="checkrow"
                      key=${t.id}
                      onClick=${() => {
                        onDraft({ ...draft, templateId: t.id });
                        setShowPicker(false);
                      }}
                    >
                      <span class="food">${t.name}</span>
                      <span class="q num">${t.exercises.length} lifts</span>
                    </button>
                  `,
                )}
                ${
                  workouts.templates.length === 0 &&
                  html`<div class="empty">
                    ${hasToken ? (loading ? "loading…" : "no split templates yet") : "connect token in SYS"}
                  </div>`
                }
              </div>
            `
          }
          <${IntervalTimer} />
        `
      }
      ${
        seg === "log" &&
        html`
          <h2 class="block-title">Progression</h2>
          ${PRIMARY_LIFTS.map((name) => {
            const series = seriesFor(/** @type {any} */ (workouts.sessions), name);
            return html`
              <div class="liftrow chartrow" key=${name}>
                <span class="food">${name}</span>
                <${Sparkline} series=${series} label=${name} loading=${loading} />
              </div>
            `;
          })}
          <h2 class="block-title">PRs</h2>
          <div class="slots">
            ${[...prs.entries()].map(
              ([name, pr]) => html`
                <div class="checkrow static" key=${name}>
                  <span class="food">${name}</span>
                  <span class="q num"
                    >${pr.weight > 0 ? pr.weight : "bw"}×${pr.reps} · ${pr.date}</span
                  >
                </div>
              `,
            )}
            ${
              prs.size === 0 &&
              html`<div class="empty">
                ${loading ? "loading…" : "log a session to start the record book"}
              </div>`
            }
          </div>
          <h2 class="block-title">Sessions</h2>
          <div class="slots">
            ${[...workouts.sessions]
              .sort((a, b) => b.date.localeCompare(a.date))
              .slice(0, 14)
              .map(
                (s) => html`
                  <div class="checkrow static" key=${s.id ?? s.date + (s.templateId ?? "")}>
                    <span class="food">${s.templateId ?? "freeform"}</span>
                    <span class="q num"
                      >${s.date} ·
                      ${s.exercises.reduce(
                        (/** @type {number} */ n, /** @type {any} */ e) => n + e.sets.length,
                        0,
                      )}
                      sets</span
                    >
                  </div>
                `,
              )}
          </div>
        `
      }
      ${
        seg === "targets" &&
        html`
          <div class="grid">
            <div class="tile">
              <div class="k">Calories</div>
              <div class="v num">
                ${targets?.macros?.calories ?? (loading ? "…" : "—")}<small> /day</small>
              </div>
              <div class="d num">floor ${targets?.macros?.caloriesFloor ?? "—"}</div>
            </div>
            <div class="tile">
              <div class="k">Protein</div>
              <div class="v num">
                ${targets?.macros?.protein ?? (loading ? "…" : "—")}<small>g</small>
              </div>
              <div class="d num">floor ${targets?.macros?.proteinFloor ?? "—"}g</div>
            </div>
            <div class="tile">
              <div class="k">Water</div>
              <div class="v num">
                ${targets?.macros?.waterLiters ?? (loading ? "…" : "—")}<small> L</small>
              </div>
            </div>
            <div class="tile">
              <div class="k">Sleep</div>
              <div class="v num">
                ${targets?.sleepHoursTarget ?? (loading ? "…" : "—")}<small> h</small>
              </div>
            </div>
          </div>
          ${
            targets?.phase &&
            html`<p class="hint">phase: ${targets.phase} since ${targets.phaseSince ?? "—"}</p>`
          }
          <h2 class="block-title">Priority stack</h2>
          <ol class="steps">
            ${(targets?.priorityStack ?? []).map((/** @type {string} */ p) => html`<li key=${p}>${p}</li>`)}
          </ol>
          <h2 class="block-title">Adjustment rule</h2>
          <p class="hint">${targets?.adjustmentRule ?? "—"}</p>
        `
      }
    </div>
  `;
}
