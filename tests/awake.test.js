import test from "node:test";
import assert from "node:assert/strict";
import { keepAwake } from "../app/lib/awake.js";

/** Minimal DOM/navigator stand-ins: keepAwake talks to exactly three things,
 *  document.visibilityState, document event listeners, and navigator.wakeLock. */
function stub({ supported = true, fail = null } = {}) {
  const listeners = new Map();
  let requests = 0;
  const sentinels = [];
  const doc = {
    visibilityState: "visible",
    addEventListener: (/** @type {string} */ k, /** @type {any} */ fn) => listeners.set(k, fn),
    removeEventListener: (/** @type {string} */ k) => listeners.delete(k),
  };
  const nav = supported
    ? {
        wakeLock: {
          request: async () => {
            requests++;
            if (fail) throw new Error(fail);
            const s = {
              released: false,
              release: async () => {
                s.released = true;
              },
              addEventListener: () => {},
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

test("an unsupported browser says so, with the manual fix", async () => {
  const env = stub({ supported: false });
  try {
    /** @type {any[]} */
    const seen = [];
    keepAwake((s) => seen.push(s));
    await settle();
    assert.equal(seen.at(-1).supported, false);
    assert.equal(seen.at(-1).held, false);
    // silence is what failed him last time: it has to name what to do instead
    assert.match(seen.at(-1).reason, /Auto-Lock/);
  } finally {
    env.restore();
  }
});

test("a refused lock reports the reason instead of failing silently", async () => {
  const env = stub({ fail: "NotAllowedError" });
  try {
    /** @type {any[]} */
    const seen = [];
    keepAwake((s) => seen.push(s));
    await settle();
    assert.equal(seen.at(-1).held, false);
    assert.equal(seen.at(-1).supported, true);
    assert.ok(seen.at(-1).reason.length > 0);
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
