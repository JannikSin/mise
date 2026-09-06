// Camera-pantry: merge Worker scan results into pantry.json.
// Seen in the photo means owned: shelf-stable "staple" reads refresh the
// item's state to plenty (mirrors ownItemToPantry semantics); everything
// else lands as a dated row with today's date.

import {
  sectionOf,
  slug,
  pantryItems,
  packPantry,
  isDatedItem,
  looksPerishable,
} from "./shopping.js";

/**
 * SAY WHAT YOU HAVE (David, 2026-09-06: "I can just voice type in what I
 * have... I have soy sauce, I have sesame oil... run through all the things
 * that I have and then we can get the pantry up to date"). One dictated or
 * pasted run-through becomes pantry items, through the SAME apply path as an
 * approved photo scan, so nothing about how a row lands differs by door.
 *
 * Reading rules, all plain:
 *  - items split on commas, semicolons, newlines, " and ", " also ", " then "
 *  - leading filler is dropped: "I have", "we've got", "some", "a bunch of"…
 *  - a leading amount is kept as the row's qty ("2 lbs chicken thighs",
 *    "3 cans black beans", "a dozen eggs", "half a bag of rice")
 *  - "low on X", "running low on X", "almost out of X", "nearly out of X",
 *    "not much X" mark a shelf-stable item LOW instead of plenty; "out of X"
 *    and "no X" are dropped (nothing to add)
 *  - "frozen X" goes to the freezer; a perishable by the expiry table's own
 *    keywords goes to the fridge, dated today; everything else is a
 *    shelf-stable state (plenty, or low when said)
 * The result is a PREVIEW the person edits before it lands; the parser never
 * writes.
 * @param {string} text
 * @returns {{ name: string, kind: "staple" | "fresh", qty: string, state?: "low", location: "fridge" | "freezer" | "pantry" | "unsorted" }[]}
 */
export function parsePantryDictation(text) {
  const raw = String(text ?? "")
    .replace(/\r/g, "")
    .split(/\n|[,;]|\band\b|\balso\b|\bthen\b|\bplus\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  /** @type {ReturnType<typeof parsePantryDictation>} */
  const out = [];
  const seen = new Set();
  for (let piece of raw) {
    // filler at the front: the way people actually talk into a phone
    piece = piece
      .replace(/^(?:um+|uh+|okay|ok|so|yeah|yes|well|oh)\b[\s,]*/i, "")
      .replace(/^(?:i|we)(?:'ve| have| got|'ve got| also have| still have| do have)\b\s*/i, "")
      .replace(/^(?:there(?:'s| is| are))\s+/i, "")
      .replace(/^(?:got|have|having)\s+/i, "")
      .trim();
    if (!piece) continue;
    // nothing to add
    if (/^(?:no|out of|we're out of|i'm out of|zero|none of the|no more)\s+/i.test(piece)) continue;
    /** @type {"low" | undefined} */
    let state;
    const lowM = piece.match(
      /^(?:(?:running |getting )?low on|(?:almost|nearly|running|getting) out of|not (?:much|a lot of|many)|only a (?:little|bit of|few)|last of the|barely any)\s+(.+)$/i,
    );
    if (lowM) {
      state = "low";
      piece = /** @type {string} */ (lowM[1]);
    } else {
      piece = piece.replace(/^(?:plenty of|lots of|loads of|a lot of|tons of|enough)\s+/i, "");
    }
    piece = piece
      .replace(/^(?:some|a few|a couple of|a couple|a bunch of|a bit of|the)\s+/i, "")
      .replace(/[.!?]+$/g, "")
      .trim();
    // a leading amount, kept as the row's qty
    let qty = "";
    const qtyM = piece.match(
      /^((?:\d+(?:[./]\d+)?|half a|half an|half|a dozen|two dozen|a|an|one|two|three|four|five|six|eight|ten|twelve)\s*(?:lbs?|pounds?|oz|ounces?|kgs?|kilos?|grams?|g|liters?|litres?|l|ml|gallons?|quarts?|pints?|cups?|cans?|jars?|bottles?|bags?|boxes?|packs?|packages?|packets?|tubs?|cartons?|bunch(?:es)?|heads?|loaves|loaf|dozen|sticks?|blocks?|containers?)?)\s+(?:of\s+)?(.+)$/i,
    );
    if (qtyM) {
      const amount = /** @type {string} */ (qtyM[1]).trim().toLowerCase();
      const rest = /** @type {string} */ (qtyM[2]).trim();
      // a bare article is not a quantity ("a spinach" is just spinach)
      if (!/^(?:a|an|one)$/.test(amount)) {
        qty = amount
          .replace(/^half an? /, "0.5 ")
          .replace(/^half$/, "0.5")
          .replace(/^a dozen$/, "1 dozen")
          .replace(/^two dozen$/, "2 dozen")
          .replace(/^an? /, "1 ")
          .replace(/^one /, "1 ")
          .replace(/^two /, "2 ")
          .replace(/^three /, "3 ")
          .replace(/^four /, "4 ")
          .replace(/^five /, "5 ")
          .replace(/^six /, "6 ")
          .replace(/^eight /, "8 ")
          .replace(/^ten /, "10 ")
          .replace(/^twelve /, "12 ");
        piece = rest;
      } else {
        piece = rest;
      }
    }
    piece = piece.replace(/\s+/g, " ").trim();
    if (!piece || piece.length > 80) continue;
    const name = piece.charAt(0).toLowerCase() + piece.slice(1);
    const key = slug(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const frozen = /\bfrozen\b/i.test(name);
    const fresh = frozen || looksPerishable(name);
    out.push({
      name,
      kind: fresh ? "fresh" : "staple",
      qty,
      ...(state && !fresh ? { state } : {}),
      location: frozen ? "freezer" : fresh ? "fridge" : "unsorted",
    });
  }
  return out;
}

/**
 * @param {Record<string, any>} pantry
 * @param {{ name: string, kind: string, qty: string, state?: string }[]} items approved scan items
 *   (`state: "low"` on a staple, from the dictation parser, lands it LOW
 *   instead of plenty: "running low on rice" is exactly the thing the list
 *   should buy next)
 * @param {string} todayIso local YYYY-MM-DD
 * @param {string} [location] shelf the new dated rows land on (fresh-start
 *   wizard's "another photo of the same shelf" is additive but still placed).
 *   Absent = legacy behavior: no location, rows read as "unsorted".
 * @returns {Record<string, any>} new pantry (input untouched)
 */
export function applyScanItems(pantry, items, todayIso, location) {
  const next = [...pantryItems(pantry)];

  for (const item of items) {
    const name = item.name.trim();
    if (!name) continue;
    if (item.kind === "staple") {
      const id = slug(name);
      const at = next.findIndex((it) => !isDatedItem(it) && it.id === id);
      const state = item.state === "low" ? "low" : "plenty";
      if (at >= 0) {
        next[at] = { ...next[at], state };
      } else {
        next.push({ id, food: name, section: sectionOf(name), state });
      }
    } else {
      // slug-dedupe so weekly re-scans ("Half-Cabbage" vs "half cabbage")
      // don't pile up duplicates. A duplicate is REFRESHED, not skipped
      // (Tribunal 2026-08-01): the camera is looking at the shelf right now,
      // so its reading beats a stale row — including one another device's
      // concurrent edit resurrected through the merge mid-wizard. SHELF-
      // AWARE (Tribunal B3): a fridge scan refreshes only a fridge row —
      // rewriting the freezer's pack of the same food would teleport it
      // between shelves and reset its age. Same food on another shelf gets
      // its own new row.
      const key = slug(name);
      const dup = next.findIndex(
        (it) =>
          isDatedItem(it) &&
          slug(String(it.food)) === key &&
          (!location || (it.location ?? "unsorted") === location),
      );
      if (dup >= 0) {
        next[dup] = {
          ...next[dup],
          ...(item.qty ? { qty: item.qty } : {}),
          added: todayIso,
          ...(location ? { location } : {}),
        };
        continue;
      }
      next.push({
        id: crypto.randomUUID().slice(0, 8),
        food: name,
        qty: item.qty ?? "",
        added: todayIso,
        useSoon: false,
        ...(location ? { location } : {}),
      });
    }
  }
  return packPantry(next);
}
