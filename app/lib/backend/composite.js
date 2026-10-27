// THE COMPOSITE LANE (Mise 2.0, plan section 5). On the admin's phone, root
// `fitness/*` and `health/*` (the daily log, workouts, and the targets mirror
// Anvil reads as `fitness/targets.json`) stay on GitHub; everything else goes
// to Supabase. So `writeTargetsOf` for the root profile lands its canonical
// `profile/targets.json` on Supabase and its mirror on GitHub, unchanged for
// Anvil. Each record's lane is reported (laneOf) so a GitHub failure stops
// only the GitHub records in a flush, never the Supabase ones.

const GITHUB_LANE = /^(fitness|health)(\/|$)/;

/**
 * @param {string} path
 * @returns {"github" | "supabase"}
 */
export function compositeLaneOf(path) {
  return GITHUB_LANE.test(path) ? "github" : "supabase";
}

/**
 * @param {{
 *   primary: import("../backend.js").Backend,
 *   github: import("../backend.js").Backend,
 * }} lanes
 * @returns {import("../backend.js").Backend}
 */
export function createCompositeBackend({ primary, github }) {
  /** @param {string} path */
  const pick = (path) => (compositeLaneOf(path) === "github" ? github : primary);
  return {
    name: primary.name,
    read: (path) => pick(path).read(path),
    write: (path, data, sha) => pick(path).write(path, data, sha),
    list: (dir) => pick(dir).list(dir),
    readMeta: (path) => pick(path).readMeta(path),
    authHeader: () => primary.authHeader(),
    status: () => primary.status(),
    authBroken: (status) => primary.authBroken(status),
    // one stamp for the whole install: a record queued here replays here,
    // whichever lane it goes to
    stamp: () => primary.stamp(),
    laneOf: (path) => compositeLaneOf(path),
    session: () => primary.session(),
  };
}
