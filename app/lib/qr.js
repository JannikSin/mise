// QR CODE for the invite link (P3, David 2026-11-09: a QR on the invite
// screen "makes it nicer"). Self-contained on purpose: repo rule 5 bars a new
// dependency without his approval, and an invite link needs only the small
// part of the standard: byte mode, error correction level M, versions 1 to
// 10 (up to 213 bytes; an invite link is about 90). The algorithm follows
// the QR Code Model 2 specification (ISO/IEC 18004) as laid out in Project
// Nayuki's reference encoder (MIT). Pure: text in, a square of booleans out.

/** ECC level M, versions 1..10: error correction codewords per block */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
/** ECC level M, versions 1..10: number of blocks */
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;

/**
 * Modules available for data and ECC in a version (everything but the
 * function patterns), in bits.
 * @param {number} ver
 * @returns {number}
 */
function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

/** @param {number} ver */
const dataCodewords = (ver) =>
  Math.floor(rawDataModules(ver) / 8) - (ECC_PER_BLOCK[ver] ?? 0) * (NUM_BLOCKS[ver] ?? 1);

/**
 * GF(256) multiply, modulus x^8 + x^4 + x^3 + x^2 + 1.
 * @param {number} x
 * @param {number} y
 */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** @param {number} degree */
function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

/**
 * @param {number[]} data
 * @param {number[]} divisor
 */
function rsRemainder(data, divisor) {
  const out = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ /** @type {number} */ (out.shift());
    out.push(0);
    for (let i = 0; i < out.length; i++) out[i] ^= gfMul(divisor[i] ?? 0, factor);
  }
  return out;
}

/** @param {number} ver */
function alignmentPositions(ver) {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const num = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < num; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** @type {((x: number, y: number) => boolean)[]} */
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * Scan-quality penalty of a finished grid (the specification's four rules).
 * @param {boolean[][]} m
 */
function penalty(m) {
  const size = m.length;
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(/** @type {boolean[]} */ (m[i]));
    lines.push(m.map((row) => Boolean(row[i])));
  }
  for (const line of lines) {
    // rule 1: runs of five or more of one colour
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    // rule 3: finder-like 1011101 with four light modules on either side
    const s = line.map((b) => (b ? "1" : "0")).join("");
    const padded = `0000${s}0000`;
    for (const pat of ["00001011101", "10111010000"]) {
      for (let i = padded.indexOf(pat); i !== -1; i = padded.indexOf(pat, i + 1)) score += 40;
    }
  }
  // rule 2: 2x2 blocks of one colour
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const r0 = /** @type {boolean[]} */ (m[y]);
      const r1 = /** @type {boolean[]} */ (m[y + 1]);
      const c = r0[x];
      if (c === r0[x + 1] && c === r1[x] && c === r1[x + 1]) score += 3;
    }
  }
  // rule 4: dark share away from half
  const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * Encode text (UTF-8, byte mode, ECC level M) as a QR code.
 * @param {string} text
 * @returns {boolean[][] | null} modules[y][x], true = dark; null when the
 *   text is longer than version 10 holds
 */
export function qrEncode(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  for (; ver <= MAX_VERSION; ver++) {
    const ccBits = ver < 10 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > MAX_VERSION) return null;
  const size = ver * 4 + 17;
  const capBits = dataCodewords(ver) * 8;

  // the bit stream: mode, count, bytes, terminator, padding
  /** @type {number[]} */
  const bits = [];
  const put = (/** @type {number} */ val, /** @type {number} */ len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  /** @type {number[]} */
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }

  // split into blocks, add ECC, interleave
  const numBlocks = NUM_BLOCKS[ver] ?? 1;
  const eccLen = ECC_PER_BLOCK[ver] ?? 0;
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  /** @type {number[][]} */
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  /** @type {number[]} */
  const codewords = [];
  for (let i = 0; i < (blocks[0]?.length ?? 0); i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortLen - eccLen || j >= numShort) codewords.push(blocks[j]?.[i] ?? 0);
    }
  }

  // function patterns
  /** @type {boolean[][]} */
  const mods = Array.from({ length: size }, () => new Array(size).fill(false));
  /** @type {boolean[][]} */
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (/** @type {number} */ x, /** @type {number} */ y, /** @type {boolean} */ d) => {
    /** @type {boolean[]} */ (mods[y])[x] = d;
    /** @type {boolean[]} */ (fn[y])[x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of /** @type {[number, number][]} */ ([
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ])) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const al = alignmentPositions(ver);
  for (let i = 0; i < al.length; i++) {
    for (let j = 0; j < al.length; j++) {
      const last = al.length - 1;
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set((al[i] ?? 0) + dx, (al[j] ?? 0) + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  const drawFormat = (/** @type {number} */ mask) => {
    const d = mask; // ECC level M = 0b00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412;
    const bit = (/** @type {number} */ i) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0); // reserves the format areas before the data is placed
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const d = ((v >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, d);
      set(b, a, d);
    }
  }

  // the data, in the zigzag
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        const row = /** @type {boolean[]} */ (mods[y]);
        if (!(/** @type {boolean[]} */ (fn[y])[x]) && n < codewords.length * 8) {
          row[x] = (((codewords[n >>> 3] ?? 0) >>> (7 - (n & 7))) & 1) === 1;
          n++;
        }
      }
    }
  }

  // the mask with the lowest penalty
  /** @type {boolean[][] | null} */
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const saved = mods.map((row) => [...row]);
    const flip = /** @type {(x: number, y: number) => boolean} */ (MASKS[mask]);
    mods.forEach((row, y) => {
      const fnRow = /** @type {boolean[]} */ (fn[y]);
      for (let x = 0; x < size; x++) if (!fnRow[x] && flip(x, y)) row[x] = !row[x];
    });
    drawFormat(mask);
    const score = penalty(mods);
    if (score < bestScore) {
      bestScore = score;
      best = mods.map((row) => [...row]);
    }
    saved.forEach((row, y) => (mods[y] = row));
  }
  return best;
}

/**
 * The code as one SVG path ("M x y h1 v1 h-1 z" per dark module), with a
 * four-module quiet zone in the viewBox. Draw it with fill on a light ground.
 * @param {boolean[][]} modules
 * @returns {{ d: string, view: number }}
 */
export function qrSvgPath(modules) {
  /** @type {string[]} */
  const parts = [];
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    }),
  );
  return { d: parts.join(""), view: modules.length + 8 };
}
