// /transcribe, the walk's narration (P6, David 2026-10-18: "show everything
// and also narrate everything"), driven end to end through worker.fetch with
// GitHub auth stubbed and Workers AI stubbed as the env.AI binding.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { encodeWav16 } from "../app/lib/scan.js";
import { TRANSCRIBE_MAX_BYTES, wavBytesFrom } from "../worker/src/lib.js";

const ORIGIN = "https://janniksin.github.io";
const b64 = (/** @type {Uint8Array} */ u8) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const WAV = b64(encodeWav16(new Float32Array(1600).fill(0.2)));

function stubGithub() {
  const real = globalThis.fetch;
  // @ts-expect-error test stub
  globalThis.fetch = async (/** @type {any} */ input) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/repos/")) {
      return new Response(JSON.stringify({ private: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  return () => (globalThis.fetch = real);
}
const post = (/** @type {any} */ body, /** @type {any} */ env) =>
  worker.fetch(
    new Request("https://mise-worker.test/transcribe", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-mise-auth": "test-pat-transcribe" },
      body: JSON.stringify(body),
    }),
    env,
  );

test("a WAV narration comes back as text, and only text", async () => {
  const restore = stubGithub();
  try {
    /** @type {any[]} */
    const seen = [];
    const env = {
      AI: {
        run: async (/** @type {string} */ model, /** @type {any} */ input) => {
          seen.push({ model, n: input.audio.length });
          return { text: " a dozen eggs, half a gallon of milk ", words: [{ word: "a" }] };
        },
      },
    };
    const res = await post({ audio: WAV, mediaType: "audio/wav" }, env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "a dozen eggs, half a gallon of milk" });
    assert.equal(seen[0].model, "@cf/openai/whisper");
    assert.equal(seen[0].n, 44 + 1600 * 2, "the WAV bytes, header included");
  } finally {
    restore();
  }
});

test("no AI binding: 503 says transcription is not switched on yet", async () => {
  const restore = stubGithub();
  try {
    const res = await post({ audio: WAV, mediaType: "audio/wav" }, {});
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /not switched on yet/);
  } finally {
    restore();
  }
});

test("the wrong type, a non-WAV, or an oversize narration is refused before the model", async () => {
  const restore = stubGithub();
  try {
    let calls = 0;
    const env = { AI: { run: async () => (calls++, { text: "x" }) } };
    assert.equal((await post({ audio: WAV, mediaType: "audio/mpeg" }, env)).status, 400);
    assert.equal((await post({ audio: btoa("not a wave file at all, just text....................."), mediaType: "audio/wav" }, env)).status, 400);
    assert.equal(calls, 0, "the model is never asked");
  } finally {
    restore();
  }
  // the cap is checked on the size before decoding
  assert.equal(wavBytesFrom({ mediaType: "audio/wav", audio: "A".repeat(Math.ceil((TRANSCRIBE_MAX_BYTES * 4) / 3) + 100) }), "too-large");
});

// --- voice on paddington first (David, 2026-11-11) ---------------------------

function stubGithubAndMac(/** @type {(url: string, init: any) => Response | Promise<Response>} */ mac) {
  const real = globalThis.fetch;
  // @ts-expect-error test stub
  globalThis.fetch = async (/** @type {any} */ input, /** @type {any} */ init) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/repos/")) {
      return new Response(JSON.stringify({ private: true }), { status: 200 });
    }
    if (url.startsWith("https://mac.example/")) return mac(url, init);
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  return () => (globalThis.fetch = real);
}

test("with the Mac set, the narration is heard on the Mac and Workers AI is not called", async () => {
  /** @type {any[]} */ const macSeen = [];
  const restore = stubGithubAndMac((url, init) => {
    macSeen.push({ url, n: init.body.length });
    return new Response(JSON.stringify({ text: "two onions, a bag of rice" }), { status: 200 });
  });
  try {
    let cloud = 0;
    const env = { LOCAL_BASE_URL: "https://mac.example/v1", AI: { run: async () => (cloud++, { text: "x" }) } };
    const res = await post({ audio: WAV, mediaType: "audio/wav" }, env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "two onions, a bag of rice" });
    assert.equal(macSeen[0].url, "https://mac.example/v1/audio/transcriptions");
    assert.equal(macSeen[0].n, 44 + 1600 * 2);
    assert.equal(cloud, 0);
  } finally {
    restore();
  }
});

test("the Mac asleep: the narration falls back to Workers AI", async () => {
  const restore = stubGithubAndMac(() => {
    throw new Error("ECONNREFUSED");
  });
  try {
    const env = { LOCAL_BASE_URL: "https://mac.example/v1", AI: { run: async () => ({ text: "from cloudflare" }) } };
    const res = await post({ audio: WAV, mediaType: "audio/wav" }, env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "from cloudflare" });
  } finally {
    restore();
  }
});

test("Mac only, no AI binding: served by the Mac, and a Mac failure is a plain 502", async () => {
  let up = true;
  const restore = stubGithubAndMac(() =>
    up ? new Response(JSON.stringify({ text: "milk" }), { status: 200 }) : new Response("{}", { status: 503 }),
  );
  try {
    const env = { LOCAL_BASE_URL: "https://mac.example/v1" };
    assert.deepEqual(await (await post({ audio: WAV, mediaType: "audio/wav" }, env)).json(), { text: "milk" });
    up = false;
    const res = await post({ audio: WAV, mediaType: "audio/wav" }, env);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /could not hear/);
  } finally {
    restore();
  }
});
