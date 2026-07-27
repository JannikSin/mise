// Keeping the screen on, properly (David, 2026-07-27: "nothing is worse than
// being mid cooking with egg all over hands and having to look at the phone
// for the next time-critical step and realising it went to sleep").
//
// This is what Netflix does too: there is a real browser API for it, the
// Screen Wake Lock API, and a video player holds one the whole time it plays.
// Mise already used it in Cook mode and the core session, and it still let him
// down, because the previous implementation had three holes:
//
//   1. A wake lock is RELEASED AUTOMATICALLY the moment the page is hidden,
//      and a released sentinel can never be reused. Glance at a text, come
//      back, and the screen sleeps two minutes later with nothing holding it.
//      Nothing re-acquired it. This is the bug that actually bit him.
//   2. The RECIPE page held no lock at all. Only Cook mode did. Reading the
//      steps off the recipe is exactly when hands are covered in egg.
//   3. Every failure was silent. `.then(ok, () => {})` swallowed the rejection,
//      so a phone where this cannot work looked identical to one where it was
//      working perfectly.
//
// Known platform floor, worth writing down because it is not our bug and it
// IS his most likely one: in an installed home-screen PWA, WebKit had a
// long-standing defect that broke this API entirely (bugs.webkit.org 254545),
// fixed in iOS 18.4. Below that, an installed Mise cannot hold the screen no
// matter what this file does, so the honest move is to SAY SO rather than
// pretend. That is what `state.reason` is for.

/**
 * @typedef {{ held: boolean, supported: boolean, reason: string }} AwakeState
 */

/**
 * Hold the screen awake until the returned function is called.
 *
 * Re-acquires on every return to visibility, which is the whole point: the
 * browser drops the lock when you leave and will not give it back on its own.
 * `onState` is called whenever the truth changes, so the UI can show that the
 * screen is being held, and admit it when it is not.
 * @param {(state: AwakeState) => void} [onState]
 * @returns {() => void} release
 */
export function keepAwake(onState) {
  /** @type {any} */
  let sentinel = null;
  let stopped = false;
  const nav = /** @type {any} */ (navigator);
  const supported = Boolean(nav && "wakeLock" in nav);

  /** @param {AwakeState} s */
  const report = (s) => {
    if (onState) onState(s);
  };

  if (!supported) {
    report({
      held: false,
      supported: false,
      reason:
        "this phone's browser cannot hold the screen on. Set Auto-Lock to Never while you cook: Settings, Display & Brightness, Auto-Lock.",
    });
    return () => {};
  }

  const acquire = async () => {
    if (stopped || document.visibilityState !== "visible") return;
    if (sentinel && !sentinel.released) return;
    try {
      sentinel = await nav.wakeLock.request("screen");
      // the browser can drop it on its own (low battery, OS policy). When it
      // does, say so instead of showing a lie.
      sentinel.addEventListener?.("release", () => {
        if (!stopped) report({ held: false, supported: true, reason: "the phone released it" });
      });
      report({ held: true, supported: true, reason: "" });
    } catch (e) {
      // The usual causes are an installed PWA on iOS below 18.4, and a phone
      // in Low Power Mode. Both are outside our reach, so name the manual fix.
      report({
        held: false,
        supported: true,
        reason:
          e instanceof Error && /power/i.test(e.message)
            ? "Low Power Mode is blocking it. Turn Low Power Mode off, or set Auto-Lock to Never."
            : "the phone refused (iOS below 18.4 blocks this in installed apps). Set Auto-Lock to Never while you cook: Settings, Display & Brightness, Auto-Lock.",
      });
    }
  };

  const onVisible = () => {
    if (document.visibilityState === "visible") void acquire();
  };
  document.addEventListener("visibilitychange", onVisible);
  void acquire();

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisible);
    if (sentinel) {
      sentinel.release?.().catch(() => {});
      sentinel = null;
    }
  };
}
