// PARKED FEATURES (Mise decision 0016, David 2026-10-12). A parked feature keeps
// its code, its route and its tests; only its doors on the screens close, so it
// can come back by deleting one word here. Each has a return date in Crystal
// Lanes/Mise-Later.
//
// Decision 0018 (David, 2026-10-16: "I don't need to know the details of the
// engine", "I don't want to keep track of money on this app", "just make it so
// much simpler"): house money, the Kroger cart buttons, the re-roll, recipe
// browsing, the dinner chat, the tour, the Table tab's per-meal week (now
// People) join them. The doctrine's tenet 1
// (choices taken away) and the 10/13 comparison already named the last four.

/** @type {ReadonlySet<string>} */
export const PARKED = new Set([
  "menu",
  "remedies",
  "occasions",
  "money",
  "kroger",
  "reroll",
  "cookbook",
  "dinnerchat",
  "tour",
  "tableweek",
]);

/** @param {string} feature */
export function isParked(feature) {
  return PARKED.has(feature);
}
