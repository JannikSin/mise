import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { TOUR_STEPS } from "../lib/tour.js";

/**
 * Coach-mark overlay walking TOUR_STEPS (docs/tutorial-design.md v3).
 * Owns its own step cursor; the parent only persists progress. The backdrop
 * is one element whose giant box-shadow dims everything but the target
 * cutout. Background scroll is blocked by intercepting touchmove/wheel on
 * the backdrop (passive:false) instead of body overflow:hidden, which is
 * the iOS-safe choice: programmatic scrollIntoView between steps keeps
 * working and Safari's fixed-body scroll-restore bug never comes up.
 * A step whose element is missing after the route settles (empty week, no
 * report yet) auto-skips in the direction of travel, never a card at (0,0).
 * @param {{
 *   startStep: number,
 *   onProgress: (step: number) => void,
 *   onEnd: (status: "done" | "bailed", lastStep: number) => void
 * }} props
 */
export function TourOverlay({ startStep, onProgress, onEnd }) {
  const [step, setStep] = useState(Math.min(Math.max(startStep, 0), TOUR_STEPS.length - 1));
  const [rect, setRect] = useState(/** @type {DOMRect | null} */ (null));
  const dirRef = useRef(1);
  const s = /** @type {import("../lib/tour.js").TourStep} */ (TOUR_STEPS[step]);

  const go = (/** @type {number} */ next, /** @type {number} */ dir) => {
    dirRef.current = dir;
    if (next < 0) return;
    if (next >= TOUR_STEPS.length) return onEnd("done", TOUR_STEPS.length);
    onProgress(next);
    setStep(next);
  };

  useEffect(() => {
    let alive = true;
    if (location.hash !== s.route) location.hash = s.route;
    setRect(null);
    let tries = 0;
    const measure = () => {
      if (!alive) return;
      const el = document.querySelector(s.selector);
      if (!el) {
        // the view may still be mounting after the route change; the element
        // may also legitimately not exist right now — then skip the step
        if (tries++ < 8) return void setTimeout(measure, 60);
        const next = step + dirRef.current;
        if (next < 0 || next >= TOUR_STEPS.length) onEnd("done", step + 1);
        else setStep(next);
        return;
      }
      el.scrollIntoView({ block: "center" });
      requestAnimationFrame(() => {
        if (alive) setRect(el.getBoundingClientRect());
      });
    };
    measure();
    const remeasure = () => {
      const el = document.querySelector(s.selector);
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      alive = false;
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [step]);

  const block = (/** @type {Event} */ e) => e.preventDefault();
  // card above the target when the target sits in the lower half
  const cardBelow = !rect || rect.top + rect.height / 2 < window.innerHeight / 2;

  return html`
    <div
      class="tour"
      role="dialog"
      aria-modal="true"
      aria-label="Guided tour, step ${step + 1} of ${TOUR_STEPS.length}"
      onTouchMove=${block}
      onWheel=${block}
    >
      ${
        rect &&
        html`<div
          class="tour-cutout"
          style=${`top:${rect.top - 6}px;left:${rect.left - 6}px;width:${rect.width + 12}px;height:${rect.height + 12}px`}
        ></div>`
      }
      <div
        class="tour-card ${cardBelow ? "below" : "above"}"
        style=${rect ? (cardBelow ? `top:${Math.min(rect.bottom + 14, window.innerHeight - 220)}px` : `bottom:${window.innerHeight - rect.top + 14}px`) : "top:40%"}
      >
        <div class="tour-dots num" aria-hidden="true">${step + 1} / ${TOUR_STEPS.length}</div>
        <div class="tour-title">${s.title}</div>
        <div class="tour-text">${s.text}</div>
        <div class="tour-btns">
          <button class="secondary" onClick=${() => onEnd("bailed", step + 1)}>END</button>
          ${step > 0 && html`<button class="secondary" onClick=${() => go(step - 1, -1)}>BACK</button>`}
          <button class="primary" onClick=${() => go(step + 1, 1)}>
            ${step === TOUR_STEPS.length - 1 ? "DONE" : "NEXT"}
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * The one-time offer card (first login of a profile on this device) and the
 * resume variant after an interrupted run.
 * @param {{
 *   resumeStep: number | null,
 *   onStart: () => void,
 *   onDismiss: () => void
 * }} props
 */
export function TourOffer({ resumeStep, onStart, onDismiss }) {
  return html`
    <div class="tour-offer" role="dialog" aria-label="Tour offer">
      <div class="tour-title">${resumeStep ? "Finish the tour?" : "New here?"}</div>
      <div class="tour-text">
        ${
          resumeStep
            ? `You were on step ${resumeStep} of ${TOUR_STEPS.length}. Pick up where you left off.`
            : "2-minute tour of every button. You can replay it any time from SYS."
        }
      </div>
      <div class="tour-btns">
        <button class="secondary" onClick=${onDismiss}>SKIP</button>
        <button class="primary" onClick=${onStart}>
          ${resumeStep ? "RESUME" : "TAKE THE TOUR"}
        </button>
      </div>
    </div>
  `;
}
