// THE BRIGADE RUN, IN PLAIN LINES. One wording for the two places a run is
// reported (the Table tab's SET THIS WEEK and the Plan tab's GENERATE, which
// runs the brigade first since 2026-09-05), so the two screens can never
// describe the same run differently. One line per fact: a 7-day 2-person
// report as one semicolon-joined sentence was an unreadable wall on a phone
// (Final Gate, 2026-08-30).
import { datesOfWeek } from "../lib/plan.js";
import { parseLocalIso } from "../lib/dates.js";

/**
 * @param {{
 *   made: number,
 *   thin: { slot: string, available: number }[],
 *   report?: { date: string, seatId: string, dayKcal: number, dayProtein: number, share?: number, status: string, guest?: boolean }[],
 *   swept?: { swaps: number, saved: number },
 *   swiped?: { date: string, slot: string }[],
 *   assumed?: { id: string, slot: string }[],
 *   notes?: string[],
 *   nights?: { cook: string[], leftover: { date: string, from: string }[], uncovered: string[] },
 *   outOfRange?: boolean,
 *   from?: string,
 *   until?: string,
 * }} result what onRunBrigade resolved to
 * @param {{ runWeek: string, todayIso: string, nameOf: (id: string) => string }} ctx
 * @returns {string[]}
 */
export function brigadeRunLines(result, { runWeek, todayIso, nameOf }) {
  const { made, thin, report, swept, swiped, assumed, notes, nights, outOfRange, from, until } =
    result;
  /** @type {string[]} */
  const lines = [];
  const day = (/** @type {string} */ iso) =>
    parseLocalIso(iso).toLocaleDateString([], { weekday: "short" });
  if (outOfRange) {
    lines.push(
      `This brigade runs ${from} to ${until}, and the Plan tab is on a different week. Flip Plan to a week inside that span, then set the week — nothing was set just now.`,
    );
    return lines;
  }
  const short = thin.filter((t) => t.available === 0).map((t) => t.slot);
  if (short.length > 0 && made === 0) {
    lines.push(
      `No ${short.join(" or ")} works for everyone in this brigade. Nothing was set. Widen the bank or check the avoid lists.`,
    );
    return lines;
  }
  if (made === 0) {
    lines.push("This week's shared meals are already set. PICK DIFFERENT MEALS changes them.");
  } else {
    const dates = datesOfWeek(runWeek);
    const range = `${parseLocalIso(dates[0] ?? todayIso).toLocaleDateString([], { month: "short", day: "numeric" })} – ${parseLocalIso(dates[6] ?? todayIso).toLocaleDateString([], { month: "short", day: "numeric" })}`;
    lines.push(`Set ${made} shared ${made === 1 ? "meal" : "meals"} for ${range}.`);
  }
  // COOK NIGHTS (2026-09-05): which nights cook, which eat leftovers of which
  // pot, and any night that had to cook because no pot could safely reach it
  if (nights && (nights.cook.length > 0 || nights.leftover.length > 0)) {
    const cookText = nights.cook.map(day).join(", ");
    const leftText = nights.leftover
      .map((n) => `${day(n.date)} eats ${day(n.from)}'s pot`)
      .join(" · ");
    lines.push(
      `🍳 Cook ${cookText}${leftText ? `. Leftovers: ${leftText}.` : "."}${
        nights.uncovered.length > 0
          ? ` ${nights.uncovered.map(day).join(", ")} had no pot inside its safe window, so ${nights.uncovered.length === 1 ? "it cooks" : "they cook"} after all.`
          : ""
      }`,
    );
  }
  for (const n of notes ?? []) lines.push(`ⓘ ${n}`);
  // THE DAY REPORT (P1, 2026-08-30): the composer's per-seat verdicts, one
  // line per fact. PLANNED numbers from recipe estimates — arithmetic the app
  // guarantees, never a measurement of what anyone eats — and a miss names its
  // DIRECTION, because too much and too little demand opposite reactions.
  const rows = report ?? [];
  const offBand = rows.filter((r) => r.status !== "band");
  if (rows.length > 0 && offBand.length === 0) {
    lines.push(
      "Every planned day lands in everyone's calorie and protein band (planned from recipe estimates).",
    );
  }
  if (swept && swept.swaps > 0) {
    lines.push(
      `💸 Cost sweep: ${swept.swaps} swap${swept.swaps === 1 ? "" : "s"} to cheaper dishes, ~$${swept.saved.toFixed(2)} less to cook this week, every band kept.`,
    );
  }
  const wordFor = (/** @type {string} */ status) =>
    status === "floor"
      ? "under target but above their own minimum"
      : status === "over"
        ? "over — even the smallest plates exceed their ceiling"
        : status === "no-targets"
          ? "no targets on file — seated at standard portions"
          : "short — the shared menu cannot reach their target";
  const SHOWN = 6;
  for (const r of offBand.slice(0, SHOWN)) {
    const scope = (r.share ?? 1) < 0.95 ? "planned brigade meals" : "planned";
    const who = `${nameOf(r.seatId)}${r.guest ? " (guest)" : ""}`;
    lines.push(
      r.status === "no-targets"
        ? `${who}: ${wordFor(r.status)}.`
        : `${who} ${r.date.slice(5)}: ~${r.dayKcal} kcal / ${r.dayProtein} g ${scope} (${wordFor(r.status)}).`,
    );
  }
  if (offBand.length > SHOWN) lines.push(`…and ${offBand.length - SHOWN} more like these.`);
  if ((swiped ?? []).length > 0) {
    const n = /** @type {any[]} */ (swiped).length;
    lines.push(
      `🎫 Your ${n} swipe ${n === 1 ? "lunch is" : "lunches are"} on your plan — 🍽 PICK MY TRAY on the Plan tab plans each plate.`,
    );
  }
  for (const a of assumed ?? []) {
    lines.push(
      `🎫 Assumes ${nameOf(a.id)}'s daily swipe ${a.slot} — their day lands once they run their own GENERATE, which places the swipes on their plan.`,
    );
  }
  const tight = thin.filter((t) => t.available > 0);
  if (tight.length > 0) {
    lines.push(
      `Only ${tight
        .map((t) => `${t.available} ${t.slot} ${t.available === 1 ? "recipe" : "recipes"}`)
        .join(", ")} suit everyone, so the week repeats itself.`,
    );
  }
  return lines;
}

/** Weekday letters for a cookDays set, e.g. "Sun · Mon · Fri · Sat". */
export function cookDaysLabel(/** @type {number[] | undefined} */ cookDays) {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (!Array.isArray(cookDays) || cookDays.length === 0 || cookDays.length === 7) return "";
  return names.filter((_, i) => cookDays.includes(i)).join(" · ");
}
