// The invite QR encoder (P3, 2026-11-09). Byte mode, ECC level M, versions
// 1 to 10. Decoded end to end with an independent decoder (jsQR 1.4.0, outside
// the repo, rule 5) on 34 strings from 1 to 212 bytes on 11/9; these tests
// pin the parts a decoder needs first: size, finders, timing, format bits.
import test from "node:test";
import assert from "node:assert/strict";
import { qrEncode, qrSvgPath } from "../app/lib/qr.js";

const LINK =
  "https://janniksin.github.io/mise/#/join?code=ABCDEFGHJKLMNPQRSTUVWXYZ23456789&as=member";

/** the 8 legal level-M format words (mask 0..7), BCH-coded and XOR-masked */
const FORMAT_M = Array.from({ length: 8 }, (_, mask) => {
  let rem = mask;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((mask << 10) | rem) ^ 0x5412;
});

test("an invite link fits, as a square of the right size for its version", () => {
  const m = qrEncode(LINK);
  assert.ok(m);
  const ver = (m.length - 17) / 4;
  assert.ok(Number.isInteger(ver) && ver >= 1 && ver <= 10, `version ${ver}`);
  for (const row of m) assert.equal(row.length, m.length);
});

test("versions grow with the text, and too long a text is refused, not truncated", () => {
  assert.equal(qrEncode("a")?.length, 21);
  assert.equal(qrEncode("x".repeat(213))?.length, 57);
  assert.equal(qrEncode("x".repeat(214)), null);
});

test("finder patterns, timing lines and the dark module sit where a reader looks", () => {
  const m = /** @type {boolean[][]} */ (qrEncode(LINK));
  const n = m.length;
  for (const [cx, cy] of [
    [3, 3],
    [n - 4, 3],
    [3, n - 4],
  ]) {
    assert.equal(m[cy][cx], true, "finder centre");
    assert.equal(m[cy][cx + 2], false, "finder light ring");
    assert.equal(m[cy][cx + 3], true, "finder outer ring");
  }
  for (let i = 8; i < n - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0, `row timing ${i}`);
    assert.equal(m[i][6], i % 2 === 0, `column timing ${i}`);
  }
  assert.equal(m[n - 8][8], true, "dark module");
});

test("both copies of the format word agree and are a legal level-M word", () => {
  for (const text of ["a", LINK, "y".repeat(150)]) {
    const m = /** @type {boolean[][]} */ (qrEncode(text));
    const n = m.length;
    const b = (/** @type {boolean} */ x) => (x ? 1 : 0);
    let a = 0;
    let c = 0;
    // copy 1, bits 0..14 (around the top-left finder)
    const first = [
      ...[0, 1, 2, 3, 4, 5].map((i) => m[i][8]),
      m[7][8],
      m[8][8],
      m[8][7],
      ...[9, 10, 11, 12, 13, 14].map((i) => m[8][14 - i]),
    ];
    // copy 2, bits 0..14 (split between the other two finders)
    const second = [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => m[8][n - 1 - i]),
      ...[8, 9, 10, 11, 12, 13, 14].map((i) => m[n - 15 + i][8]),
    ];
    first.forEach((v, i) => (a |= b(v) << i));
    second.forEach((v, i) => (c |= b(v) << i));
    assert.equal(a, c, `copies agree for ${text.length} bytes`);
    assert.ok(FORMAT_M.includes(a), `legal format word for ${text.length} bytes`);
  }
});

test("the SVG path draws one square per dark module inside a four-module quiet zone", () => {
  const m = /** @type {boolean[][]} */ (qrEncode("a"));
  const { d, view } = qrSvgPath(m);
  assert.equal(view, 29);
  const dark = m.flat().filter(Boolean).length;
  assert.equal(d.split("M").length - 1, dark);
  assert.match(d, /^M4 4h1v1h-1z/);
});
