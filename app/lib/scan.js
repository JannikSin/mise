// Camera-pantry: merge Worker scan results into pantry.json.
// Seen in the photo means owned: staples refresh to onHand / not-low
// (mirrors ownItemToPantry semantics); perishables get today's date.

import { sectionOf, slug } from "./shopping.js";

/**
 * @param {Record<string, any>} pantry
 * @param {{ name: string, kind: string, qty: string }[]} items approved scan items
 * @param {string} todayIso local YYYY-MM-DD
 * @returns {Record<string, any>} new pantry (input untouched)
 */
export function applyScanItems(pantry, items, todayIso) {
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
      // don't pile up duplicates
      const key = slug(name);
      if (perishables.some((p) => slug(String(p.food)) === key)) continue;
      perishables.push({
        id: crypto.randomUUID().slice(0, 8),
        food: name,
        qty: item.qty ?? "",
        added: todayIso,
        useSoon: false,
      });
    }
  }
  return { ...pantry, staples, perishables };
}
