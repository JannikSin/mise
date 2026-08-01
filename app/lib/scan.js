// Camera-pantry: merge Worker scan results into pantry.json.
// Seen in the photo means owned: staples refresh to onHand / not-low
// (mirrors ownItemToPantry semantics); perishables get today's date.

import { sectionOf, slug } from "./shopping.js";

/**
 * @param {Record<string, any>} pantry
 * @param {{ name: string, kind: string, qty: string }[]} items approved scan items
 * @param {string} todayIso local YYYY-MM-DD
 * @param {string} [location] shelf the new perishables land on (fresh-start
 *   wizard's "another photo of the same shelf" is additive but still placed).
 *   Absent = legacy behavior: no location, rows read as "unsorted".
 * @returns {Record<string, any>} new pantry (input untouched)
 */
export function applyScanItems(pantry, items, todayIso, location) {
  const staples = [...(pantry.staples ?? [])];
  const perishables = [...(pantry.perishables ?? [])];

  for (const item of items) {
    const name = item.name.trim();
    if (!name) continue;
    if (item.kind === "staple") {
      const id = slug(name);
      const at = staples.findIndex((s) => s.id === id);
      if (at >= 0) {
        staples[at] = { ...staples[at], onHand: true, runningLow: false };
      } else {
        staples.push({ id, name, section: sectionOf(name), onHand: true, runningLow: false });
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
      const dup = perishables.findIndex(
        (p) =>
          slug(String(p.food)) === key && (!location || (p.location ?? "unsorted") === location),
      );
      if (dup >= 0) {
        perishables[dup] = {
          ...perishables[dup],
          ...(item.qty ? { qty: item.qty } : {}),
          added: todayIso,
          ...(location ? { location } : {}),
        };
        continue;
      }
      perishables.push({
        id: crypto.randomUUID().slice(0, 8),
        food: name,
        qty: item.qty ?? "",
        added: todayIso,
        useSoon: false,
        ...(location ? { location } : {}),
      });
    }
  }
  return { ...pantry, staples, perishables };
}
