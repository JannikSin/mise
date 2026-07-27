import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { CORE_SESSIONS, coreStepAt, LEAD_IN, sessionForDay, sessionSeconds } from "../lib/core.js";
import { CoreFigure } from "./core-figure.js";
import { keepAwake } from "../lib/awake.js";
import { pickForTraining } from "../lib/music.js";
import { localIsoDate } from "../lib/dates.js";

/** short beep via WebAudio — no asset, no CSP issue. Three tones: high =
 * new exercise, mid = the last 3 seconds ticking, low double = all done.
 * Fails silently where audio is blocked (the vibration still fires). */
function beep(/** @type {"phase" | "tick" | "done"} */ kind) {
  try {
    const Ctx = window.AudioContext ?? /** @type {any} */ (window).webkitAudioContext;
    const ctx = new Ctx();
    const times = kind === "done" ? [0, 0.25] : [0];
    for (const t of times) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = kind === "done" ? 440 : kind === "tick" ? 660 : 880;
      gain.gain.setValueAtTime(kind === "tick" ? 0.12 : 0.2, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        ctx.currentTime + t + (kind === "tick" ? 0.1 : 0.18),
      );
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.2);
    }
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* audio blocked — vibration covers it */
  }
}

/** "45s" / "1:30" */
const dur = (/** @type {number} */ s) =>
  s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;

const titleOf = (/** @type {any} */ step) =>
  step ? `${step.name}${step.side ? ` · ${step.side === "L" ? "LEFT" : "RIGHT"}` : ""}` : "";

/**
 * The directed core session (replaces the old configurable interval timer,
 * David 2026-07-27: the timer still made him decide what to do). Pick a
 * session or take the day's, press START, and it calls every exercise, counts
 * it down, and moves itself on. Screen stays awake while it runs.
 * @param {{ open?: boolean }} props
 */
export function CoreWorkout({ open = false }) {
  const today = localIsoDate(new Date());
  const [pickedId, setPickedId] = useState(/** @type {string | null} */ (null));
  const session = CORE_SESSIONS.find((s) => s.id === pickedId) ?? sessionForDay(today);
  // null = idle; { startedAt, elapsed } drives everything else
  const [run, setRun] = useState(
    /** @type {{ startedAt: number | null, elapsed: number } | null} */ (null),
  );
  const [, forceTick] = useState(0);
  const lastPhaseRef = useRef("");
  const lastTickRef = useRef(-1);
  const [tune, setTune] = useState(0);

  const elapsed = run
    ? run.elapsed + (run.startedAt != null ? (Date.now() - run.startedAt) / 1000 : 0)
    : 0;
  const at = coreStepAt(Math.floor(elapsed), session.steps, LEAD_IN);
  const running = Boolean(run && run.startedAt != null);
  const total = sessionSeconds(session);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => forceTick((n) => n + 1), 250);
    // one shared implementation, which RE-ACQUIRES when you come back to the
    // app. The old inline version dropped the lock the first time the phone
    // was glanced away from and never asked for it again, so a session longer
    // than one glance ended with the screen asleep.
    const release = keepAwake();
    // a backgrounded tab has its timers throttled to about once a minute, so
    // coming back to the app can show a stale number for a beat. The clock
    // itself is derived from the start timestamp and was never wrong, but the
    // PAINT was, so repaint the moment the tab is looked at again.
    const onVisible = () => forceTick((n) => n + 1);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      release();
    };
  }, [running]);

  // cues: a beep and a buzz when the exercise changes, a quieter tick through
  // the last 3 seconds so you can finish a hold without looking at the phone
  useEffect(() => {
    if (!run) {
      lastPhaseRef.current = "";
      lastTickRef.current = -1;
      return;
    }
    const key = `${at.phase}|${at.index}`;
    if (lastPhaseRef.current && lastPhaseRef.current !== key) {
      beep(at.phase === "done" ? "done" : "phase");
      if ("vibrate" in navigator) navigator.vibrate(at.phase === "done" ? [200, 100, 200] : 150);
    }
    lastPhaseRef.current = key;
    const left = Math.ceil(at.remaining);
    if (at.phase !== "done" && left <= 3 && left > 0 && left !== lastTickRef.current) {
      lastTickRef.current = left;
      beep("tick");
    }
    if (at.phase === "done" && run.startedAt != null) setRun({ startedAt: null, elapsed });
  }, [at.phase, at.index, Math.ceil(at.remaining), run !== null]);

  const start = () => {
    lastPhaseRef.current = "";
    lastTickRef.current = -1;
    setRun({ startedAt: Date.now(), elapsed: 0 });
  };

  // SKIP jumps the clock to the start of the next step, so the rest of the
  // session keeps its own timings instead of being shifted by a partial step
  const skip = () => {
    const steps = session.steps;
    let mark = LEAD_IN;
    for (let i = 0; i <= at.index && i < steps.length; i++) {
      if (i < 0) continue;
      const s = /** @type {any} */ (steps[i]);
      mark += s.seconds + (steps[i + 1] ? s.rest : 0);
    }
    setRun({ startedAt: running ? Date.now() : null, elapsed: mark });
  };

  return html`
    <details class="coreblock" open=${open}>
      <summary class="block-title">
        🧱 Core session <span class="hint">floor, no kit, it calls every move</span>
      </summary>

      ${
        run === null &&
        html`
          <div class="chips wrapchips" role="group" aria-label="Which core session">
            ${CORE_SESSIONS.map(
              (s) => html`
                <button
                  key=${s.id}
                  class=${session.id === s.id ? "chip on" : "chip"}
                  aria-pressed=${session.id === s.id}
                  onClick=${() => setPickedId(s.id)}
                >
                  ${s.name}${sessionForDay(today).id === s.id ? " ·today" : ""}
                </button>
              `,
            )}
          </div>
          <p class="hint">
            ${session.focus}. ${session.steps.length} moves,
            <span class="num">${dur(total)}</span> including rest. ${session.note}
          </p>
          <div class="slots corelist">
            ${session.steps.map(
              (s, i) => html`
                <div class="checkrow static corerow" key=${`${s.name}-${i}`}>
                  <${CoreFigure} name=${s.name} small=${true} />
                  <span class="food">${titleOf(s)}</span>
                  <span class="q num">
                    ${dur(s.seconds)}${s.rest > 0 ? ` · ${s.rest}s rest` : " · straight in"}
                  </span>
                </div>
              `,
            )}
          </div>
        `
      }
      ${
        run !== null &&
        html`
          <div class="tface ${at.phase}" role="timer" aria-live="polite">
            <div class="tphase">
              ${
                at.phase === "done"
                  ? "DONE ✓"
                  : at.phase === "ready"
                    ? "GET READY · FIRST UP"
                    : at.phase === "rest"
                      ? "REST · NEXT UP"
                      : `${at.index + 1}/${session.steps.length} · ${dur(Math.ceil(at.workLeft))} of work left`
              }
            </div>
            <div class="corename">
              ${
                at.phase === "done"
                  ? session.name
                  : at.phase === "ready"
                    ? titleOf(at.next)
                    : at.phase === "rest"
                      ? titleOf(at.next)
                      : titleOf(at.step)
              }
            </div>
            ${
              // the figure for whatever is being asked for NEXT: during the
              // lead-in and during a rest that is the move about to start, so
              // the shape is on screen before you have to be in it
              at.phase !== "done" &&
              html`<${CoreFigure} name=${(at.phase === "work" ? at.step : at.next)?.name ?? ""} />`
            }
            <div class="tclock num">
              ${at.phase === "done" ? "✓" : String(Math.ceil(at.remaining))}
            </div>
            ${
              // the cue shows during the lead-in and the rest as well, which
              // is the actual fix: you read it BEFORE you are in position
              at.phase !== "done" &&
              (at.phase === "work" ? at.step : at.next) &&
              html`<p class="corecue">
                ${/** @type {any} */ (at.phase === "work" ? at.step : at.next).cue}
              </p>`
            }
            ${
              at.phase === "work" &&
              at.next &&
              at.step &&
              at.step.rest === 0 &&
              html`<p class="hint">straight into ${titleOf(at.next)}, no rest</p>`
            }
            ${
              at.phase === "done" &&
              html`<p class="hint">
                ${session.steps.length} moves done. Tomorrow's rotation:
                ${sessionForDay(localIsoDate(new Date(Date.now() + 86400000))).name}.
              </p>`
            }
          </div>
          <div class="tactions">
            ${
              at.phase !== "done" &&
              html`
                <button
                  class="secondary"
                  onClick=${() =>
                    running
                      ? setRun({ startedAt: null, elapsed })
                      : setRun({ startedAt: Date.now(), elapsed: run.elapsed })}
                >
                  ${running ? "PAUSE" : "RESUME"}
                </button>
                <button class="secondary" onClick=${skip}>SKIP</button>
              `
            }
            <button class="secondary" onClick=${() => setRun(null)}>
              ${at.phase === "done" ? "BACK" : "STOP"}
            </button>
          </div>
        `
      }
      ${
        run === null &&
        html`
          ${(() => {
            const p = pickForTraining(tune);
            return html`<div class="row tunerow">
              <a class="secondary linkbtn tunelink" href=${p.url} rel="noopener noreferrer">
                🎧 ${p.label}
              </a>
              <button
                class="linktext"
                aria-label="Suggest something else"
                onClick=${() => setTune(tune + 1)}
              >
                something else ↻
              </button>
            </div>`;
          })()}
          <div class="tactions">
            <button class="ask tstart" onClick=${start}>START · ${dur(total)}</button>
          </div>
        `
      }
    </details>
  `;
}
