import test from "node:test";
import assert from "node:assert/strict";
import { keepAwake } from "../app/lib/awake.js";

/** Minimal DOM/navigator stand-ins. keepAwake talks to document.visibilityState,
 *  document event listeners, navigator.wakeLock, and (since 2026-08-24) a video
 *  element it creates itself as the fallback when no lock can be held.
 *
 *  `video` controls whether a DOM capable of making one exists at all:
 *    false      no DOM, the fallback cannot exist (node, SSR)
 *    "plays"    a video element whose play() works
 *    "blocked"  a video element whose play() is refused, e.g. autoplay policy
 */
function stub({ supported = true, fail = null, video = false } = {}) {
  const listeners = new Map();
  let requests = 0;
  const sentinels = [];
  /** @type {any[]} */
  const made = [];
  const doc = {
    visibilityState: "visible",
    addEventListener: (/** @type {string} */ k, /** @type {any} */ fn) => listeners.set(k, fn),
    removeEventListener: (/** @type {string} */ k) => listeners.delete(k),
  };
  if (video) {
    const el = {
      tagName: "VIDEO",
      paused: true,
      attrs: /** @type {Record<string,string>} */ ({}),
      style: { cssText: "" },
      removed: false,
      loaded: 0,
      setAttribute(/** @type {string} */ k, /** @type {string} */ v) {
        this.attrs[k] = v;
      },
      removeAttribute(/** @type {string} */ k) {
        delete this.attrs[k];
      },
      async play() {
        if (video === "blocked") throw new Error("NotAllowedError");
        this.paused = false;
      },
      pause() {
        this.paused = true;
      },
      load() {
        this.loaded++;
      },
      remove() {
        this.removed = true;
      },
    };
    made.push(el);
    // @ts-expect-error minimal stand-in
    doc.createElement = () => el;
    // @ts-expect-error minimal stand-in
    doc.body = { appendChild: () => {} };
  }
  const nav = supported
    ? {
        wakeLock: {
          request: async () => {
            requests++;
            if (fail) throw new Error(fail);
            const s = {
              released: false,
              /** @type {null | (() => void)} */
              onRelease: null,
              release: async () => {
                s.released = true;
              },
              addEventListener: (/** @type {string} */ k, /** @type {any} */ fn) => {
                if (k === "release") s.onRelease = fn;
              },
            };
            sentinels.push(s);
            return s;
          },
        },
      }
    : {};
  const prevDoc = globalThis.document;
  const prevNav = globalThis.navigator;
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });
  return {
    doc,
    sentinels,
    video: () => made[0],
    /** The OS taking the lock away mid-cook, which is what Low Power Mode does. */
    revoke: () => {
      const s = sentinels.at(-1);
      if (!s) return;
      s.released = true;
      s.onRelease?.();
    },
    count: () => requests,
    fire: (/** @type {string} */ k) => listeners.get(k)?.(),
    restore: () => {
      Object.defineProperty(globalThis, "document", { value: prevDoc, configurable: true });
      Object.defineProperty(globalThis, "navigator", { value: prevNav, configurable: true });
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("keepAwake acquires a lock and reports that it is held", async () => {
  const env = stub();
  try {
    /** @type {any[]} */
    const seen = [];
    const release = keepAwake((s) => seen.push(s));
    await settle();
    assert.equal(env.count(), 1);
    assert.equal(seen.at(-1).held, true);
    release();
    assert.equal(env.sentinels[0].released, true);
  } finally {
    env.restore();
  }
});

test("keepAwake RE-ACQUIRES when the app is looked at again", async () => {
  // this is the bug the whole file exists for: the browser drops the lock the
  // moment the page is hidden, and a released sentinel can never be reused, so
  // without this the screen sleeps two minutes after the first glance away
  const env = stub();
  try {
    const release = keepAwake();
    await settle();
    assert.equal(env.count(), 1);

    // away: the browser releases on its own, then back
    env.doc.visibilityState = "hidden";
    env.sentinels[0].released = true;
    env.fire("visibilitychange");
    await settle();
    assert.equal(env.count(), 1, "must not request a lock while hidden");

    env.doc.visibilityState = "visible";
    env.fire("visibilitychange");
    await settle();
    assert.equal(env.count(), 2, "coming back must take a fresh lock");
    release();
  } finally {
    env.restore();
  }
});

test("keepAwake does not stack locks while one is already held", async () => {
  const env = stub();
  try {
    const release = keepAwake();
    await settle();
    env.fire("visibilitychange");
    env.fire("visibilitychange");
    await settle();
    assert.equal(env.count(), 1);
    release();
  } finally {
    env.restore();
  }
});

test("no lock and no video at all still says what to do by hand", async () => {
  const env = stub({ supported: false, video: false });
  try {
    /** @type {any[]} */
    const seen = [];
    keepAwake((s) => seen.push(s));
    await settle();
    assert.equal(seen.at(-1).supported, false);
    assert.equal(seen.at(-1).held, false);
    assert.equal(seen.at(-1).via, "none");
    // silence is what failed him last time: it has to name what to do instead
    assert.match(seen.at(-1).reason, /Auto-Lock/);
  } finally {
    env.restore();
  }
});

test("a refused lock falls through to the silent video, which is the real fix", async () => {
  // This is David's actual symptom: iOS Low Power Mode refuses the lock. The
  // whole point of 2026-08-24 is that refusal is survivable, not fatal.
  const env = stub({ fail: "NotAllowedError", video: "plays" });
  try {
    /** @type {any[]} */
    const seen = [];
    keepAwake((s) => seen.push(s));
    await settle();
    assert.equal(seen.at(-1).held, true, "the screen is still being held");
    assert.equal(seen.at(-1).via, "video");
    assert.equal(seen.at(-1).reason, "");
    assert.equal(env.video().paused, false, "frames must actually be running");
  } finally {
    env.restore();
  }
});

test("an unsupported browser falls through to the video too", async () => {
  const env = stub({ supported: false, video: "plays" });
  try {
    /** @type {any[]} */
    const seen = [];
    keepAwake((s) => seen.push(s));
    await settle();
    assert.equal(seen.at(-1).held, true);
    assert.equal(seen.at(-1).via, "video");
    assert.equal(seen.at(-1).supported, false, "the LOCK is still unsupported");
  } finally {
    env.restore();
  }
});

test("a video the OS refuses to play is reported as not held, never as a lie", async () => {
  const env = stub({ fail: "NotAllowedError", video: "blocked" });
  try {
    /** @type {any[]} */
    const seen = [];
    keepAwake((s) => seen.push(s));
    await settle();
    assert.equal(seen.at(-1).held, false);
    assert.equal(seen.at(-1).via, "none");
    assert.match(seen.at(-1).reason, /Auto-Lock/);
  } finally {
    env.restore();
  }
});

test("the fallback video cannot be seen, tapped, focused, or cast", async () => {
  const env = stub({ fail: "NotAllowedError", video: "plays" });
  try {
    keepAwake();
    await settle();
    const v = env.video();
    assert.equal(v.muted, true, "an unmuted video would seize the audio session");
    assert.equal(v.loop, true);
    assert.equal(v.playsInline, true, "without this iOS goes fullscreen mid-cook");
    assert.equal(v.controls, false);
    assert.equal(v.tabIndex, -1);
    assert.equal(v.attrs["aria-hidden"], "true");
    assert.ok("disableremoteplayback" in v.attrs, "must not offer itself to AirPlay");
    assert.match(v.style.cssText, /opacity:0/);
    assert.match(v.style.cssText, /pointer-events:none/);
    assert.match(v.style.cssText, /position:fixed/);
    // display:none and visibility:hidden both STOP playback, which would
    // silently defeat the entire mechanism. They must never appear here.
    assert.doesNotMatch(v.style.cssText, /display:\s*none/);
    assert.doesNotMatch(v.style.cssText, /visibility:\s*hidden/);
  } finally {
    env.restore();
  }
});

test("when the OS revokes the lock mid-cook, the video picks it up", async () => {
  const env = stub({ video: "plays" });
  try {
    /** @type {any[]} */
    const seen = [];
    keepAwake((s) => seen.push(s));
    await settle();
    assert.equal(seen.at(-1).via, "lock", "starts on the cheap path");
    assert.equal(env.video().paused, true, "no decoder runs while the lock holds");
    // Low Power Mode kicks in and the OS takes the lock away.
    env.revoke();
    await settle();
    assert.equal(seen.at(-1).held, true, "the screen must not go dark");
    assert.equal(seen.at(-1).via, "video");
  } finally {
    env.restore();
  }
});

test("release tears the video down as well as the lock", async () => {
  const env = stub({ fail: "NotAllowedError", video: "plays" });
  try {
    const release = keepAwake();
    await settle();
    assert.equal(env.video().paused, false);
    release();
    assert.equal(env.video().paused, true, "a released keeper must stop decoding");
    assert.equal(env.video().removed, true, "and must not leave an element behind");
  } finally {
    env.restore();
  }
});

test("release stops everything and unhooks the listener", async () => {
  const env = stub();
  try {
    const release = keepAwake();
    await settle();
    release();
    env.fire("visibilitychange");
    await settle();
    assert.equal(env.count(), 1, "a released keeper must never re-acquire");
  } finally {
    env.restore();
  }
});
