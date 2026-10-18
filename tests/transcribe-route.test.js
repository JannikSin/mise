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
