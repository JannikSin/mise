// THE WALK'S OWN NARRATION (P6, David 2026-10-18: "show everything and also
// narrate everything"): the pure audio steps between the phone's decoder and
// the Worker's transcriber.
import test from "node:test";
import assert from "node:assert/strict";
import {
  downmixToMono,
  resampleLinear,
  encodeWav16,
  narrationWav,
  NARRATION_MAX_SECONDS,
  NARRATION_RATE,
} from "../app/lib/scan.js";

const sine = (/** @type {number} */ rate, /** @type {number} */ seconds, freq = 440, amp = 0.5) => {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
};
const buffer = (/** @type {Float32Array[]} */ chans, /** @type {number} */ rate) => ({
  sampleRate: rate,
  numberOfChannels: chans.length,
  length: chans[0]?.length ?? 0,
  getChannelData: (/** @type {number} */ i) => /** @type {Float32Array} */ (chans[i]),
});

test("two channels average into one", () => {
  const out = downmixToMono([Float32Array.from([1, 0.5]), Float32Array.from([0, -0.5])]);
  assert.deepEqual([...out], [0.5, 0]);
  assert.equal(downmixToMono([]).length, 0);
});

test("resampling 48 kHz to 16 kHz keeps the length in time and the tone", () => {
  const src = sine(48000, 1);
  const out = resampleLinear(src, 48000);
  assert.equal(out.length, 16000, "one second stays one second");
  // a 440 Hz tone at 16 kHz still crosses zero about 880 times a second
  let crossings = 0;
  for (let i = 1; i < out.length; i++) if ((out[i - 1] ?? 0) < 0 !== (out[i] ?? 0) < 0) crossings++;
  assert.ok(Math.abs(crossings - 880) < 10, `${crossings} zero crossings`);
});

test("the WAV is PCM16 mono at 16 kHz with a correct header", () => {
  const wav = encodeWav16(Float32Array.from([0, 1, -1, 2]));
  const v = new DataView(wav.buffer);
  const text = (/** @type {number} */ at) => String.fromCharCode(...wav.slice(at, at + 4));
  assert.equal(text(0), "RIFF");
  assert.equal(text(8), "WAVE");
  assert.equal(v.getUint16(22, true), 1, "mono");
  assert.equal(v.getUint32(24, true), NARRATION_RATE);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 8, "4 samples, 2 bytes each");
  assert.equal(v.getInt16(46, true), 0x7fff);
  assert.equal(v.getInt16(48, true), -0x8000);
  assert.equal(v.getInt16(50, true), 0x7fff, "clipped to 1");
  assert.equal(wav.length, 44 + 8);
});

test("a narration longer than the cap is trimmed and says so; silence is no narration", () => {
  const long = narrationWav(buffer([sine(8000, NARRATION_MAX_SECONDS + 5)], 8000));
  assert.ok("wav" in long && long.trimmed, "trimmed past the cap");
  assert.equal(/** @type {any} */ (long).wav.length, 44 + NARRATION_MAX_SECONDS * NARRATION_RATE * 2);
  const short = narrationWav(buffer([sine(44100, 2), sine(44100, 2)], 44100));
  assert.ok("wav" in short && !short.trimmed);
  assert.deepEqual(narrationWav(buffer([new Float32Array(16000)], 16000)), { reason: "no-audio" });
  assert.deepEqual(narrationWav(/** @type {any} */ ({ numberOfChannels: 0, length: 0, sampleRate: 0 })), { reason: "no-audio" });
});
