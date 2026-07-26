// Decoding supermarket till text, and scoring the trip against the list.
//
// David, 2026-07-26: "BLDMD ALMND 16OZ was a bag of almonds and you assumed it
// was almond milk." That is the whole problem in one line. Blue Diamond is
// famous for almond milk, so a model reading the abbreviation cold guesses
// milk. The fix he named himself is the right one: look at the list he was
// SUPPOSEDLY BUYING FOR. His list had almonds on it and no almond milk, so the
// answer was sitting there the whole time.
//
// So decoding runs in two passes. First expand the till's own shorthand, which
// is mechanical and shared across US chains. Then score what is left against
// the foods actually on this week's list, and if one of them clearly fits,
// take it. Guessing from the abbreviation alone is the last resort, never the
// first.

import { canonicalFood } from "./ingredients.js";

/**
 * Till shorthand seen on US grocery receipts. Chains differ in what they
 * abbreviate but not much in HOW: drop the vowels, cap at ~12 characters.
 * Brand tokens are listed so they can be stripped rather than mistaken for the
 * food, which is exactly the trap "BLDMD" set.
 * @type {[RegExp, string][]}
 */
const TILL_WORDS = [
  // brands: noise for identification, and actively misleading
  [/\bBLD?MD\b|\bBLUE ?DIAMOND\b/i, ""],
  [/\bKRGR\b|\bKROGER\b|\bTJ\b|\bGV\b|\bGRT ?VAL\b|\bSMPLY ?BAL\b|\bSB\b/i, ""],
  [/\bORG(ANIC)?\b|\bORGNC\b/i, "organic"],
  // foods
  [/\bALMN?DS?\b/i, "almonds"],
  [/\bWLNT?S?\b/i, "walnuts"],
  [/\bCSHW S?\b|\bCSHWS?\b/i, "cashews"],
  [/\bPNT\b|\bPNUT\b/i, "peanut"],
  [/\bMLK\b/i, "milk"],
  [/\bYOG(RT)?\b|\bYGRT\b/i, "yogurt"],
  [/\bCHS\b|\bCHZ\b|\bCHEE?SE?\b/i, "cheese"],
  [/\bCHKN?\b|\bCHCKN\b/i, "chicken"],
  [/\bBF\b|\bGRND ?BF\b/i, "beef"],
  [/\bTRKY\b|\bTURK\b/i, "turkey"],
  [/\bSLMN\b/i, "salmon"],
  [/\bSHRMP\b/i, "shrimp"],
  [/\bBRCLI\b|\bBROC+\b/i, "broccoli"],
  [/\bSPNCH\b|\bSPIN\b/i, "spinach"],
  [/\bTOM\b|\bTMTO\b|\bTMT\b/i, "tomato"],
  [/\bONN?\b|\bONIO?N?\b/i, "onion"],
  [/\bPTO\b|\bPOT\b|\bPTATO\b/i, "potato"],
  [/\bCRRT\b|\bCARR\b/i, "carrot"],
  [/\bBNNA\b|\bBAN\b/i, "banana"],
  [/\bAVO?C?\b/i, "avocado"],
  [/\bBLBRY\b|\bBLUBRY\b/i, "blueberries"],
  [/\bSTRWB?RY\b/i, "strawberries"],
  [/\bLTTC\b|\bLETT\b/i, "lettuce"],
  [/\bCUC\b|\bCCMBR\b/i, "cucumber"],
  [/\bPPR\b|\bPEPP\b/i, "pepper"],
  [/\bMSHRM\b|\bMUSH\b/i, "mushroom"],
  [/\bBNS\b|\bBEAN\b/i, "beans"],
  [/\bCHKPS\b|\bGRBNZ\b/i, "chickpeas"],
  [/\bLNTL\b/i, "lentils"],
  [/\bRC\b|\bRICE\b/i, "rice"],
  [/\bPSTA\b/i, "pasta"],
  [/\bBRD\b|\bBREA?D\b/i, "bread"],
  [/\bTRTLA\b|\bTORT\b/i, "tortilla"],
  [/\bEGGS?\b/i, "eggs"],
  [/\bBTR\b|\bBUTT\b/i, "butter"],
  [/\bOL\b|\bOLV ?OL\b|\bOLIVE ?OIL\b/i, "olive oil"],
  [/\bTFU\b|\bTOFU\b/i, "tofu"],
  [/\bOATS?\b/i, "oats"],
];

/** Pack-size and till noise: never part of the food's identity. */
const NOISE =
  /\b(\d+(\.\d+)?\s?(OZ|LB|LBS|G|KG|ML|L|CT|PK|PC|EA|FZ|QT|GAL))\b|\b(F|T|B|A|K)\b|#\d+|\bWT\b|\bNET\b|\bPRICE\b|\bREG\b|\bSALE\b|\bSAVINGS?\b/gi;

/**
 * Expand a raw till line into plain words. Mechanical only: no guessing about
 * which product it is, that is the caller's second pass.
 * @param {string} raw
 * @returns {string}
 */
export function expandTillName(raw) {
  let s = String(raw ?? "").replace(NOISE, " ");
  for (const [re, word] of TILL_WORDS) s = s.replace(re, ` ${word} `);
  return s
    .replace(/[^A-Za-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Decide what a receipt line actually was, preferring the foods this shopper
 * was sent to buy.
 *
 * `expected` is the current shopping list's foods. A till line that shares a
 * word with something on the list is almost certainly that thing: you do not
 * usually come home with a food nobody planned. This is what stops "BLDMD
 * ALMND" becoming almond milk when the list said almonds.
 * @param {string} raw the till text
 * @param {string[]} expected food names on the current list
 * @returns {{ food: string, source: "list" | "expanded" | "raw", confident: boolean }}
 */
export function decodeReceiptLine(raw, expected) {
  const expanded = expandTillName(raw);
  const words = new Set(expanded.split(" ").filter((w) => w.length > 2));
  if (words.size === 0) return { food: String(raw ?? ""), source: "raw", confident: false };

  let best = null;
  for (const candidate of expected ?? []) {
    const cw = String(candidate).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
    if (cw.length === 0) continue;
    const hits = cw.filter((w) => words.has(w)).length;
    if (hits === 0) continue;
    // every word of the shorter side that matches counts: "almonds" against
    // "sliced almonds" is a hit, and so is the reverse
    const score = hits / Math.min(cw.length, words.size);
    if (!best || score > best.score) best = { candidate, score };
  }

  // one clear winner from the list beats anything the abbreviation suggests
  if (best && best.score >= 0.5) return { food: best.candidate, source: "list", confident: true };
  if (expanded) return { food: expanded, source: "expanded", confident: words.size > 0 };
  return { food: String(raw ?? ""), source: "raw", confident: false };
}

/**
 * How well the trip matched the list.
 *
 * David asked for a score on "did i buy for what i needed". Deliberately plain
 * arithmetic over what is already known, in the same spirit as the adherence
 * score: no judgment, just the three numbers and the names behind them, so a
 * low score is always explainable rather than accusing.
 * @param {{ name: string }[]} lines receipt lines, already decoded
 * @param {{ food: string, checked?: boolean }[]} listItems this week's list
 * @returns {{ score: number, bought: string[], missed: string[], extra: string[] }}
 */
export function shopScore(lines, listItems) {
  const onList = new Map();
  for (const i of listItems ?? []) onList.set(canonicalFood(i.food), i.food);
  const boughtKeys = new Set();
  const extra = [];
  for (const l of lines ?? []) {
    const key = canonicalFood(l.name);
    if (onList.has(key)) boughtKeys.add(key);
    else extra.push(l.name);
  }
  const bought = [...boughtKeys].map((k) => onList.get(k) ?? k);
  const missed = [...onList.entries()].filter(([k]) => !boughtKeys.has(k)).map(([, name]) => name);
  const total = onList.size;
  return {
    score: total === 0 ? 0 : Math.round((boughtKeys.size / total) * 100),
    bought,
    missed,
    extra,
  };
}
