// The serve step (per-person-plates-design §7, deploy 1): who gets what,
// rendered as the LAST step of Cook Mode, gated by the COOKED button.
//
// Deploy-1 data source is stored-seat MASS SHARE (spec §7.1): every dish is
// effectively `mixed` until the engine ships, so each person gets ONE mass
// line (spec §5.2), phrased as a kitchen fraction of the pan. Amounts derive
// from `seats[].servings`, which is durable in events.json and changes only
// when a human changes a seat — that is the stability rule (spec §7.3).
// When the transform lands, the same seat blocks render solved plates and
// the layout does not change.
//
// The denominator is EVERY non-skipped seat (spec §7.1, loop-2 B1):
// eligibility only changes how a seat's share is RENDERED — a plate line,
// or a named SET ASIDE block for a seat that must not be handed a plate
// instruction (hard diet/avoid conflict). Plates + set-asides partition the
// pot exactly once; nothing is ever redistributed.
import { recipeConflicts, softAvoidMatches } from "./plan.js";

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   kind: "plate" | "aside",
 *   fraction: string,
 *   lines?: string[],
 *   note?: string,
 * }} ServeRow
 * @typedef {{ rows: ServeRow[], cookNotes: string[] }} ServeModel
 */

/**
 * A kitchen-honest fraction of the pan. Halves, thirds and quarters are the
 * language of a person holding a spoon; percentages and decimals are not.
 * @param {number} share 0..1
 * @returns {string}
 */
export function panFraction(share) {
  if (!Number.isFinite(share) || share <= 0) return "";
  /** @type {[number, string][]} */
  const stops = [
    [1, "the whole pan"],
    [3 / 4, "about three quarters of the pan"],
    [2 / 3, "about two thirds of the pan"],
    [1 / 2, "about half the pan"],
    [2 / 5, "a bit under half the pan"],
    [1 / 3, "about a third of the pan"],
    [1 / 4, "about a quarter of the pan"],
    [1 / 5, "about a fifth of the pan"],
    [1 / 6, "about a sixth of the pan"],
  ];
  let best = "about a sixth of the pan";
  let dist = Infinity;
  for (const s of stops) {
    const d = Math.abs(share - s[0]);
    if (d < dist) {
      dist = d;
      best = s[1];
    }
  }
  return best;
}

/**
 * Build the serve model for one table. Pure; screens with whatever seat
 * rules the device has cached — a seat whose targets could not be read gets
 * a plain plate line with no note (the hard screen still protects that
 * person on their own device; this screen only decides what the COOK is
 * told to do).
 * @param {import("./tables.js").TableEvent} t
 * @param {Record<string, any> | undefined} recipe the BANK recipe
 * @param {Record<string, any>[]} profilesOrder profiles.json order — THE seat order
 *   (spec §7.3: fixed every time; the seats array order is merge-unstable)
 * @param {Record<string, { diet?: string, avoidIngredients?: string[], avoidRecipes?: string[] } | null>} rulesBySeat
 *   each seat's cached diet rules, null = unreadable/absent on this device
 * @param {{ synthMode: string, rows: Record<string, any>[] | null, bySeat?: Record<string, any> } | null} [synth]
 *   output of synthesize() for this table, when the engine ran
 * @returns {ServeModel}
 */
export function buildServe(t, recipe, profilesOrder, rulesBySeat, synth) {
  // THE DENOMINATOR RULE (spec §7.1, Loyalist precision): every seat whose
  // food is in the pot. Before anyone claims the buy, a skipped seat's food
  // was never bought, so they are out. Once `buyerId` is set the food IS in
  // the pan, and a later skip changes RENDERING only: the seat becomes a
  // named SET ASIDE, never a shrunken denominator that regrows everyone
  // else's share (that is the B1 over-plate, priced out twice).
  const bought = Boolean(t.buyerId);
  const seats = (t.seats ?? []).filter((s) => bought || s.status !== "skipped");
  const known = new Map(seats.map((s) => [s.id, s]));
  const total = seats.reduce((sum, s) => sum + (Number(s.servings) || 0), 0);
  /** @type {ServeRow[]} */
  const rows = [];
  if (total <= 0 || !recipe) return { rows, cookNotes: [] };

  for (const p of profilesOrder) {
    const seat = known.get(p.id);
    if (!seat) continue;
    const share = (Number(seat.servings) || 0) / total;
    const fraction = panFraction(share);
    const rules = rulesBySeat[p.id];
    const name = p.name ?? p.id;
    if (seat.status === "skipped") {
      // only reachable when bought: their share exists as food
      rows.push({ id: p.id, name, kind: "aside", fraction, note: "not here tonight, save it" });
      continue;
    }
    const hard = rules
      ? recipeConflicts(recipe, rules.diet, rules.avoidIngredients, rules.avoidRecipes)
      : [];
    if (hard.length > 0) {
      // never hand the cook an instruction to plate this seat (spec §5.5):
      // their food is still in the pan (they count in the denominator), so
      // it is a named set-aside, not a silent absorption by the table.
      // On a SOLVED table the aside says the solved amounts (a conflicted
      // seat is still in the live solve) — the pan fraction would
      // contradict the bill their perSeat share produces (Realist R13).
      const asideLines = synth?.synthMode === "solved" ? plateLines(synth, p.id) : null;
      rows.push({
        id: p.id,
        name,
        kind: "aside",
        fraction,
        ...(asideLines && asideLines.length > 0 ? { lines: asideLines } : {}),
        note: hard[0],
      });
      continue;
    }
    const soft = rules ? softAvoidMatches(recipe, rules.avoidIngredients) : [];
    // SOLVED plates (spec §7.3): when the engine ran for this table, each
    // seat's line is their actual amounts — protein in grams to the nearest
    // 25 (a scale exists and David wants it used), starch in household
    // quarters, vegetables as adjectives, flavor rows silent. The engine
    // upgrading this screen changes ZERO layout: same seat blocks, richer
    // lines. Falls back to the pan fraction whenever the solve is uniform.
    const solvedLines = synth?.synthMode === "solved" ? plateLines(synth, p.id) : null;
    rows.push({
      id: p.id,
      name,
      kind: "plate",
      // a seat with no readable amount still eats: say so plainly rather
      // than render an empty line (spec §7.3's unconfigured-seat rule)
      fraction: fraction || "a normal plate",
      ...(solvedLines && solvedLines.length > 0 ? { lines: solvedLines } : {}),
      ...(soft.length > 0 ? { note: `no ${soft.join(", no ")}` } : {}),
    });
  }
  // one-pot sequencing notes from the existing tailor ride along for the
  // cook — prose only, no numbers, and they die with the tailor at drip
  // start (spec §11.6)
  const cookNotes = (t.tailor?.cook ?? []).filter((c) => typeof c === "string" && c.length > 0);
  return { rows, cookNotes };
}

/**
 * One seat's solved plate as spoken kitchen lines (spec §7.3 format rules).
 * @param {{ rows: Record<string, any>[] | null, bySeat?: Record<string, any> }} synth output of synthesize()
 * @param {string} seatId
 * @returns {string[]}
 */
function plateLines(synth, seatId) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const veg = [];
  for (const row of synth.rows ?? []) {
    const q = Number(row.perSeat?.[seatId] ?? 0);
    if (!(q > 0)) continue;
    const unit = String(row.unit ?? "").toLowerCase();
    const food = String(row.food ?? "");
    if (row.part === "flavor") continue; // rides in the pot, never spoken
    if (row.part === "veg") {
      // ALL vegetables fold into ONE adjective line (§7.3's own example;
      // Realist R5: one line per veg row overflows four seats off a phone
      // screen — the height budget was designed around 2-3 lines a seat)
      veg.push(food);
      continue;
    }
    if (unit === "g" || unit === "kg") {
      const grams = unit === "kg" ? q * 1000 : q;
      const rounded = Math.max(25, Math.round(grams / 25) * 25);
      out.push(`${rounded} g ${food}`);
      continue;
    }
    if (unit === "cup" || unit === "cups") {
      const quarters = Math.round(q * 4) / 4;
      if (quarters < 0.25) {
        out.push(`a spoonful of ${food}`); // unservable quantum (spec §4.2)
        continue;
      }
      const whole = Math.floor(quarters);
      const frac =
        { 0: "", 0.25: "1/4", 0.5: "1/2", 0.75: "3/4" }[
          Math.round((quarters - whole) * 100) / 100
        ] ?? "";
      const label = whole > 0 ? (frac ? `${whole} ${frac}` : String(whole)) : frac;
      out.push(`${label} cup${quarters > 1 ? "s" : ""} ${food}`);
      continue;
    }
    // counted units (slices, pieces): halves are cookable, finer is not.
    // Below half: say it in words — food never silently vanishes from a
    // plate instruction (same rule as the cup branch's spoonful)
    const halves = Math.round(q * 2) / 2;
    if (halves >= 0.5) out.push(`${halves} ${unit === "unit" ? "" : `${unit} `}${food}`.trim());
    else out.push(`a small piece of ${food}`);
  }
  if (veg.length > 0) out.push(`with ${veg.join(", ")}`);
  // rung-3 top-up: added food for THIS seat, said as its own line
  const solve = /** @type {any} */ (synth).bySeat?.[seatId];
  if (solve?.topUp) out.push(`${solve.topUp.grams} g ${solve.topUp.food} on the side`);
  // the ladder's own failure is silence (§4.7): an unclosable floor gap
  // is said out loud on the plate it affects
  if (solve?.note && solve.rung === "3-floor") out.push(solve.note);
  return out;
}
