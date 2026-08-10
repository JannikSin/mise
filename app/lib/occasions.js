// OCCASIONS — dated overrides that take days off the generator.
//
// The gap this closes (David, 2026-08-10): every KIND of situation in Mise
// used to be a code branch. Numbers and avoid-lists were data you could edit;
// everything else — a medical prep, a holiday, a travel stretch, a sick week —
// had no data shape at all, so the only way to express one was new code, which
// meant a Claude session every single time. An occasion is the one data shape
// that swallows the whole class: a name, a date range, whose days it owns, and
// a fixed script per day.
//
// The rule David set: an occasion is FIXED, not generated. On a day an
// occasion owns, the week generator hands off completely (weekbuilder.js reads
// `entry.occasion` and holds the date exactly like a day already eaten), and
// the person's seat comes off every shared table those days. No committee, no
// macro top-up, no Daily Dozen floor. A clear-liquid prep day that the
// generator "helped" by stacking four snacks onto is a failed colonoscopy.
//
// SAFETY, non-negotiable: presets in this file are hand-written, versioned,
// and reviewed. They are never model-generated and never model-edited. A
// medical preset carries a `disclaimer` the UI must show every time, because
// the letter from the actual clinic outranks every line in this file.

/**
 * @typedef {{
 *   slot: string,
 *   recipeId?: string,
 *   freeText?: string,
 *   servings?: number,
 *   note?: string
 * }} OccasionItem one thing eaten (or done) at one slot on one day
 *
 * @typedef {{
 *   offset: number,
 *   label: string,
 *   note?: string,
 *   items: OccasionItem[]
 * }} PresetDay a day of a preset, `offset` days from the anchor date
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   emoji: string,
 *   blurb: string,
 *   anchorLabel: string,
 *   medical?: boolean,
 *   disclaimer?: string,
 *   days: PresetDay[]
 * }} OccasionPreset
 *
 * @typedef {{
 *   label: string,
 *   note?: string,
 *   items: OccasionItem[]
 * }} OccasionDay
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   emoji: string,
 *   presetId?: string,
 *   profileId: string,
 *   from: string,
 *   to: string,
 *   anchor?: string,
 *   disclaimer?: string,
 *   offTables: boolean,
 *   days: Record<string, OccasionDay>,
 *   createdAt?: string
 * }} Occasion
 */

/** ISO date `days` after `iso`, negative going back. Pure, UTC-parsed. */
export function shiftIso(/** @type {string} */ iso, /** @type {number} */ days) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The preset bank. Each entry is a whole situation, expressed relative to one
// anchor date the user picks. Add to this list to add a situation; nothing
// else in the app needs to change.
// ---------------------------------------------------------------------------

/** @type {OccasionPreset[]} */
export const PRESETS = [
  {
    id: "colonoscopy",
    name: "Colonoscopy prep",
    emoji: "⚕",
    blurb: "Three low-residue days, then clear liquids only the day before.",
    anchorLabel: "Procedure date",
    medical: true,
    disclaimer:
      "This is the standard protocol. The letter from your GI office overrides every line of it — " +
      "prep timing, the prep solution, and when to stop drinking are theirs to set, not this app's. " +
      "Nothing red, purple or blue on the clear-liquid day: the dye reads as blood on the camera.",
    days: [
      {
        offset: -3,
        label: "Low residue",
        note: "No nuts, seeds, popcorn, corn, raw vegetables, beans, whole grains, skins or dried fruit. White bread and white rice are RIGHT today, not a lapse.",
        items: [
          { slot: "breakfast", recipeId: "white-toast-scrambled-eggs", servings: 1 },
          { slot: "lunch", recipeId: "white-rice-plain-chicken", servings: 1 },
          { slot: "dinner", recipeId: "broiled-white-fish-white-rice", servings: 1 },
          { slot: "snack", recipeId: "canned-peaches-cottage-cheese", servings: 1 },
        ],
      },
      {
        offset: -2,
        label: "Low residue",
        note: "Same rules. Stop any fiber supplement now unless your office said otherwise.",
        items: [
          { slot: "breakfast", recipeId: "cream-of-wheat-plain", servings: 1 },
          { slot: "lunch", recipeId: "white-bread-turkey-sandwich-plain", servings: 1 },
          { slot: "dinner", recipeId: "plain-pasta-butter-parmesan", servings: 1 },
          { slot: "snack", recipeId: "plain-crackers-mild-cheese", servings: 1 },
        ],
      },
      {
        offset: -1,
        label: "Clear liquids only",
        note: "Nothing solid, all day. Nothing red, purple or blue. Drink more than feels necessary — the prep works better hydrated, and the day is long. Prep solution in the evening per your letter.",
        items: [
          { slot: "breakfast", recipeId: "clear-broth-mug", servings: 1 },
          { slot: "breakfast", recipeId: "plain-tea-or-black-coffee", servings: 1 },
          { slot: "lunch", recipeId: "clear-juice-glass", servings: 1 },
          { slot: "lunch", recipeId: "lemon-gelatin-cup", servings: 1 },
          { slot: "snack", recipeId: "lemon-lime-sports-drink", servings: 2 },
          { slot: "dinner", recipeId: "clear-broth-mug", servings: 1 },
          { slot: "dinner", recipeId: "lemon-ice-pop", servings: 1 },
          {
            slot: "snack",
            freeText: "Bowel prep solution — timing and dose per your letter",
            note: "Cold, through a straw, chased with a clear liquid. Not food, but it is the whole point of today.",
          },
        ],
      },
      {
        offset: 0,
        label: "Procedure day",
        note: "Second prep dose early if your letter says so, then nothing by mouth from the time they gave you. Somebody drives you home. Eat light after: this is not the day to break a fast on a big meal.",
        items: [
          {
            slot: "breakfast",
            freeText: "Nothing by mouth — per your letter",
            note: "Usually 2 to 4 hours before. Their number wins.",
          },
          { slot: "dinner", recipeId: "clear-broth-mug", servings: 1, note: "Ease back in." },
          { slot: "dinner", recipeId: "white-rice-plain-chicken", servings: 1 },
        ],
      },
      {
        offset: 1,
        label: "Back to normal, gently",
        note: "Fiber comes back today, not in a heap. One normal day and the occasion is done.",
        items: [
          { slot: "breakfast", recipeId: "white-toast-scrambled-eggs", servings: 1 },
          { slot: "lunch", recipeId: "chicken-noodle-soup", servings: 1 },
          { slot: "dinner", recipeId: "white-rice-plain-chicken", servings: 1 },
        ],
      },
    ],
  },
  {
    id: "stomach-bug",
    name: "Stomach bug",
    emoji: "◍",
    blurb: "Three days of bland, back to normal on day four.",
    anchorLabel: "First bad day",
    medical: true,
    disclaimer:
      "Home care, not medical advice. Call a doctor for blood, a fever over 102F, signs of dehydration " +
      "(no urine for 8 hours, dizziness on standing), or anything past 3 days.",
    days: [
      {
        offset: 0,
        label: "Liquids and salt",
        note: "Small sips constantly beats big glasses. Do not chase the calorie target today; it does not matter.",
        items: [
          { slot: "breakfast", recipeId: "clear-broth-mug", servings: 2 },
          { slot: "lunch", recipeId: "lemon-lime-sports-drink", servings: 2 },
          { slot: "dinner", recipeId: "clear-broth-mug", servings: 1 },
          { slot: "snack", recipeId: "lemon-gelatin-cup", servings: 1 },
        ],
      },
      {
        offset: 1,
        label: "Bland solids",
        note: "Eat before you feel ready, in tiny amounts.",
        items: [
          { slot: "breakfast", recipeId: "white-toast-scrambled-eggs", servings: 0.5 },
          { slot: "lunch", recipeId: "white-rice-plain-chicken", servings: 0.5 },
          { slot: "dinner", recipeId: "chicken-noodle-soup", servings: 1 },
          { slot: "snack", recipeId: "clear-broth-mug", servings: 1 },
        ],
      },
      {
        offset: 2,
        label: "Building back",
        items: [
          { slot: "breakfast", recipeId: "cream-of-wheat-plain", servings: 1 },
          { slot: "lunch", recipeId: "white-rice-plain-chicken", servings: 1 },
          { slot: "dinner", recipeId: "chicken-noodle-soup", servings: 1 },
          { slot: "snack", recipeId: "plain-crackers-mild-cheese", servings: 1 },
        ],
      },
    ],
  },
  {
    id: "wisdom-teeth",
    name: "Dental surgery",
    emoji: "◔",
    blurb: "Four days of soft and cold, nothing that needs chewing.",
    anchorLabel: "Surgery date",
    medical: true,
    disclaimer:
      "No straws for a week — suction pulls the clot out and that is dry socket. Nothing hot the first day. " +
      "Your surgeon's instructions outrank this.",
    days: [
      {
        offset: 0,
        label: "Cold and liquid",
        note: "Nothing hot, no straws, no chewing. Cold blunts the swelling.",
        items: [
          { slot: "breakfast", recipeId: "cold-yogurt-cup-plain", servings: 1 },
          { slot: "lunch", recipeId: "cold-protein-smoothie-spoon", servings: 1 },
          { slot: "dinner", recipeId: "clear-broth-mug", servings: 1, note: "Lukewarm, not hot." },
          { slot: "snack", recipeId: "lemon-ice-pop", servings: 2 },
        ],
      },
      {
        offset: 1,
        label: "Soft, still no chewing",
        items: [
          { slot: "breakfast", recipeId: "cream-of-wheat-plain", servings: 1 },
          { slot: "lunch", recipeId: "cold-protein-smoothie-spoon", servings: 1 },
          { slot: "dinner", recipeId: "mashed-potato-plain", servings: 1 },
          { slot: "snack", recipeId: "cold-yogurt-cup-plain", servings: 1 },
        ],
      },
      {
        offset: 2,
        label: "Soft",
        items: [
          { slot: "breakfast", recipeId: "cold-yogurt-cup-plain", servings: 1 },
          { slot: "lunch", recipeId: "chicken-noodle-soup", servings: 1 },
          { slot: "dinner", recipeId: "mashed-potato-plain", servings: 1 },
          { slot: "snack", recipeId: "cold-protein-smoothie-spoon", servings: 1 },
        ],
      },
      {
        offset: 3,
        label: "Soft, warm is fine now",
        items: [
          { slot: "breakfast", recipeId: "cream-of-wheat-plain", servings: 1 },
          { slot: "lunch", recipeId: "chicken-noodle-soup", servings: 1 },
          { slot: "dinner", recipeId: "plain-pasta-butter-parmesan", servings: 1 },
        ],
      },
    ],
  },
  {
    id: "fasting-bloodwork",
    name: "Fasting bloodwork",
    emoji: "◐",
    blurb: "Nothing but water from the night before, then a real breakfast after.",
    anchorLabel: "Draw date",
    medical: true,
    disclaimer:
      "Usually 8 to 12 hours fasting, water allowed. Your lab's number wins. Take prescribed medication " +
      "as normal unless they told you otherwise.",
    days: [
      {
        offset: -1,
        label: "Eat early, then stop",
        note: "Normal food all day, last bite by early evening. Water only after.",
        items: [
          {
            slot: "dinner",
            freeText: "Last meal early — normal food, then water only",
            note: "Count back the hours your lab asked for from the appointment time.",
          },
        ],
      },
      {
        offset: 0,
        label: "Water only until the draw",
        note: "Black coffee is NOT allowed on a true fasting panel unless your lab said so. Bring the real breakfast with you.",
        items: [
          { slot: "breakfast", freeText: "Water only until the draw" },
          { slot: "lunch", recipeId: "white-toast-scrambled-eggs", servings: 1, note: "After." },
        ],
      },
    ],
  },
  {
    id: "travel",
    name: "Travel days",
    emoji: "✈",
    blurb: "Days you are not cooking and not shopping. Nothing gets bought for them.",
    anchorLabel: "First travel day",
    days: [
      {
        offset: 0,
        label: "Travelling",
        note: "Eating out, airport, someone else's kitchen. The list buys nothing for today.",
        items: [
          { slot: "breakfast", freeText: "Away" },
          { slot: "lunch", freeText: "Away" },
          { slot: "dinner", freeText: "Away" },
        ],
      },
    ],
  },
  {
    id: "holiday",
    name: "Holiday meal",
    emoji: "◈",
    blurb: "One day the app stays out of the way entirely.",
    anchorLabel: "The day",
    days: [
      {
        offset: 0,
        label: "Holiday",
        note: "Somebody else's menu. No plan, no list, no targets, no guilt.",
        items: [
          { slot: "breakfast", freeText: "Whatever's going" },
          { slot: "dinner", freeText: "The big meal" },
        ],
      },
    ],
  },
  {
    id: "race-week",
    name: "Race or match day",
    emoji: "▲",
    blurb: "Familiar food only, nothing new, easy on the fiber the day before.",
    anchorLabel: "Race or match date",
    days: [
      {
        offset: -1,
        label: "Day before",
        note: "Nothing you have not eaten before. Lower fiber so nothing surprises you mid-effort.",
        items: [
          { slot: "breakfast", recipeId: "white-toast-scrambled-eggs", servings: 1 },
          { slot: "lunch", recipeId: "plain-pasta-butter-parmesan", servings: 2 },
          { slot: "dinner", recipeId: "white-rice-plain-chicken", servings: 2 },
        ],
      },
      {
        offset: 0,
        label: "Race day",
        note: "Eat what you have practised eating. Nothing new on the day, ever.",
        items: [
          { slot: "breakfast", recipeId: "white-toast-scrambled-eggs", servings: 1 },
          { slot: "snack", recipeId: "lemon-lime-sports-drink", servings: 2 },
          { slot: "dinner", freeText: "Whatever you want" },
        ],
      },
    ],
  },
];

/** @param {string} id */
export function presetById(id) {
  return PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * Turn a preset into a real, dated occasion for one person. The anchor is the
 * one date the user actually knows ("the procedure is Friday"); every day of
 * the preset places itself around it.
 * @param {OccasionPreset} preset
 * @param {string} anchorIso the anchor date, YYYY-MM-DD
 * @param {string} profileId whose days these are
 * @param {{ id?: string, createdAt?: string, offTables?: boolean }} [opts]
 * @returns {Occasion}
 */
export function occasionFromPreset(preset, anchorIso, profileId, opts = {}) {
  /** @type {Record<string, OccasionDay>} */
  const days = {};
  for (const d of preset.days) {
    days[shiftIso(anchorIso, d.offset)] = {
      label: d.label,
      ...(d.note ? { note: d.note } : {}),
      items: d.items.map((i) => ({ ...i })),
    };
  }
  const dates = Object.keys(days).sort();
  return {
    id: opts.id ?? `${preset.id}-${anchorIso}-${profileId}`,
    name: preset.name,
    emoji: preset.emoji,
    presetId: preset.id,
    profileId,
    from: dates[0] ?? anchorIso,
    to: dates[dates.length - 1] ?? anchorIso,
    anchor: anchorIso,
    ...(preset.disclaimer ? { disclaimer: preset.disclaimer } : {}),
    // an occasion takes you off shared tables by default: the house does not
    // eat prep food with you, and a seat you cannot eat still sizes the pot
    // and lands on somebody's shopping list (David, 2026-08-10)
    offTables: opts.offTables ?? true,
    days,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  };
}

/** Every date an occasion owns, sorted. @param {Occasion} o */
export function datesOf(o) {
  return Object.keys(o?.days ?? {}).sort();
}

/**
 * Does this occasion own this date? @param {Occasion} o @param {string} iso
 */
export function covers(o, iso) {
  return Boolean(o?.days?.[iso]);
}

/**
 * The occasion (if any) that owns a date for a given person. Later-created
 * occasions win an overlap, which is the honest reading: you added the newer
 * one knowing the older one was there.
 * @param {Occasion[]} occasions
 * @param {string} iso
 * @param {string} profileId
 * @returns {Occasion | null}
 */
export function occasionOn(occasions, iso, profileId) {
  const hits = (occasions ?? []).filter((o) => o.profileId === profileId && covers(o, iso));
  return hits[hits.length - 1] ?? null;
}

/**
 * The plan entries an occasion places. Every one is `pinned` (so nothing
 * clears it) and carries `occasion` (so the generator holds the whole date).
 * ids are DETERMINISTIC from the occasion id, date, slot and position, which
 * is what makes re-applying idempotent and two-device merges safe: the same
 * occasion applied twice produces the same ids, so the merge sees one entry,
 * not two.
 * @param {Occasion} o
 * @returns {import("./plan.js").PlanEntry[]}
 */
export function occasionEntries(o) {
  /** @type {import("./plan.js").PlanEntry[]} */
  const out = [];
  for (const date of datesOf(o)) {
    const day = o.days[date];
    if (!day) continue;
    day.items.forEach((item, idx) => {
      out.push({
        id: `occ-${o.id}-${date}-${item.slot}-${idx}`,
        date,
        slot: item.slot,
        ...(item.recipeId ? { recipeId: item.recipeId } : {}),
        ...(item.freeText ? { freeText: item.freeText } : {}),
        servings: item.servings ?? 1,
        pinned: true,
        occasion: o.id,
        occasionName: o.name,
        ...(item.note ? { occasionNote: item.note } : {}),
      });
    });
  }
  return out;
}

/**
 * Apply an occasion to a week's plan: every entry on a day the occasion owns
 * is REPLACED by the occasion's script. Replacing rather than merging is the
 * whole point — a low-residue day with yesterday's lentil soup still on it is
 * not a low-residue day.
 * @param {import("./plan.js").Plan} plan
 * @param {Occasion} o
 * @returns {import("./plan.js").Plan}
 */
export function applyOccasion(plan, o) {
  const owned = new Set(datesOf(o));
  const kept = (plan.entries ?? []).filter((e) => !owned.has(e.date));
  return { ...plan, entries: [...kept, ...occasionEntries(o)] };
}

/**
 * Remove an occasion's entries from a plan. The days come back EMPTY, not
 * regenerated: clearing an occasion is a separate act from planning the days
 * again, and doing both at once would silently rewrite a week.
 * @param {import("./plan.js").Plan} plan
 * @param {string} occasionId
 * @returns {import("./plan.js").Plan}
 */
export function clearOccasion(plan, occasionId) {
  return { ...plan, entries: (plan.entries ?? []).filter((e) => e.occasion !== occasionId) };
}

/**
 * Which shared tables this person must come off, given their occasions.
 * Returns table ids only; the caller writes the seat patches (this module
 * never touches house events, so it stays pure and testable).
 * @param {{ id: string, date: string, seats: { id: string, status?: string }[] }[]} tables
 * @param {Occasion[]} occasions
 * @param {string} profileId
 * @param {string} [today] tables before today are left alone — a past seat is
 *   history, and un-seating it would rewrite what already happened
 * @returns {string[]}
 */
export function tablesToLeave(tables, occasions, profileId, today) {
  const mine = (occasions ?? []).filter((o) => o.profileId === profileId && o.offTables !== false);
  const owned = new Set(mine.flatMap(datesOf));
  return (tables ?? [])
    .filter((t) => owned.has(t.date))
    .filter((t) => !today || t.date >= today)
    .filter((t) => t.seats?.some((s) => s.id === profileId && s.status !== "skipped"))
    .map((t) => t.id);
}

/**
 * A plain-language summary for the card: "3 days, Aug 11 to Aug 14".
 * @param {Occasion} o
 */
export function summarize(o) {
  const dates = datesOf(o);
  const pretty = (/** @type {string} */ iso) => {
    const [, m, d] = iso.split("-");
    const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
    return `${months[Number(m) - 1]} ${Number(d)}`;
  };
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return "no days";
  if (dates.length === 1) return pretty(first);
  return `${dates.length} days, ${pretty(first)} to ${pretty(last)}`;
}
