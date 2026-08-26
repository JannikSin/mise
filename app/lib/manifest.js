// The generation manifest (fix list 2.5, council 2026-08-18): every
// generated week publishes what each subsystem did, with its inputs, so a
// subsystem that silently does nothing announces itself on day one. This
// codebase shipped FOUR engines that never ran and never crashed (synth.js
// plating, useSoon against an empty array, weightTrend with zero callers,
// macroTopUp ignoring budget); the manifest is the structural answer, and
// the registry test in tests/manifest.test.js fails the build if any
// registered subsystem reports nothing.
//
// Chairman's required lines (council record System/Council-2026-08-18):
// protein in g/kg against the Morton band (never grams-vs-floor alone),
// floors met and missed, each active floor with the date it was last
// reviewed, the active philosophy vector, and cooked-over-planned.

import { weightTrend } from "./weight.js";
import { weekAdherence } from "./adherence.js";
import { datesOfWeek, dayTotals, dayBought } from "./plan.js";
import { leftoverLedger } from "./portions.js";
import { enforcedCeilings, enforcedFloors } from "./targets.js";

/** Morton 2018: plateau ~1.6 g/kg/day, upper 95% CI ~2.2. */
const MORTON_LO = 1.6;
const MORTON_HI = 2.2;

/**
 * Every subsystem the manifest must speak for. Adding an engine to the app
 * means adding it here, which means the registry test forces it to report.
 */
export const SUBSYSTEMS = [
  "budget",
  "useSoon",
  "philosophy",
  "macroTopUp",
  "away",
  "floors",
  "plating",
  "weightTrend",
  "adherence",
  "protein",
  "leftovers",
  "swapToFit",
  "household",
  "fixedSlots",
];

/**
 * Compose the full manifest for a generated week: the engine facts
 * weekbuilder reported, plus the out-of-engine lines (weight trend,
 * adherence, plating status, floor review dates).
 * @param {{
 *   engine: Record<string, any>,
 *   targets: Record<string, any> | null,
 *   recipes: Record<string, any>[],
 *   dailyDays: Record<string, any>[],
 *   recentPlans: { weekId: string, plan: Record<string, any> | null }[],
 *   todayIso: string,
 * }} args `engine` = generateWeek's report.manifest; `recentPlans` = up to
 *   the last 4 weeks' plans (current included) for cooked-over-planned.
 * @returns {{ generatedAt: string, subsystems: Record<string, any>, fingerprint: string | null }}
 */
export function composeManifest({ engine, targets, recipes, dailyDays, recentPlans, todayIso }) {
  /** @type {Record<string, any>} */
  const subsystems = { ...engine };

  // RECOMPUTE delivered numbers from the plan AS IT STANDS, never trust the
  // engine's copy: the auto-swap pass (main.js) mutates entries AFTER
  // generateWeek composed its report, so engine floors/protein describe the
  // pre-swap plan (the manifest lying about the plan it is stapled to is the
  // exact dark-engine failure this file exists to kill). Same path serves
  // the fluid week (P4-new): re-composing after any edit stays truthful.
  const current = recentPlans?.[0]?.plan ?? null;
  const weekDates = current ? datesOfWeek(current.week ?? "") : [];
  if (current && subsystems.floors && Array.isArray(current.entries) && weekDates.length > 0) {
    const byId = new Map(recipes.map((r) => [r.id, r]));
    // held (occasion) dates are excluded exactly as the engine excludes them
    // from liveDates (weekbuilder): a colonoscopy-prep day reporting as a
    // calorie short day would be the manifest contradicting the engine's
    // deliberate hand-off (reviewer finding 2)
    const held = new Set(
      current.entries.filter((/** @type {any} */ e) => e.occasion).map((e) => e.date),
    );
    const live = weekDates.filter((d) => d >= todayIso && !held.has(d));
    const dates = live.length > 0 ? live : weekDates.filter((d) => !held.has(d));
    // THE CEILING, added 2026-08-19 (session koenig, P1, promise ledger job
    // 3). The generator has always computed calorieOverDays, but into a
    // TRANSIENT build report that is rendered once and then gone. Nothing
    // persisted it and nothing recomputed it, so a breach created by an EDIT
    // was invisible: marking two slots as dining swipes put 2026-08-19 at
    // 4,055 kcal against a 3,885 ceiling and no screen in the app said so.
    // P1 promises the check is re-run after every edit and that a miss is said
    // out loud, and a floor-only counter can only ever keep half that promise.
    const ceilings = enforcedCeilings(targets?.macros);
    let cal = 0;
    let prot = 0;
    let calShort = 0;
    let protShort = 0;
    let calOver = 0;
    let protOver = 0;
    let bought = 0;
    for (const d of dates) {
      const t = dayTotals(current.entries, byId, d);
      const b = dayBought(current.entries, byId, d);
      cal += t.calories;
      prot += t.protein;
      bought += b;
      if (t.calories < (subsystems.floors.calories ?? 0)) calShort++;
      // FLOORS read what he EATS (health): a swipe genuinely feeds him.
      // The protein CEILING reads what the list BOUGHT (money). They are
      // different questions and must not share a number. See plan.js
      // dayBought.
      if (t.protein < (subsystems.floors.protein ?? 0)) protShort++;
      if (t.calories > ceilings.calories) calOver++;
      if (ceilings.protein != null && b > ceilings.protein) protOver++;
    }
    const days = Math.max(1, dates.length);
    subsystems.floors = {
      ...subsystems.floors,
      avgCalories: Math.round(cal / days),
      avgProteinG: Math.round(prot / days),
      // what the GROCERY LIST paid for, which is the number the protein
      // ceiling governs. avgProteinG above is what he EATS, swipes included.
      // They differ by the whole swipe arbitrage and conflating them is what
      // made a week that cut the bill from 234 g/day to 196 g report as
      // 35 of 35 days failing (2026-08-23).
      avgBoughtProteinG: Math.round(bought / days),
      calorieShortDays: calShort,
      proteinShortDays: protShort,
      calorieOverDays: calOver,
      calorieCeiling: Math.round(ceilings.calories),
      // null is meaningful and is rendered as such: no profile ceiling means
      // over-delivered protein is unconstrained, and P5 calls that a budget
      // leak, so the absence has to be visible rather than merely absent
      proteinCeiling: ceilings.protein,
      proteinOverDays: ceilings.protein == null ? null : protOver,
      liveDays: dates.length,
    };
  }

  // away/swipe credit (7.11, P5): a manifest composed before the engine
  // reported this (or recomposed from a stored engine half) derives the
  // credit from the plan as it stands — see awayBackfill.
  if (!subsystems.away && current) {
    subsystems.away = awayBackfill(current, todayIso);
  }

  // LEFTOVERS (P7, 2026-08-19). The batch note has always told the cook that
  // "the plan has already scheduled it as leftovers"; nothing linked a pot to
  // the later slot that eats it, so neither the no-orphans clause nor the
  // safe-window clause had anything to answer to. Derived, never stored: a
  // stored link is a second copy of the plan that can disagree with the plan.
  // It reports unconditionally, including "no plan to read", because the
  // registry test's whole job is that a subsystem can never go quiet.
  const led = current
    ? leftoverLedger(/** @type {any} */ (current), new Map(recipes.map((r) => [r.id, r])))
    : { cooks: [], orphans: [], reCooked: [] };
  subsystems.leftovers = {
    batchCooks: led.cooks.length,
    leftoverSlots: led.cooks.reduce((n, c) => n + Math.max(0, c.eats.length - 1), 0),
    // a CONTAINER is a whole serving nobody eats. Sub-serving remainders are
    // the arithmetic of fractional plates, not food going bad, and calling
    // them waste would make the number unreadable and then ignored.
    orphanContainers: led.orphans.filter((o) => o.servings >= 1).length,
    orphanServings: Math.round(led.orphans.reduce((s2, o) => s2 + o.servings, 0) * 100) / 100,
    pastWindow: led.reCooked.length,
    readPlan: Boolean(current),
  };

  // SWAP TO FIT (P5). Set by the generate path, which is the only place that
  // can run it, and defaulted here so the registry can never find it silent.
  // A budget pass that did not run has to say WHY it did not run: "no store
  // chosen" and "the week fits" are opposite facts and must not render alike.
  if (!subsystems.swapToFit) {
    subsystems.swapToFit = {
      ran: false,
      fits: null,
      swaps: 0,
      reason: "no fit pass has run on this plan yet (generate to price the week)",
    };
  }

  // fixedSlots (P3, spec 2026-08-25). Defaulted here so the registry can
  // never find it silent: "no slot is fixed" and "the fixed pick fell back"
  // are different facts, and only the engine can tell them apart.
  subsystems.fixedSlots = {
    declared: 0,
    applied: [],
    misses: [],
    snackPortable: false,
    snackPortableRelaxed: false,
    snackWeekly: false,
    weeklySnackId: null,
    snackWeeklyRelaxed: false,
    dinnerAnchor: false,
    dinnerAnchorRelaxed: false,
    ...subsystems.fixedSlots,
  };

  // P6, THE HOUSEHOLD. Defaulted here so the registry can never find it
  // silent; the generate path fills the capacity half, which needs the pantry.
  if (!subsystems.household) subsystems.household = {};
  subsystems.household = {
    capacityChecked: false,
    fits: true,
    over: [],
    drainDownIso: null,
    daysAfterDeparture: 0,
    headId: null,
    members: 0,
    ...subsystems.household,
  };

  // plating (synth.js): PARKED by council 2026-08-12, unparked 2026-08-19 on
  // David's word, and rolling out one recipe at a time exactly as the council
  // designed. The tag IS the rollout mechanism, so the manifest keeps saying
  // how far it has got — an engine nobody counts is how this one went dark
  // for a week in the first place.
  const plated = recipes.filter((r) => r.assembly === "plated").length;
  subsystems.plating = {
    status:
      plated === 0
        ? "live but no recipe is tagged yet: every plate is a pan fraction"
        : "live, rolling out by tag",
    platedRecipes: plated,
    bankRecipes: recipes.length,
  };

  // weight trend: the calibration signal (7-day rolling average). This is
  // weightTrend's one production caller; when the data is missing the line
  // says so instead of the engine sitting silent.
  const phase = targets?.phase === "loss" ? "loss" : "gain";
  const trend = weightTrend(dailyDays ?? [], todayIso, phase);
  const weighIns = (dailyDays ?? []).filter(
    (d) => typeof d.weight === "number" && d.date <= todayIso,
  );
  const latest = weighIns.length > 0 ? weighIns[weighIns.length - 1] : null;
  subsystems.weightTrend = {
    verdict: trend.verdict,
    lbPerWeek: trend.lbPerWeek,
    weighIns: weighIns.length,
    latest: latest ? { date: latest.date, weight: latest.weight } : null,
  };

  // protein against the Morton band, in g/kg, using the latest weigh-in.
  // Grams-vs-floor alone reads over-delivery as success; g/kg is the unit
  // the target was derived in. No weigh-in = no g/kg, said plainly.
  const proteinTarget = Number(targets?.macros?.protein) || 0;
  // subsystems.floors, not engine.floors: the recompute above may have
  // corrected the delivered average against the post-swap plan
  const deliveredG = Number(subsystems.floors?.avgProteinG) || null;
  const kg = latest && latest.weight > 0 ? latest.weight / 2.20462 : null;
  subsystems.protein = {
    targetG: proteinTarget,
    deliveredG,
    // Derived, not read raw. `proteinFloor` was DELETED from targets.json on
    // 2026-08-19 when the council made `protein` itself the floor, and a bare
    // read of the dead field made this report a 0 g protein floor on the Plan
    // tab, on the same day the number was re-ratified. enforcedFloors() is the
    // one place that knows a written floor wins and otherwise one is derived,
    // and weekbuilder.js already goes through it.
    floorG: enforcedFloors(targets?.macros).protein,
    lastReviewed: targets?.lastReviewed ?? null,
    gPerKg: kg ? Math.round((proteinTarget / kg) * 100) / 100 : null,
    deliveredGPerKg: kg && deliveredG ? Math.round((deliveredG / kg) * 100) / 100 : null,
    mortonBand: [MORTON_LO, MORTON_HI],
    note: kg
      ? undefined
      : "no bodyweight on file — g/kg unavailable, weigh in to arm the calibration signal",
  };

  // floors carry their review date: a floor is trusted, so a stale floor is
  // worse than a stale bonus (Attia, council 2026-08-18)
  if (subsystems.floors) {
    subsystems.floors = { ...subsystems.floors, lastReviewed: targets?.lastReviewed ?? null };
  }

  // cooked-over-planned, up to the last 4 weeks (Gardner's gate: no
  // philosophy work ships before this number renders)
  let done = 0;
  let total = 0;
  for (const { weekId, plan } of recentPlans ?? []) {
    if (!plan) continue;
    const a = weekAdherence({ plan: /** @type {any} */ (plan), weekId, today: todayIso });
    done += a.cooked.done;
    total += a.cooked.total;
  }
  subsystems.adherence = {
    cookedOverPlanned: total > 0 ? `${done}/${total}` : "0/0",
    weeksCounted: (recentPlans ?? []).filter((p) => p.plan).length,
    note: total === 0 ? "no cooked confirmations recorded yet — tap COOKED on meals" : undefined,
  };

  return {
    generatedAt: todayIso,
    subsystems,
    // drift detection: the fingerprint of the entries this report describes.
    // A view comparing it against the live plan's fingerprint can say "plan
    // has changed since this report" instead of letting the report go stale
    // silently (P4-new fluid week; PF.1).
    fingerprint: current ? planFingerprint(current) : null,
  };
}

/**
 * Re-derive a STORED manifest against the plan as it now stands.
 *
 * P1 promises its numbers are "re-checked after every edit... and where it
 * cannot, the app says so out loud instead of quietly missing," and until
 * 2026-08-19 nothing in the app did that. Generation composed a manifest and
 * every subsequent edit left it describing a week that no longer existed: two
 * slots switched to dining swipes put 2026-08-19 at 4,055 kcal against a 3,885
 * ceiling, and the stored report still reported the generated week.
 *
 * This is called from the ONE plan write point (main.js `updatePlan`) rather
 * than from each handler, deliberately. A per-handler fix is correct only
 * until somebody adds the eleventh handler, and the whole class of bug this
 * file exists to kill is "the engine was fine, nobody was watching."
 *
 * @param {{ generatedAt?: string, subsystems?: Record<string, any> } | null | undefined} manifest
 * @param {{ plan: Record<string, any>, targets: Record<string, any> | null,
 *   recipes: Record<string, any>[], dailyDays: Record<string, any>[], todayIso: string }} ctx
 * @returns {Record<string, any> | null | undefined} the refreshed manifest, or
 *   the input untouched when there is nothing to refresh
 */
export function remanifest(manifest, { plan, targets, recipes, dailyDays, todayIso }) {
  // a plan that was never generated has no manifest, and inventing one here
  // would fill the Plan tab with "REPORTED NOTHING" lines about engines that
  // were never asked to run
  if (!manifest?.subsystems || !plan?.week) return manifest;
  const next = composeManifest({
    engine: manifest.subsystems,
    targets,
    recipes,
    dailyDays,
    recentPlans: [{ weekId: plan.week, plan }],
    todayIso,
  });
  // ADHERENCE is the one subsystem that reads weeks this call did not load.
  // Recomputing it from the current week alone would silently change what the
  // number MEANS, turning "cooked 1 of 79 planned meals over 4 weeks" into a
  // one-week figure wearing the same label. Keep the last full compose's
  // answer; the next GENERATE recomputes it across all four weeks.
  if (manifest.subsystems.adherence) next.subsystems.adherence = manifest.subsystems.adherence;
  return next;
}

/**
 * Order-independent fingerprint of what the plan actually serves: recipe,
 * servings, est macros, and out-ness per slot. Cooked marks and pins don't
 * change what the manifest reported about macros, so they are excluded on
 * purpose. DERIVED table entries are excluded too (reviewer finding 3): they
 * exist on the merged view plan but are stripped before persist, so keeping
 * them would make drift depend on whether a device re-derived them
 * byte-identically at render time — a standing false alarm on table weeks.
 * @param {{ entries?: Record<string, any>[] } | null | undefined} plan
 * @returns {string}
 */
export function planFingerprint(plan) {
  return (plan?.entries ?? [])
    .filter((e) => !e.table)
    .map(
      (e) =>
        `${e.date}|${e.slot}|${e.recipeId ?? ""}|${e.servings ?? ""}|${e.out ? "out" : ""}|${e.estCalories ?? ""}|${e.estProtein ?? ""}`,
    )
    .sort()
    .join(";");
}

/**
 * Has the plan changed since its manifest was composed? Null when the
 * manifest predates fingerprints (never claim drift it cannot prove).
 * @param {{ fingerprint?: string | null } | null | undefined} manifest
 * @param {{ entries?: Record<string, any>[] } | null | undefined} plan
 * @returns {boolean | null}
 */
export function manifestDrifted(manifest, plan) {
  if (!manifest || manifest.fingerprint == null) return null;
  return manifest.fingerprint !== planFingerprint(plan);
}

/**
 * The away/swipe credit derived from a plan's own entries (7.11, P5), for
 * manifests that predate the engine reporting it. Live-day scope matches the
 * engine's awayCredit (future, non-held) so a Wednesday view never counts
 * Monday's spent swipes. cookedNeedRatio stays null on purpose: only a real
 * GENERATE aims the cooked week at the remaining need, and the rendered line
 * says so instead of pretending.
 * @param {{ entries?: Record<string, any>[] } | null | undefined} plan
 * @param {string} todayIso
 * @returns {Record<string, any>}
 */
export function awayBackfill(plan, todayIso) {
  const entries = Array.isArray(plan?.entries) ? plan.entries : [];
  const held = new Set(entries.filter((e) => e.occasion).map((e) => e.date));
  const outs = entries.filter((e) => e.out && e.date >= todayIso && !held.has(e.date));
  return {
    slots: outs.length,
    swipeSlots: outs.filter((e) => e.currency).length,
    creditCalories: outs.reduce((s, e) => s + (e.estCalories ?? 0), 0),
    creditProtein: outs.reduce((s, e) => s + (e.estProtein ?? 0), 0),
    cookedNeedRatio: null,
    fullNeedRatio: null,
  };
}

/**
 * Render-ready lines, one per subsystem, in registry order. A registered
 * subsystem with no entry renders as the failure it is — except `away` when
 * a plan is supplied: a manifest STORED before 2026-08-19 never carried it,
 * so the view derives the credit from the plan instead of flashing a false
 * dark-engine alarm on every pre-upgrade week (live-verified 2026-08-19).
 * @param {{ subsystems: Record<string, any> } | null | undefined} manifest
 * @param {{ entries?: Record<string, any>[] } | null | undefined} [plan]
 * @param {string} [todayIso]
 * @returns {{ key: string, text: string, missing: boolean }[]}
 */
export function manifestLines(manifest, plan = null, todayIso = "") {
  return SUBSYSTEMS.map((key) => {
    let s = manifest?.subsystems?.[key];
    if (!s && key === "away" && plan && todayIso) s = awayBackfill(plan, todayIso);
    if (!s)
      return { key, text: "REPORTED NOTHING — this is the dark-engine failure", missing: true };
    return { key, text: lineFor(key, s), missing: false };
  });
}

/**
 * @param {string} key
 * @param {Record<string, any>} s
 * @returns {string}
 */
function lineFor(key, s) {
  switch (key) {
    case "budget":
      return `mode ${s.mode}, ${s.cheapTagged} of ${s.eligibleRecipes} eligible recipes cheap-tagged`;
    case "useSoon":
      return s.matchedFoods > 0
        ? `${s.matchedFoods} expiring foods steered the committees (${s.datedPantryRows} dated pantry rows)`
        : `matched 0 foods (${s.datedPantryRows} dated pantry rows — scan a shelf to arm it)`;
    case "philosophy":
      return `${s.groupsTargeted} food groups targeted, ${s.weeklyGapsOpen} weekly gaps open`;
    case "macroTopUp":
      return s.ranButDidNotReport
        ? "ran but did not report"
        : `budget ${s.budget}, snack pool ${s.poolBefore}→${s.poolAfter}${s.restricted ? " (overlap/cheap only)" : ""}${s.relaxed ? " (restriction relaxed: too few candidates)" : ""}, +${s.snackServingsAdded ?? 0} snack servings`;
    case "away":
      // 7.11 (P5): the swipe arbitrage's report — with credits, the cooked
      // week aimed at the REMAINING need; without, it says so plainly
      return (
        (s.slots > 0
          ? `${s.slots} away slot${s.slots === 1 ? "" : "s"} (${s.swipeSlots} swipe) credit ${s.creditProtein} g protein / ${s.creditCalories} kcal — ${s.cookedNeedRatio != null ? `cooked week aims at the remaining need (density ${s.cookedNeedRatio} vs ${s.fullNeedRatio} full)` : "GENERATE again to aim the cooked week at the remaining need"}`
          : "no away/swipe slots — cooked week aims at the full need") +
        // council 2026-08-26: say when the density instrument is pinned at
        // its clamp rail instead of printing a plausible number silently
        (s.needRatioClamped ? " ⚠️ density CLAMPED at its rail (raw value out of range)" : "")
      );
    case "floors":
      // both directions, always. A floors-only line is how a week sat over
      // its ceiling in plain sight (P1, 2026-08-19).
      return (
        `${s.calories} kcal / ${s.protein} g floors (reviewed ${s.lastReviewed ?? "NEVER"}), ` +
        `short days: ${s.calorieShortDays} kcal / ${s.proteinShortDays} protein of ${s.liveDays}` +
        (s.calorieCeiling
          ? `, OVER the ${s.calorieCeiling} kcal ceiling on ${s.calorieOverDays ?? 0} day${(s.calorieOverDays ?? 0) === 1 ? "" : "s"}`
          : "") +
        (s.proteinCeiling
          ? `, over the ${s.proteinCeiling} g protein ceiling on ${s.proteinOverDays ?? 0}`
          : s.proteinOverDays === null
            ? ", no protein ceiling set (over-delivery is unconstrained)"
            : "") +
        (s.avgCalories ? `, delivering ~${s.avgCalories} kcal/day avg` : "") +
        // council 2026-08-26: the trim's give-up is never silent again
        (s.proteinAimG ? `; trim aims at ${s.proteinAimG} g bought` : "") +
        (s.trimResidualDays > 0
          ? ` — COULD NOT REACH IT on ${s.trimResidualDays} day${s.trimResidualDays === 1 ? "" : "s"} (${(s.trimResiduals ?? []).map((/** @type {any} */ r) => `${r.date} +${r.residual}g`).join(", ")})`
          : "")
      );
    case "household":
      // P6. A kitchen that has declared nothing says so, because "no capacity
      // declared" and "the week fits" are opposite facts.
      return (
        (s.capacityChecked
          ? s.fits
            ? "the week fits the declared storage"
            : `OVER declared storage: ${(s.over ?? []).map((/** @type {any} */ o) => `${o.where} by ${o.byL} L`).join(", ")}`
          : "no fridge, freezer or pantry volume declared, so capacity is unchecked") +
        (s.drainDownIso
          ? `; draining down to ${s.drainDownIso}, ${s.daysAfterDeparture} day${s.daysAfterDeparture === 1 ? "" : "s"} past it left unplanned`
          : "; no departure date, so nothing is pushed to eat its stock") +
        (s.headId ? `; head ${s.headId}, ${s.members} member${s.members === 1 ? "" : "s"}` : "; no head named")
      );
    case "leftovers":
      // both halves of P7's done test, in one line: which pots feed which
      // later slots, and whether anything was left with nobody to eat it or
      // scheduled past the day it stops being safe
      if (!s.readPlan) return "no plan on file yet, so nothing is scheduled as leftovers";
      return s.batchCooks === 0
        ? "no batch cooks this week, so nothing is planned as leftovers"
        : `${s.batchCooks} batch cook${s.batchCooks === 1 ? "" : "s"} feeding ${s.leftoverSlots} later slot${s.leftoverSlots === 1 ? "" : "s"}, ` +
          `${s.orphanContainers} orphan container${s.orphanContainers === 1 ? "" : "s"}` +
          (s.orphanServings > 0 ? ` (${s.orphanServings} servings unclaimed)` : "") +
          `, ${s.pastWindow} slot${s.pastWindow === 1 ? "" : "s"} past the safe window`;
    case "swapToFit":
      if (!s.ran) return `budget fit did not run: ${s.reason}`;
      return (
        `$${s.startedAt?.toFixed?.(2) ?? s.startedAt} eaten becomes $${s.eaten?.toFixed?.(2) ?? s.eaten} ` +
        `against a $${s.budget} budget at ${s.store}, ${s.swaps} swap${s.swaps === 1 ? "" : "s"}: ` +
        (s.fits ? "FITS" : `OVER by $${s.over?.toFixed?.(2) ?? s.over}`)
      );
    case "fixedSlots":
      // P3 (spec 2026-08-25). A declared fix that fell back to a committee is
      // the one state that must never render like "nothing declared".
      return (
        (s.declared === 0
          ? "no slot is fixed to one recipe"
          : `${(s.applied ?? []).length ? `fixed daily: ${(s.applied ?? []).join(", ")}` : "declared but none applied"}${(s.misses ?? []).length ? `; FELL BACK to a committee — ${s.misses.join("; ")}` : ""}`) +
        (s.snackPortable
          ? s.snackPortableRelaxed
            ? "; portable-only snacks asked for but NO recipe carries portable: true — full pool used"
            : "; snacks drawn from portable-only pool"
          : "") +
        (s.snackWeekly
          ? s.weeklySnackId
            ? `; ONE snack all week: ${s.weeklySnackId}${s.snackWeeklyRelaxed ? " (a floor it couldn't close reopened the full pool)" : ""}`
            : "; weekly snack style declared but no snack could be picked"
          : "") +
        (s.dinnerAnchor
          ? s.dinnerAnchorRelaxed
            ? "; anchored dinners asked for but the filter emptied the pool — relaxed"
            : "; solo-planned dinners always carry a protein anchor (shared tables screen separately)"
          : "")
      );
    case "plating":
      return `plating ${s.status}; ${s.platedRecipes} of ${s.bankRecipes} recipes tailor per person`;
    case "weightTrend":
      return s.verdict === "no-data" || s.verdict === "building"
        ? `${s.verdict}: ${s.weighIns} weigh-ins on file${s.latest ? `, last ${s.latest.date} (${s.latest.weight} lb)` : ""}`
        : `${s.verdict}, ${s.lbPerWeek > 0 ? "+" : ""}${Math.round(s.lbPerWeek * 100) / 100} lb/week (7-day rolling)`;
    case "adherence":
      return `cooked ${s.cookedOverPlanned} planned meals, last ${s.weeksCounted} weeks${s.note ? ` — ${s.note}` : ""}`;
    case "protein": {
      const delivered =
        s.deliveredG != null
          ? `, plan DELIVERS ${s.deliveredG} g/day${s.deliveredGPerKg != null ? ` (${s.deliveredGPerKg} g/kg${s.deliveredGPerKg > s.mortonBand[1] ? ", ABOVE the band" : ""})` : ""}`
          : "";
      return s.gPerKg != null
        ? `target ${s.targetG} g = ${s.gPerKg} g/kg vs Morton band ${s.mortonBand[0]}–${s.mortonBand[1]}${delivered} (reviewed ${s.lastReviewed ?? "NEVER"})`
        : `target ${s.targetG} g${delivered} (reviewed ${s.lastReviewed ?? "NEVER"}) — ${s.note}`;
    }
    default:
      return JSON.stringify(s);
  }
}
