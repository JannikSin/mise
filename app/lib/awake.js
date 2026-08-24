// Keeping the screen on, properly (David, 2026-07-27: "nothing is worse than
// being mid cooking with egg all over hands and having to look at the phone
// for the next time-critical step and realising it went to sleep").
//
// CORRECTION, 2026-08-24. This file used to claim "this is what Netflix does
// too: there is a real browser API for it, the Screen Wake Lock API, and a
// video player holds one the whole time it plays." THAT IS FALSE, and it was
// the reason the screen still went dark on him.
//
// Netflix does not hold a wake lock. Netflix PLAYS VIDEO. Video playback keeps
// the screen alive through a completely separate and much stronger OS path,
// and the two do not fail together:
//
//   * The Screen Wake Lock API is a request the OS may refuse or revoke. iOS
//     Low Power Mode refuses it. That is exactly David's symptom: Netflix
//     never dims, Mise dimmed, and it dimmed hardest in Low Power Mode.
//   * Playing video is not a request. While a video element is actually
//     playing frames, the screen stays lit, INCLUDING in Low Power Mode.
//
// So this module now does both, in that order of preference:
//
//   1. Ask for a real wake lock. When granted it is free: no decoder running,
//      no battery cost beyond the screen itself. Re-acquired on every return
//      to visibility, because the browser drops it when the page is hidden and
//      never gives it back on its own.
//   2. If the lock is refused, or the OS revokes it mid-cook, fall back to a
//      silent looping video. Only then. There is no point spinning a decoder
//      on a machine where step 1 already works.
//
// The video is 16x16, three frames, black, 1.5 KB, inlined as a data URI so it
// works with no signal (CLAUDE.md rule 3, offline-first). It is generated with
// ffmpeg as H.264 Constrained Baseline / level 3.0 / yuv420p, which is the
// most conservative profile iOS accepts.
//
// It has NO AUDIO STREAM AT ALL. Not a silent audio track, none. This is the
// property that makes it safe to run while he is listening to something: a
// video carrying audio would take the audio session and pause his music. One
// with no audio track cannot, and it also keeps it out of the lock screen and
// AirPlay UI.
//
// Known platform floor, worth writing down because it is not our bug: in an
// installed home-screen PWA, WebKit had a long-standing defect that broke the
// wake lock API entirely (bugs.webkit.org 254545), fixed in iOS 18.4. Below
// that the lock cannot be held no matter what this file does, which is now
// survivable rather than fatal, because the video path does not care.

/**
 * @typedef {{ held: boolean, supported: boolean, reason: string, via: "lock" | "video" | "none" }} AwakeState
 */

// 16x16 black, 3 frames, H.264 Constrained Baseline, yuv420p, no audio stream.
const TINY_MP4 =
  "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMubW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAC7gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAll0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAC7gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAu4AAAAAAABAAAAAAHRbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAwABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABfG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAATxzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMCBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAe/+EAFmdCwB7ZHsBEAAADAAQAAAMACDxYuSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAAbwAAAAAAAAABhzdHRzAAAAAAAAAAEAAAADAABAAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAADAAAAAQAAACBzdHN6AAAAAAAAAAAAAAADAAAChgAAAAoAAAAKAAAAFHN0Y28AAAAAAAAAAQAAA14AAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYzLjEuMTAwAAAACGZyZWUAAAKibWRhdAAAAnAGBf//bNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjMgMDQ4MGNiMCAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAOZYiEBf///w9FAAFXn4AAAAAGQZo4C3qAAAAABkGaVAK+oA==";

/**
 * The video fallback. Only constructed when a real wake lock is unavailable.
 *
 * Everything here is defensive about NOT being noticed:
 *   - 16x16 at opacity 0, fixed to the bottom-left corner, so it occupies no
 *     layout and paints nothing visible. It is deliberately NOT display:none
 *     or visibility:hidden, because both of those stop playback in WebKit and
 *     Blink, which would silently defeat the entire mechanism.
 *   - pointer-events none so it can never eat a tap meant for a step.
 *   - aria-hidden and tabIndex -1 so it is not announced and not focusable.
 *   - disableRemotePlayback so it does not appear as an AirPlay target.
 *   - muted set as BOTH attribute and property before play(), which is what
 *     the autoplay policies actually check.
 */
function makeVideoHolder() {
  /** @type {HTMLVideoElement | null} */
  let el = null;
  let wanted = false;

  // No DOM at all (tests, SSR, a worker). The fallback simply does not exist
  // there, and saying so is better than throwing inside a screen-wake helper.
  const canBuild = () =>
    typeof document !== "undefined" &&
    typeof document.createElement === "function" &&
    Boolean(document.body);

  const build = () => {
    if (el) return el;
    if (!canBuild()) return null;
    const v = document.createElement("video");
    v.src = TINY_MP4;
    v.loop = true;
    v.muted = true;
    v.defaultMuted = true;
    v.setAttribute("muted", "");
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");
    v.setAttribute("aria-hidden", "true");
    v.setAttribute("disableremoteplayback", "");
    v.tabIndex = -1;
    v.controls = false;
    v.preload = "auto";
    v.style.cssText =
      "position:fixed;left:0;bottom:0;width:16px;height:16px;opacity:0;" +
      "pointer-events:none;border:0;padding:0;margin:0;z-index:-1;";
    document.body.appendChild(v);
    el = v;
    return v;
  };

  return {
    /** @returns {Promise<boolean>} whether frames are actually running */
    async start() {
      wanted = true;
      const v = build();
      if (!v) return false;
      try {
        await v.play();
        // play() resolving is not proof on its own; a paused element means the
        // OS declined and we must not claim the screen is being held.
        return !v.paused;
      } catch {
        return false;
      }
    },
    stop() {
      wanted = false;
      if (!el) return;
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
        el.remove();
      } catch {
        /* teardown is best-effort */
      }
      el = null;
    },
    /** Browsers pause background media; resume when we come back. */
    async resumeIfWanted() {
      if (!wanted || !el) return false;
      if (!el.paused) return true;
      try {
        await el.play();
        return !el.paused;
      } catch {
        return false;
      }
    },
    get running() {
      return Boolean(el && !el.paused);
    },
  };
}

/**
 * Hold the screen awake until the returned function is called.
 *
 * `onState` is called whenever the truth changes, so the UI can show that the
 * screen is being held, say which mechanism is holding it, and admit when
 * nothing is.
 * @param {(state: AwakeState) => void} [onState]
 * @returns {() => void} release
 */
export function keepAwake(onState) {
  /** @type {any} */
  let sentinel = null;
  let stopped = false;
  let last = "";
  const nav = /** @type {any} */ (navigator);
  const lockSupported = Boolean(nav && "wakeLock" in nav);
  const video = makeVideoHolder();

  /** @param {AwakeState} s */
  const report = (s) => {
    const key = `${s.held}|${s.via}|${s.reason}`;
    if (key === last) return; // never churn the UI with an unchanged truth
    last = key;
    if (onState) onState(s);
  };

  const lockHeld = () => Boolean(sentinel && !sentinel.released);

  /**
   * The video is the fallback, so it runs only when the lock is not held.
   * If the lock comes back, the decoder is shut down again.
   */
  const reconcile = async () => {
    if (stopped) return;
    if (lockHeld()) {
      video.stop();
      report({ held: true, supported: true, reason: "", via: "lock" });
      return;
    }
    const running = video.running ? await video.resumeIfWanted() : await video.start();
    if (running) {
      report({
        held: true,
        supported: lockSupported,
        reason: "",
        via: "video",
      });
    } else {
      report({
        held: false,
        supported: lockSupported,
        reason:
          "this phone would not let the screen be held. Set Auto-Lock to Never while you cook: Settings, Display & Brightness, Auto-Lock.",
        via: "none",
      });
    }
  };

  const acquireLock = async () => {
    if (stopped || document.visibilityState !== "visible") return;
    if (lockHeld()) return;
    if (!lockSupported) return;
    try {
      sentinel = await nav.wakeLock.request("screen");
      // The OS can revoke it at any time: Low Power Mode, low battery, policy.
      // When it does, this is the signal to bring the video up.
      sentinel.addEventListener?.("release", () => {
        if (!stopped) void reconcile();
      });
    } catch {
      sentinel = null; // refused; reconcile() will fall through to the video
    }
  };

  const onVisible = () => {
    if (document.visibilityState === "visible") {
      void acquireLock().then(reconcile);
    }
  };

  // A rejected autoplay can often be started by any later user gesture, so
  // take the next tap as a free retry. Once holding, these unbind themselves.
  const onGesture = () => {
    if (stopped) return;
    void reconcile();
  };

  document.addEventListener("visibilitychange", onVisible);
  document.addEventListener("pointerdown", onGesture, { passive: true });

  void acquireLock().then(reconcile);

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("pointerdown", onGesture);
    video.stop();
    if (sentinel) {
      sentinel.release?.().catch(() => {});
      sentinel = null;
    }
  };
}
