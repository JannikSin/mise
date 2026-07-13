// Fitness data operations (blueprint §6.6): last-time numbers beside each
// lift, PRs, progression series for the SVG charts, daily check-in upserts.
import { localIsoDate, parseLocalIso } from "./dates.js";

/**
 * @typedef {{ weight: number, reps: number }} SetEntry
 * @typedef {{ name: string, sets: SetEntry[] }} SessionExercise
 * @typedef {{ date: string, templateId?: string, exercises: SessionExercise[], notes?: string }} Session
 * @typedef {{ days: Record<string, any>[] }} Daily
 */

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Today's session from the fixed weekly rotation (Phase 8: zero-guesswork
 * Train — David never picks a split, the schedule already knows). Null on a
 * rest day, when there's no schedule yet, or when the scheduled id doesn't
 * match any template.
 * @param {Record<string, string | null> | undefined} schedule
 * @param {Record<string, any>[]} templates
 * @param {string} dateIso
 * @returns {Record<string, any> | null}
 */
export function templateForDate(schedule, templates, dateIso) {
  if (!schedule) return null;
  const weekday = WEEKDAY_KEYS[parseLocalIso(dateIso).getDay()] ?? "sun";
  const templateId = schedule[weekday];
  if (!templateId) return null;
  return templates.find((t) => t.id === templateId) ?? null;
}

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
 * A day counts toward the streak when sleep is logged, pushups hit the
 * target, water (liters) hits the target, and every supplement in the plan
 * is ticked. Water counts in liters — David's rule: a cup is ~250ml, a
 * bottle is 1L (unit resolved 2026-07-06).
 * @param {Record<string, any> | undefined} day
 * @param {string[]} supplementIds
 * @param {number} pushupTarget
 * @param {number} waterTargetLiters
 * @returns {boolean}
 */
export function dayQualifies(day, supplementIds, pushupTarget, waterTargetLiters) {
  if (!day) return false;
  if (typeof day.sleepHours !== "number" || day.sleepHours <= 0) return false;
  if ((day.pushups ?? 0) < pushupTarget) return false;
  if ((day.water ?? 0) < waterTargetLiters) return false;
  const supp = day.supplements ?? {};
  return supplementIds.every((id) => supp[id] === true);
}

/**
 * Consecutive qualifying days ending today — or ending yesterday when today
 * is still in progress (an unfinished today never breaks a live streak).
 * @param {Record<string, any>[]} days
 * @param {string[]} supplementIds
 * @param {number} pushupTarget
 * @param {number} waterTargetLiters
 * @param {string} todayIso
 * @returns {number}
 */
export function computeStreak(days, supplementIds, pushupTarget, waterTargetLiters, todayIso) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const qualifies = (/** @type {Date} */ d) =>
    dayQualifies(byDate.get(localIsoDate(d)), supplementIds, pushupTarget, waterTargetLiters);
  const cursor = parseLocalIso(todayIso);
  if (!qualifies(cursor)) cursor.setDate(cursor.getDate() - 1); // today still open
  let streak = 0;
  while (qualifies(cursor)) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * Set (or replace) the single top-set result for one exercise in an
 * in-progress session: the simplified logging flow logs once per lift,
 * not once per set. Pure.
 * @param {Session} session
 * @param {string} exercise
 * @param {SetEntry} set
 * @returns {Session}
 */
export function setTopSet(session, exercise, set) {
  const existing = session.exercises.find((e) => e.name === exercise);
  return {
    ...session,
    exercises: existing
      ? session.exercises.map((e) => (e.name === exercise ? { ...e, sets: [set] } : e))
      : [...session.exercises, { name: exercise, sets: [set] }],
  };
}

/**
 * @typedef {{
 *   sex: "m" | "f",
 *   age: number,
 *   heightFt: number,
 *   heightIn: number,
 *   weightLb: number,
 *   activity: 1 | 2 | 3 | 4 | 5,
 *   goal: "loss" | "maintain" | "gain"
 * }} Questionnaire
 */

/** Standard TDEE activity multipliers, sedentary through very active. */
const ACTIVITY_MULT = [1.2, 1.375, 1.55, 1.725, 1.9];

/**
 * A complete fitness/targets.json from the add-profile questionnaire, so a
 * new household member gets working macro targets without a single hand-set
 * number. Mifflin-St Jeor BMR (imperial inputs converted internally — this
 * household shops in Chicagoland, not Lyon) x activity, then a goal delta
 * (-500 loss / +300 gain). Protein anchors to bodyweight, fat to ~30% of
 * calories, carbs take the remainder. Greger's Daily Dozen targets are the
 * published dozen — the same for everyone; only the macro wrapper differs.
 * @param {Questionnaire} q
 * @param {string} [todayIso] stamps phaseSince when provided
 * @returns {Record<string, any>}
 */
export function targetsFromQuestionnaire(q, todayIso) {
  const kg = q.weightLb * 0.45359237;
  const cm = (q.heightFt * 12 + q.heightIn) * 2.54;
  const bmr = 10 * kg + 6.25 * cm - 5 * q.age + (q.sex === "m" ? 5 : -161);
  const tdee = bmr * (ACTIVITY_MULT[q.activity - 1] ?? 1.2);
  const delta = q.goal === "loss" ? -500 : q.goal === "gain" ? 300 : 0;
  const calories = Math.max(1200, Math.round((tdee + delta) / 50) * 50);
  const protein = Math.round(q.weightLb * (q.goal === "gain" ? 1.0 : 0.9));
  const fat = Math.round((calories * 0.3) / 9);
  const carbs = Math.round((calories - protein * 4 - fat * 9) / 4);
  const phase = q.goal === "loss" ? "loss" : q.goal === "gain" ? "gain" : "recomp";
  return {
    macros: {
      calories,
      caloriesFloor: Math.max(1200, calories - 200),
      protein,
      proteinFloor: Math.max(0, protein - 25),
      fat,
      carbs,
      waterLiters: q.sex === "m" ? 3.5 : 2.7,
    },
    adjustmentRule:
      "Weigh most mornings; judge the 7-day average, not the day. Adjust calories by 150-200 only after two flat weeks.",
    phase,
    ...(todayIso ? { phaseSince: todayIso } : {}),
    mealSlots:
      phase === "gain"
        ? ["breakfast", "lunch", "dinner", "smoothie"]
        : ["breakfast", "lunch", "dinner"],
    tracks:
      phase === "gain"
        ? ["sleep", "weight", "pushups", "water", "supplements", "dailyDozen"]
        : ["sleep", "weight", "waist", "water", "dailyDozen"],
    dailyDozen: {
      beans: 3,
      berries: 1,
      otherFruit: 3,
      cruciferousVeg: 1,
      greens: 2,
      otherVeg: 2,
      flaxseed: 1,
      nuts: 1,
      spicesHerbs: 1,
      wholeGrains: 3,
      beverages: 5,
    },
    sleepHoursTarget: 8,
    priorityStack: ["Sleep", "Protein", "Water", "Everything else"],
    nonNegotiables: [],
    supplementPlan: [],
  };
}
