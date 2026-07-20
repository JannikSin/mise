import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { intervalPhaseAt } from "../lib/fitness.js";

/** short beep via WebAudio — no asset, no CSP issue. Two tones: high =
 * phase change, low double = all done. Fails silently where audio is
 * blocked (the vibration still fires). */
function beep(/** @type {"phase" | "done"} */ kind) {
  try {
    const Ctx = window.AudioContext ?? /** @type {any} */ (window).webkitAudioContext;
    const ctx = new Ctx();
    const times = kind === "done" ? [0, 0.25] : [0];
    for (const t of times) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = kind === "done" ? 440 : 880;
      gain.gain.setValueAtTime(0.2, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.2);
    }
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* audio blocked — vibration covers it */
  }
}

/**
 * Interval timer for the Train tab (roadmap F1): configurable work/rest/
 * rounds (David's ab circuit: 60 on / 60 off), big phase display, audio +
 * vibration cues on every phase change, screen kept awake while running.
 * Timing derives from a wall-clock start timestamp, not tick counting, so
 * a throttled background tab never drifts the clock.
 * @param {{ open?: boolean }} props
 */
export function IntervalTimer({ open = false }) {
  const [work, setWork] = useState(60);
  const [rest, setRest] = useState(60);
  const [rounds, setRounds] = useState(3);
  // null = idle; { startedAt, pausedElapsed } drives everything else
  const [run, setRun] = useState(
    /** @type {{ startedAt: number | null, elapsed: number } | null} */ (null),
  );
  const [, forceTick] = useState(0);
  const lastPhaseRef = useRef("");

  const elapsed = run
    ? run.elapsed + (run.startedAt != null ? (Date.now() - run.startedAt) / 1000 : 0)
    : 0;
  const at = intervalPhaseAt(Math.floor(elapsed), work, rest, rounds);
  const running = Boolean(run && run.startedAt != null);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => forceTick((n) => n + 1), 250);
    /** @type {any} */
    let lock = null;
    if ("wakeLock" in navigator) {
      /** @type {any} */ (navigator).wakeLock.request("screen").then(
        (/** @type {any} */ l) => {
          lock = l;
        },
        () => {},
      );
    }
    return () => {
      clearInterval(t);
      if (lock) lock.release().catch(() => {});
    };
  }, [running]);

  // phase-change cues (audio + vibration), including the final DONE
  useEffect(() => {
    if (!run) {
      lastPhaseRef.current = "";
      return;
    }
    const key = `${at.phase}|${at.round}`;
    if (lastPhaseRef.current && lastPhaseRef.current !== key) {
      beep(at.phase === "done" ? "done" : "phase");
      if ("vibrate" in navigator) navigator.vibrate(at.phase === "done" ? [200, 100, 200] : 150);
    }
    lastPhaseRef.current = key;
    if (at.phase === "done" && run.startedAt != null) {
      setRun({ startedAt: null, elapsed });
    }
  }, [at.phase, at.round, run !== null]);

  const mmss = (/** @type {number} */ s) =>
    `${Math.floor(s / 60)}:${String(Math.ceil(s % 60)).padStart(2, "0")}`;

  const numField = (
    /** @type {string} */ label,
    /** @type {number} */ value,
    /** @type {(n: number) => void} */ set,
    /** @type {number} */ max,
  ) => html`
    <label class="tfield">
      <span class="k">${label}</span>
      <input
        type="number"
        inputmode="numeric"
        min="0"
        max=${max}
        value=${value}
        disabled=${run !== null}
        onInput=${(/** @type {any} */ e) => {
          const n = Number(e.currentTarget.value);
          if (Number.isFinite(n)) set(Math.max(0, Math.min(max, Math.round(n))));
        }}
      />
    </label>
  `;

  return html`
    <details class="intervaltimer" open=${open}>
      <summary class="block-title">
        ⏱ Interval timer <span class="hint">work / rest / rounds, beeps + buzz</span>
      </summary>
      <div class="tconfig">
        ${numField("WORK s", work, setWork, 3600)} ${numField("REST s", rest, setRest, 3600)}
        ${numField("ROUNDS", rounds, setRounds, 50)}
      </div>
      <div class="tface ${run ? at.phase : ""}" role="timer" aria-live="polite">
        <div class="tphase">
          ${
            run
              ? at.phase === "done"
                ? "DONE ✓"
                : `${at.phase.toUpperCase()} · ROUND ${at.round}/${rounds}`
              : "READY"
          }
        </div>
        <div class="tclock num">${run ? mmss(at.remaining) : mmss(work)}</div>
      </div>
      <div class="tactions">
        ${
          run === null
            ? html`<button
                class="ask tstart"
                disabled=${work <= 0 || rounds <= 0}
                onClick=${() => {
                  lastPhaseRef.current = "";
                  setRun({ startedAt: Date.now(), elapsed: 0 });
                }}
              >
                START
              </button>`
            : html`
                ${
                  at.phase !== "done" &&
                  html`<button
                    class="secondary"
                    onClick=${() =>
                      running
                        ? setRun({ startedAt: null, elapsed })
                        : setRun({ startedAt: Date.now(), elapsed: run.elapsed })}
                  >
                    ${running ? "PAUSE" : "RESUME"}
                  </button>`
                }
                <button class="secondary" onClick=${() => setRun(null)}>RESET</button>
              `
        }
      </div>
    </details>
  `;
}
