// Mise 2.0 fix loop 1 (Red Team F1): the name guard's reading, in JS. The SQL
// twin is private.guard_fold / private.guard_text / private.guard_hit in
// supabase/migrations/20261031090000_fix1_guard_plates.sql, and
// tests/name-guard.test.js runs one corpus through both.
//
// The guard never reads serialized JSON (where a newline is the two characters
// backslash and n, which glued "\nName" into one word). It reads every decoded
// string value and every object key, plus each pair of adjacent strings in an
// array joined with nothing (a name split as ["Na", "me"]), plus the path with
// its owner segment removed. Each piece is folded: NFKD, combining marks and
// zero-width characters dropped, common Cyrillic and Greek lookalikes and a
// few Latin letters NFKD leaves alone mapped to ASCII, then lowercased. A term
// matches as a whole word with an optional plural (s, es) and trailing digits;
// a possessive needs no rule because the apostrophe is already a boundary.
//
// Public code, no names: the terms come from the database or people.local.json.

/** lookalike -> ASCII; the SQL translate() strings are this map, in order. */
export const LOOKALIKES = Object.freeze({
  // Cyrillic, lower then upper
  а: "a", в: "b", е: "e", і: "i", ј: "j", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s", ԁ: "d", ӏ: "l", ү: "y", һ: "h", ԛ: "q", ԝ: "w",
  А: "a", В: "b", Е: "e", І: "i", Ј: "j", К: "k", М: "m", Н: "h", О: "o", Р: "p", С: "c", Т: "t", У: "y", Х: "x", Ѕ: "s", Ү: "y", Һ: "h", Ӏ: "l",
  // Greek, lower then upper
  α: "a", β: "b", γ: "y", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w",
  Α: "a", Β: "b", Ε: "e", Ζ: "z", Η: "h", Ι: "i", Κ: "k", Μ: "m", Ν: "n", Ο: "o", Ρ: "p", Τ: "t", Υ: "y", Χ: "x",
  // Latin letters NFKD does not decompose
  ı: "i", ł: "l", Ł: "l", ø: "o", Ø: "o", đ: "d", Đ: "d", ß: "s",
});

const DROP = /[\u0300-\u036f\u200b-\u200d\u2060\ufeff\u00ad]/g;
const MAP = new Map(Object.entries(LOOKALIKES));

/** @param {string} s */
export function fold(s) {
  const x = String(s).normalize("NFKD").replace(DROP, "");
  let out = "";
  for (const c of x) out += MAP.get(c) ?? c;
  return out.toLowerCase();
}

/** The path the guard reads: the owner segment is an identity, not text. @param {string} p */
export function guardPath(p) {
  return String(p).replace(/^(profiles|households)\/[^/]+\//, "");
}

/**
 * Everything the guard reads in a value, folded, space separated.
 * @param {unknown} data @param {string | null} [extra] a path or an id
 */
export function guardText(data, extra = null) {
  /** @type {string[]} */
  const parts = extra == null ? [] : [String(extra)];
  /** @param {unknown} v */
  const walk = (v) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) {
      v.forEach((e, i) => {
        const n = v[i + 1];
        if (typeof e === "string" && typeof n === "string") parts.push(e + n);
        walk(e);
      });
    } else if (v && typeof v === "object") {
      for (const [k, e] of Object.entries(v)) {
        parts.push(k);
        walk(e);
      }
    }
  };
  walk(data);
  return fold(parts.join(" "));
}

/** @param {string} term */
export function termPattern(term) {
  return new RegExp(`(^|[^a-z0-9])${String(term).replace(/[^a-z0-9-]/g, "")}(s|es)?[0-9]*([^a-z0-9]|$)`, "g");
}

/**
 * How many times the terms appear, the same test as private.guard_hit.
 * @param {unknown} data @param {string[]} terms @param {string | null} [extra]
 */
export function guardHits(data, terms, extra = null) {
  const text = guardText(data, extra);
  let n = 0;
  for (const t of terms) n += (text.match(termPattern(t)) ?? []).length;
  return n;
}
