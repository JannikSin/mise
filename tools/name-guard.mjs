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
// A TERM is folded the same way, then split into words (termWords): a name
// with an accent, a space, an apostrophe or a hyphen matches its own text,
// and a term that is not plain a to z after folding is refused (TermError).
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
  // Latin letters NFKD does not decompose (fix loop 2 C1: eszett is "ss",
  // and ae, oe, thorn and eth join the map)
  ı: "i", ł: "l", Ł: "l", ø: "o", Ø: "o", đ: "d", Đ: "d", ß: "ss", ẞ: "ss",
  æ: "ae", Æ: "ae", œ: "oe", Œ: "oe", þ: "th", Þ: "th", ð: "d", Ð: "d",
});

// fix loop 2 N3: every combining block, the bidi controls (LRM, RLM,
// embeddings, isolates), invisible operators, variation selectors and tag
// characters too; the SQL twin drops the same set.
// The class lists combining RANGES to delete, not a combined character.
// eslint-disable-next-line no-misleading-character-class
const DROP = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u180e\ufe00-\ufe0f\ufeff\u00ad\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
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

/**
 * A term that cannot become plain words after folding. The message never
 * carries the term (the caller names the field).
 */
export class TermError extends Error {
  constructor() {
    super("a guard term or name is not plain letters a to z after folding");
    this.name = "TermError";
  }
}

// What separates the words of one name, after folding: white space,
// apostrophes (straight, curly, modifier, grave, acute, prime), hyphens and
// dashes of every width, and the period of an initial.
const NAME_SEP = /[\s'\u2018\u2019\u201b\u02bc\u02b9`\u00b4\u2032\-\u2010-\u2015\u2212.]+/;
// Name particles dropped as a word of their own inside a longer name (they
// stay in the joined form): "de" or "van" alone would hit ordinary text.
const PARTICLES = new Set(["da", "de", "del", "den", "der", "di", "do", "dos", "das", "du", "el", "la", "le", "van", "von", "st"]);

/**
 * The words the guard looks for, for one term or name (fix loop 2 C1): folded
 * exactly as the text is folded, split into words at spaces, apostrophes and
 * hyphens, each word of 2 or more letters, plus the words joined ("Mary Ann"
 * gives mary, ann and maryann; "O'Brien" gives brien and obrien). Throws
 * TermError when anything other than a to z is left after folding (a digit, a
 * symbol, a letter of another script), or nothing usable is.
 * @param {string} term @returns {string[]}
 */
export function termWords(term) {
  const tokens = fold(term).split(NAME_SEP).filter(Boolean);
  if (!tokens.length || tokens.some((t) => !/^[a-z]+$/.test(t))) throw new TermError();
  const words = tokens.filter((t) => t.length >= 2 && !(tokens.length > 1 && PARTICLES.has(t)));
  if (tokens.length > 1) words.push(tokens.join(""));
  const out = [...new Set(words)];
  if (!out.length || out.some((w) => w.length > 40)) throw new TermError();
  return out;
}

/**
 * One pattern for one term or name; every word of termWords(term) is an
 * alternative. Throws TermError as termWords does.
 * @param {string} term
 */
export function termPattern(term) {
  return new RegExp(`(^|[^a-z0-9])(${termWords(term).join("|")})(s|es)?[0-9]*([^a-z0-9]|$)`, "g");
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
