// Pointer-Events drag-and-drop, ported from the Task 0 spike that passed on
// David's iPhone (INSTANT drag — no hold delay). HTML5 drag API is never used
// (it doesn't fire on iOS Safari).
//
// Sources carry data-drag (CSS should give them touch-action none/pan-x);
// targets carry data-drop. A ghost clone follows the pointer after a small
// slop, targets highlight via .drop-over, drops snap FLIP-style, and the
// page auto-scrolls at the viewport edges (the ghost is position:fixed, so
// scrolling moves the page under it).

const SLOP = 6;
const EDGE = 76;
const SCROLL_SPEED = 10;

/**
 * @param {HTMLElement} root
 * @param {(drag: DOMStringMap, drop: DOMStringMap) => void} onDrop
 * @returns {() => void} cleanup
 */
export function initDrag(root, onDrop) {
  /** @type {null | {
   *   src: HTMLElement, ghost: HTMLElement | null, x0: number, y0: number,
   *   dx: number, dy: number, over: HTMLElement | null, raf: number, scrollDir: number
   * }} */
  let drag = null;

  /** @param {PointerEvent} e */
  const down = (e) => {
    if (!e.isPrimary || drag) return;
    const src = /** @type {HTMLElement | null} */ (
      /** @type {HTMLElement} */ (e.target).closest("[data-drag]")
    );
    if (!src) return;
    src.setPointerCapture(e.pointerId);
    drag = {
      src,
      ghost: null,
      x0: e.clientX,
      y0: e.clientY,
      dx: 0,
      dy: 0,
      over: null,
      raf: 0,
      scrollDir: 0,
    };
  };

  /** @param {PointerEvent} e */
  const move = (e) => {
    if (!drag) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < SLOP) return;
      lift(e);
    }
    const g = /** @type {HTMLElement} */ (drag.ghost);
    g.style.left = `${e.clientX - drag.dx}px`;
    g.style.top = `${e.clientY - drag.dy}px`;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = /** @type {HTMLElement | null} */ (under && under.closest("[data-drop]"));
    if (target !== drag.over) {
      if (drag.over) drag.over.classList.remove("drop-over");
      if (target) target.classList.add("drop-over");
      drag.over = target;
    }
    drag.scrollDir = e.clientY < EDGE ? -1 : e.clientY > innerHeight - EDGE - 70 ? 1 : 0;
    if (drag.scrollDir && !drag.raf) autoScroll();
  };

  /** @param {PointerEvent} e */
  const lift = (e) => {
    const d = /** @type {NonNullable<typeof drag>} */ (drag);
    const r = d.src.getBoundingClientRect();
    const ghost = /** @type {HTMLElement} */ (d.src.cloneNode(true));
    ghost.className = `${d.src.className} drag-ghost`;
    ghost.style.width = `${r.width}px`;
    ghost.style.left = `${r.left}px`;
    ghost.style.top = `${r.top}px`;
    document.body.appendChild(ghost);
    d.ghost = ghost;
    d.dx = e.clientX - r.left;
    d.dy = e.clientY - r.top;
    d.src.classList.add("drag-lifted");
  };

  const autoScroll = () => {
    if (!drag || !drag.scrollDir) {
      if (drag) drag.raf = 0;
      return;
    }
    scrollBy(0, drag.scrollDir * SCROLL_SPEED);
    drag.raf = requestAnimationFrame(autoScroll);
  };

  /** @param {PointerEvent} e */
  const up = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    d.src.classList.remove("drag-lifted");
    if (!d.ghost) return;
    if (d.over && e.type !== "pointercancel") {
      d.over.classList.remove("drop-over");
      settleGhost(d.ghost, d.over.getBoundingClientRect());
      onDrop(d.src.dataset, d.over.dataset);
    } else {
      if (d.over) d.over.classList.remove("drop-over");
      settleGhost(d.ghost, d.src.getBoundingClientRect());
    }
  };

  /** Abort an in-flight drag (view unmounting mid-gesture): no orphaned
   *  ghost, no lingering rAF auto-scroll loop, no stuck classes. */
  const abort = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    d.src.classList.remove("drag-lifted");
    if (d.over) d.over.classList.remove("drop-over");
    if (d.ghost) d.ghost.remove();
  };

  /**
   * @param {HTMLElement} ghost
   * @param {DOMRect} to
   */
  const settleGhost = (ghost, to) => {
    ghost.classList.add("drag-snapping");
    ghost.style.left = `${to.left}px`;
    ghost.style.top = `${to.top}px`;
    ghost.style.opacity = "0";
    setTimeout(() => ghost.remove(), 180);
  };

  root.addEventListener("pointerdown", down);
  root.addEventListener("pointermove", move);
  root.addEventListener("pointerup", up);
  root.addEventListener("pointercancel", up);
  return () => {
    abort();
    root.removeEventListener("pointerdown", down);
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerup", up);
    root.removeEventListener("pointercancel", up);
  };
}
