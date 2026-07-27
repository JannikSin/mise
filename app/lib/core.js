// Directed core sessions for the Train tab: floor work, no equipment, 5-10
// minutes, morning or before bed. Replaces the configurable interval timer,
// which was a stopwatch that still made David decide what to do.
//
// Selection rationale (David asked for the Nippard read, 2026-07-27):
//
//   Nippard's own position on abs is that WEIGHTED full-range lumbar flexion
//   (cable crunch) plus a leg raise is what actually drives growth, and that
//   bodyweight ab circuits are the weaker choice for hypertrophy because so
//   many of the moves stop being limited by the abs. That is not an argument
//   against this block, it is an argument about what this block IS: the
//   baseline he asked for, built to be done daily on a floor, with the
//   weighted work arriving later on top of it.
//
//   So the sessions are built around the four things a core has to do rather
//   than around a list of exercises:
//
//     FLEXION            crunch, reverse crunch, leg raise (the growth driver)
//     ANTI-EXTENSION     plank, dead bug, hollow hold (resisting the arch)
//     ANTI-LATERAL FLEX  side plank, Copenhagen (resisting the sideways fold)
//     ROTATION           bicycle, slow twists (the one most programs skip)
//
//   Two deliberate calls. The Russian twist is DEMOTED, not banned: done for
//   time it turns into a momentum-driven hip swing and it loads the spine
//   more than the isometrics do, so it appears once, slow and controlled,
//   rather than as a staple. The Copenhagen plank is IN and progresses by
//   lever (knee first, then foot) because it is an adductor/groin exercise
//   with real injury-prevention evidence behind it, and he plays tennis.
//
// Timing over reps is on purpose: a countdown can drive itself, a rep count
// cannot. Dynamic moves therefore carry a tempo cue, because "leg raises for
// 40 seconds" without one becomes a fast sloppy set.

/**
 * @typedef {{ name: string, seconds: number, rest: number, cue: string, side?: "L" | "R" }} CoreStep
 * @typedef {{ id: string, name: string, focus: string, note: string, steps: CoreStep[] }} CoreSession
 */

/**
 * The rotation. Four sessions so a daily habit does not repeat the same
 * stimulus, ordered easiest to hardest, all of them floor-only.
 * @type {CoreSession[]}
 */
export const CORE_SESSIONS = [
  {
    id: "baseline",
    name: "Baseline",
    focus: "all four patterns, nothing advanced",
    note: "Start here. If you can hold every position without your lower back arching off the floor, you are ready for the harder ones.",
    steps: [
      {
        name: "Dead bug",
        seconds: 45,
        rest: 10,
        cue: "Lower back pressed flat into the floor the whole time. Opposite arm and leg, slow, breathe out as they reach.",
      },
      {
        name: "Front plank",
        seconds: 45,
        rest: 10,
        cue: "Elbows under shoulders, squeeze the glutes, tuck the ribs down. Straight line, no sag and no piking up.",
      },
      {
        name: "Reverse crunch",
        seconds: 40,
        rest: 0,
        cue: "Roll the hips off the floor toward your chest, 2 seconds up, 2 down. Momentum does nothing here.",
      },
      {
        name: "Side plank",
        side: "L",
        seconds: 30,
        rest: 0,
        cue: "Hips stacked and lifted. Straight into the other side after this.",
      },
      {
        name: "Side plank",
        side: "R",
        seconds: 30,
        rest: 10,
        cue: "Same on the right. Do not let the hips drift backward.",
      },
      {
        name: "Hollow hold",
        seconds: 30,
        rest: 10,
        cue: "Lower back glued down first, THEN lift. Bend the knees if the back lifts.",
      },
      {
        name: "Slow bicycle",
        seconds: 40,
        rest: 0,
        cue: "One elbow toward the opposite knee, hold a beat at the top. Slow beats fast every time.",
      },
    ],
  },
  {
    id: "lower",
    name: "Lower + anti-extension",
    focus: "leg raises, the part everyone skips",
    note: "The hardest thing to keep honest is the lower back. The moment it arches off the floor, the abs stopped working and the hip flexors took over.",
    steps: [
      {
        name: "Dead bug",
        seconds: 40,
        rest: 0,
        cue: "Warm-up set. Find the flat back now, you need it for everything below.",
      },
      {
        name: "Lying leg raise",
        seconds: 45,
        rest: 10,
        cue: "Hands under the hips. 2 seconds down is the whole exercise. Stop lowering the instant the back lifts.",
      },
      {
        name: "Reverse crunch",
        seconds: 40,
        rest: 10,
        cue: "Hips off the floor, not just knees to chest. Short range, done properly.",
      },
      {
        name: "Hollow hold",
        seconds: 35,
        rest: 10,
        cue: "Arms overhead if you can hold the back flat, hands on thighs if you cannot.",
      },
      {
        name: "Plank",
        seconds: 45,
        rest: 10,
        cue: "Ribs down, glutes on. This is an anti-arch exercise, not an endurance contest.",
      },
      {
        name: "Flutter kicks",
        seconds: 30,
        rest: 0,
        cue: "Small and controlled, heels low. Back flat or raise the legs higher.",
      },
    ],
  },
  {
    id: "oblique",
    name: "Sides + Copenhagen",
    focus: "obliques, adductors, tennis insurance",
    note: "Copenhagen is here for the groin, not the six-pack. Adductor strength is one of the better-evidenced ways to keep a groin injury off a tennis court.",
    steps: [
      {
        name: "Side plank",
        side: "L",
        seconds: 35,
        rest: 0,
        cue: "Hips stacked, top hand on the hip or reaching up. Straight into the right.",
      },
      {
        name: "Side plank",
        side: "R",
        seconds: 35,
        rest: 10,
        cue: "Same, right side. Push the floor away, do not sink into the shoulder.",
      },
      {
        name: "Copenhagen, knee",
        side: "L",
        seconds: 25,
        rest: 0,
        cue: "Top KNEE on the couch or chair, short lever. Drive the knee down into it and lift the hips.",
      },
      {
        name: "Copenhagen, knee",
        side: "R",
        seconds: 25,
        rest: 15,
        cue: "Right side. Progress to the foot on the surface only when 25 seconds feels easy.",
      },
      {
        name: "Side plank hip dip",
        side: "L",
        seconds: 30,
        rest: 0,
        cue: "Hip taps the floor, then drive it back up. Slow, no bouncing.",
      },
      {
        name: "Side plank hip dip",
        side: "R",
        seconds: 30,
        rest: 10,
        cue: "Right side, same tempo.",
      },
      {
        name: "Slow Russian twist",
        seconds: 30,
        rest: 0,
        cue: "Feet down, lean back, rotate from the ribs and PAUSE each side. If it turns into a hip swing, it is doing nothing.",
      },
    ],
  },
  {
    id: "flexion",
    name: "Flexion focus",
    focus: "the growth pattern, full range",
    note: "This is the session closest to what actually builds abs. Full range means the lower back rounds off the floor at the top, not a two-inch neck twitch.",
    steps: [
      {
        name: "Crunch, full range",
        seconds: 40,
        rest: 10,
        cue: "Round the spine and reach the ribs toward the hips. Squeeze hard at the top, 2 seconds down.",
      },
      {
        name: "Reverse crunch",
        seconds: 40,
        rest: 10,
        cue: "Bottom half of the same movement. Hips off the floor.",
      },
      {
        name: "Slow bicycle",
        seconds: 45,
        rest: 10,
        cue: "Rotation plus flexion. Pause at each end, both shoulders off the floor throughout.",
      },
      {
        name: "Lying leg raise",
        seconds: 40,
        rest: 10,
        cue: "2 seconds down. The lowering half is the part that counts.",
      },
      {
        name: "Plank",
        seconds: 60,
        rest: 0,
        cue: "Finisher. Everything braced, nothing sagging, breathe normally.",
      },
    ],
  },
];

/** Seconds of GET READY before the first move: enough to read one cue and
 *  get on the floor, short enough not to feel like waiting. */
export const LEAD_IN = 8;

/**
 * Seconds of work plus rest in a session (the number shown before you start).
 * @param {CoreSession} session
 * @returns {number}
 */
export function sessionSeconds(session) {
  return (session?.steps ?? []).reduce((sum, s) => sum + s.seconds + s.rest, 0);
}

/**
 * Which session today's rotation lands on, derived from the date rather than
 * stored anywhere: no state to sync across four phones, no "last done" file
 * to conflict on, and it still varies day to day. He can always override with
 * the picker.
 * @param {string} todayIso YYYY-MM-DD
 * @param {CoreSession[]} [sessions]
 * @returns {CoreSession}
 */
export function sessionForDay(todayIso, sessions = CORE_SESSIONS) {
  const days = Math.floor(Date.parse(`${todayIso}T00:00:00Z`) / 86400000);
  const i = Number.isFinite(days)
    ? ((days % sessions.length) + sessions.length) % sessions.length
    : 0;
  return /** @type {CoreSession} */ (sessions[i]);
}

/**
 * Where a running session stands after `elapsed` whole seconds.
 *
 * Pure, and the view owns the clock, same contract the interval timer had:
 * timing derives from a wall-clock start stamp, so a phone that throttles a
 * backgrounded tab never drifts. A step with `rest: 0` flows straight into
 * the next one, which is what he asked for, and the final rest is dropped
 * because rest you never come back from is just the end of the workout.
 * @param {number} elapsed whole seconds since start
 * @param {CoreStep[]} steps
 * @param {number} [leadIn] seconds of GET READY before the first move
 * @returns {{
 *   phase: "ready" | "work" | "rest" | "done",
 *   index: number,
 *   remaining: number,
 *   step: CoreStep | null,
 *   next: CoreStep | null,
 *   workLeft: number
 * }}
 */
export function coreStepAt(elapsed, steps, leadIn = 0) {
  const list = steps ?? [];
  const done = {
    phase: /** @type {"ready" | "work" | "rest" | "done"} */ ("done"),
    index: list.length,
    remaining: 0,
    step: null,
    next: null,
    workLeft: 0,
  };
  if (list.length === 0) return done;

  let t = Math.max(0, Math.floor(elapsed));
  // GET READY (David, 2026-07-27: "I had to read the description while I was
  // supposed to be doing them"). The cue and the figure for move ONE need a
  // moment on screen before the clock on move one starts, or the first thing
  // the session asks you to do is read.
  if (leadIn > 0 && t < leadIn) {
    return {
      phase: /** @type {"ready" | "work" | "rest" | "done"} */ ("ready"),
      index: -1,
      remaining: leadIn - t,
      step: null,
      next: list[0] ?? null,
      workLeft: list.reduce((sum, x) => sum + x.seconds, 0),
    };
  }
  t -= Math.max(0, leadIn);
  for (let i = 0; i < list.length; i++) {
    const step = /** @type {CoreStep} */ (list[i]);
    const next = list[i + 1] ?? null;
    // work left = this step's remainder plus every later step's work, which
    // is what the "N s of work to go" line reads from
    const workLeft = list.slice(i).reduce((sum, s) => sum + s.seconds, 0);
    if (t < step.seconds) {
      return {
        phase: /** @type {"ready" | "work" | "rest" | "done"} */ ("work"),
        index: i,
        remaining: step.seconds - t,
        step,
        next,
        workLeft: workLeft - t,
      };
    }
    t -= step.seconds;
    // the last step's rest never runs: nothing follows it
    const rest = next ? step.rest : 0;
    if (t < rest) {
      return {
        phase: /** @type {"ready" | "work" | "rest" | "done"} */ ("rest"),
        index: i,
        remaining: rest - t,
        step,
        next,
        workLeft: workLeft - step.seconds,
      };
    }
    t -= rest;
  }
  return done;
}
