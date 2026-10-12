// PARKED FEATURES (Mise decision 0016, David 2026-10-12). A parked feature keeps
// its code, its route and its tests; only its doors on the screens close, so it
// can come back by deleting one word here. Each has a return date in Crystal
// Lanes/Mise-Later.

/** @type {ReadonlySet<string>} */
export const PARKED = new Set(["menu", "remedies", "occasions"]);

/** @param {string} feature */
export function isParked(feature) {
  return PARKED.has(feature);
}
