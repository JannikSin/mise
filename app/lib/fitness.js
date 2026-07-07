// Fitness data operations (blueprint §6.6): last-time numbers beside each
// lift, PRs, progression series for the SVG charts, daily check-in upserts.

/**
 * @typedef {{ weight: number, reps: number }} SetEntry
 * @typedef {{ name: string, sets: SetEntry[] }} SessionExercise
 * @typedef {{ date: string, templateId?: string, exercises: SessionExercise[], notes?: string }} Session
 * @typedef {{ days: Record<string, any>[] }} Daily
 */

/**
 * Most recent session's sets for a lift (the progressive-overload anchor).
 * @param {Session[]} sessions
 * @param {string} exercise
 * @returns {SetEntry[] | null}
 */
export function lastSetsFor(sessions, exercise) {
  const withLift = sessions
    .filter((s) => s.exercises.some((e) => e.name === exercise))
    .sort((a, b) => b.date.localeCompare(a.date));
  const latest = withLift[0];
  if (!latest) return null;
  const ex = latest.exercises.find((e) => e.name === exercise);
  return ex && ex.sets.length ? ex.sets : null;
}

/**
 * Console-style set summary: "155×5 · 155×4"; bodyweight sets read "bw×12".
 * @param {SetEntry[]} sets
 * @returns {string}
 */
export function formatSets(sets) {
  return sets.map((s) => `${s.weight > 0 ? s.weight : "bw"}×${s.reps}`).join(" · ");
}

/**
 * Heaviest set ever per lift (ties: earliest kept — first to reach it).
 * @param {Session[]} sessions
 * @returns {Map<string, { weight: number, reps: number, date: string }>}
 */
export function personalRecords(sessions) {
  /** @type {Map<string, { weight: number, reps: number, date: string }>} */
  const prs = new Map();
  for (const s of [...sessions].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const ex of s.exercises) {
      for (const set of ex.sets) {
        const cur = prs.get(ex.name);
        const better =
          !cur || set.weight > cur.weight || (set.weight === cur.weight && set.reps > cur.reps);
        if (better) prs.set(ex.name, { weight: set.weight, reps: set.reps, date: s.date });
      }
    }
  }
  return prs;
}

/**
 * Date-sorted top weight per session for one lift — chart-ready.
 * @param {Session[]} sessions
 * @param {string} exercise
 * @returns {{ date: string, top: number }[]}
 */
export function seriesFor(sessions, exercise) {
  return [...sessions]
    .sort((a, b) => a.date.localeCompare(b.date))
    .flatMap((s) => {
      const ex = s.exercises.find((e) => e.name === exercise);
      if (!ex || !ex.sets.length) return [];
      return [{ date: s.date, top: Math.max(...ex.sets.map((x) => x.weight)) }];
    });
}

/**
 * Patch (or create) one day's check-in row. Pure.
 * @param {Daily} daily
 * @param {string} date
 * @param {Record<string, any>} patch
 * @returns {Daily}
 */
export function upsertDay(daily, date, patch) {
  const days = daily.days ?? [];
  const existing = days.find((d) => d.date === date);
  return {
    ...daily,
    days: existing
      ? days.map((d) => (d.date === date ? { ...d, ...patch } : d))
      : [...days, { date, ...patch }],
  };
}

/**
 * Append a set to a lift within an in-progress session. Pure.
 * @param {Session} session
 * @param {string} exercise
 * @param {SetEntry} set
 * @returns {Session}
 */
export function addSetToSession(session, exercise, set) {
  const existing = session.exercises.find((e) => e.name === exercise);
  return {
    ...session,
    exercises: existing
      ? session.exercises.map((e) => (e.name === exercise ? { ...e, sets: [...e.sets, set] } : e))
      : [...session.exercises, { name: exercise, sets: [set] }],
  };
}
