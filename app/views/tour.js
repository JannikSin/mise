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
 * report yet) auto-skips in the direction of travel — and until a step's
 * element is FOUND, no card renders at all, so a skip is invisible instead
 * of a card that flashes up and yanks itself away mid-read.
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
  const cardRef = useRef(/** @type {HTMLElement | null} */ (null));
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
    /** @type {DOMRect | null} */
    let last = null;
    const changed = (/** @type {DOMRect} */ r) =>
      !last ||
      Math.abs(r.top - last.top) > 1 ||
      Math.abs(r.left - last.left) > 1 ||
      Math.abs(r.height - last.height) > 1 ||
      Math.abs(r.width - last.width) > 1;
    // iOS settles scrollIntoView over several frames and layout can keep
    // shifting after fonts/tiles land — a single one-shot measurement puts
    // the cutout where the button WAS. Track the element for the whole
    // step lifetime and move the cutout whenever it drifts.
    const track = (/** @type {Element} */ el) => {
      const tick = () => {
        if (!alive) return;
        const cur = document.querySelector(s.selector);
        if (cur) {
          const r = cur.getBoundingClientRect();
          if (changed(r)) {
            last = r;
            setRect(r);
          }
        }
        setTimeout(tick, 200);
      };
      // a target taller than the viewport minus the card zone scrolls to
      // the TOP so the visible spotlight covers as much of it as possible
      // above the bottom-pinned card
      const tall = el.getBoundingClientRect().height > window.innerHeight - 300;
      el.scrollIntoView({ block: tall ? "start" : "center" });
      // setTimeout, never requestAnimationFrame: browsers freeze rAF in
      // occluded/backgrounded tabs and iOS throttles it mid-scroll, which
      // left the tour stuck on the dim layer with no card at all
      setTimeout(tick, 50);
    };
    const find = () => {
      if (!alive) return;
      const el = document.querySelector(s.selector);
      if (el) return track(el);
      // nothing rendered yet (view mounting) or genuinely absent (no build
      // report before a generate): retry briefly, then skip. No card has
      // rendered, so the skip is invisible.
      if (tries++ < 10) return void setTimeout(find, 100);
      const next = step + dirRef.current;
      // walking off the FRONT (BACK through missing steps) is an abandoned
      // run, not a finished one — "done" here would suppress every future
      // offer for a user who saw almost nothing
      if (next < 0) return onEnd("bailed", step + 1);
      if (next >= TOUR_STEPS.length) return onEnd("done", step + 1);
      setStep(next);
    };
    find();
    const remeasure = () => {
      const el = document.querySelector(s.selector);
      if (el) {
        const r = el.getBoundingClientRect();
        if (changed(r)) {
          last = r;
          setRect(r);
        }
      }
    };
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      alive = false;
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [step]);

  // focus follows the card on every step: aria-modal without a focus move
  // strands screen-reader users outside the dialog, and the refocus is what
  // re-announces each step's label
  useEffect(() => {
    if (rect) cardRef.current?.focus();
  }, [step, rect === null]);

  const block = (/** @type {Event} */ e) => e.preventDefault();
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Escape") return onEnd("bailed", step + 1);
    if (e.key !== "Tab") return;
    // three-button focus trap: Tab never reaches the dimmed page behind
    const btns = [.../** @type {HTMLElement} */ (e.currentTarget).querySelectorAll("button")];
    const i = btns.indexOf(/** @type {any} */ (document.activeElement));
    e.preventDefault();
    const next = e.shiftKey
      ? i <= 0
        ? btns.length - 1
        : i - 1
      : i < 0 || i === btns.length - 1
        ? 0
        : i + 1;
    btns[next]?.focus();
  };

  // card placement: whichever side of the target has room for a full card;
  // neither side (tall target) pins the card to the bottom edge and the
  // cutout is clipped so spotlight and card never intersect
  const vh = window.innerHeight;
  const CARD_ROOM = 280;
  const placement = !rect
    ? { cls: "pinned", style: "" }
    : vh - rect.bottom >= CARD_ROOM
      ? { cls: "below", style: `top:${rect.bottom + 14}px` }
      : rect.top >= CARD_ROOM
        ? { cls: "above", style: `bottom:${vh - rect.top + 14}px` }
        : { cls: "pinned", style: "" };
  const cutTop = rect ? rect.top - 6 : 0;
  const cutHeight = rect
    ? placement.cls === "pinned"
      ? Math.max(56, Math.min(rect.height + 12, vh - CARD_ROOM - cutTop))
      : rect.height + 12
    : 0;

  return html`
    <div
      class="tour"
      role="dialog"
      aria-modal="true"
      aria-label="Guided tour, step ${step + 1} of ${TOUR_STEPS.length}"
      onTouchMove=${block}
      onWheel=${block}
      onKeyDown=${onKey}
    >
      ${
        rect
          ? html`<div
              class="tour-cutout"
              style=${`top:${cutTop}px;left:${rect.left - 6}px;width:${rect.width + 12}px;height:${cutHeight}px`}
            ></div>`
          : html`<div class="tour-dim"></div>`
      }
      ${
        // no card until the target is found and measured: an unresolved step
        // must skip invisibly, never flash a card and yank it away mid-read
        rect &&
        html`<div
          class="tour-card ${placement.cls}"
          style=${placement.style}
          tabindex="-1"
          ref=${cardRef}
        >
          <div class="tour-dots num" aria-hidden="true">${step + 1} / ${TOUR_STEPS.length}</div>
          <div class="tour-title">${s.title}</div>
          <div class="tour-text">${s.text}</div>
          <div class="tour-btns">
            <button class="secondary endbtn" onClick=${() => onEnd("bailed", step + 1)}>
              END TOUR
            </button>
            ${step > 0 && html`<button class="secondary" onClick=${() => go(step - 1, -1)}>BACK</button>`}
            <button class="primary" onClick=${() => go(step + 1, 1)}>
              ${step === TOUR_STEPS.length - 1 ? "DONE" : "NEXT"}
            </button>
          </div>
        </div>`
      }
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
    <div class="tour-offer" role="region" aria-label="Tour offer">
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
