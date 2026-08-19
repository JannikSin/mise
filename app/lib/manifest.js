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
import { datesOfWeek, dayTotals } from "./plan.js";

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
  "floors",
  "plating",
  "weightTrend",
  "adherence",
  "protein",
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
    let cal = 0;
    let prot = 0;
    let calShort = 0;
    let protShort = 0;
    for (const d of dates) {
      const t = dayTotals(current.entries, byId, d);
      cal += t.calories;
      prot += t.protein;
      if (t.calories < (subsystems.floors.calories ?? 0)) calShort++;
      if (t.protein < (subsystems.floors.protein ?? 0)) protShort++;
    }
    const days = Math.max(1, dates.length);
    subsystems.floors = {
      ...subsystems.floors,
      avgCalories: Math.round(cal / days),
      avgProteinG: Math.round(prot / days),
      calorieShortDays: calShort,
      proteinShortDays: protShort,
      liveDays: dates.length,
    };
  }

  // plating (synth.js): deliberately inert by council 2026-08-12, kill
  // review 2026-11-15. The manifest keeps saying so, out loud, so the gate
  // can never go dark again.
  const plated = recipes.filter((r) => r.assembly === "plated").length;
  subsystems.plating = {
    status: "inert by council 2026-08-12, kill review 2026-11-15",
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
    floorG: Number(targets?.macros?.proteinFloor) || 0,
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
 * Render-ready lines, one per subsystem, in registry order. A registered
 * subsystem with no entry renders as the failure it is.
 * @param {{ subsystems: Record<string, any> } | null | undefined} manifest
 * @returns {{ key: string, text: string, missing: boolean }[]}
 */
export function manifestLines(manifest) {
  return SUBSYSTEMS.map((key) => {
    const s = manifest?.subsystems?.[key];
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
    case "floors":
      return `${s.calories} kcal / ${s.protein} g floors (reviewed ${s.lastReviewed ?? "NEVER"}), short days: ${s.calorieShortDays} kcal / ${s.proteinShortDays} protein of ${s.liveDays}${s.avgCalories ? `, delivering ~${s.avgCalories} kcal/day avg` : ""}`;
    case "plating":
      return `${s.status}; ${s.platedRecipes} of ${s.bankRecipes} recipes tagged plated`;
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
