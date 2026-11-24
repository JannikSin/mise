// HOW A STEP READS ON THE RECIPE PAGE (P9; David, 2026-11-24: "i dont like
// having to go up to ingridient list to find how much i need ... in the
// instructions also tell how much you need").
//
// A step's text may name an ingredient by its 1-based row number, `{{3}}`,
// and the page prints that row's amount right there, SCALED with COOK FOR:
// the same numbers as the ingredient list, never a second copy that can
// drift from it. A step may also carry `notes` (the margin notes, printed
// as small lines under it). Recipes written before either existed render
// exactly as before, except an HBP save whose notes were folded into the
// text after " · ", which is split back out.
import { formatRecipeQty } from "./shopping.js";

const SLOT_RX = /\{\{(\d{1,2})\}\}/g;

/**
 * The inline amount for one ingredient row. As written (ratio 1) a row that
 * carries its spoon or cup `measure` reads "2 tsp (10 g)"; scaled, the
 * measure no longer matches, so only the scaled weight prints.
 * @param {Record<string, any> | undefined} row the (possibly scaled) row
 * @param {boolean} asWritten
 * @returns {string}
 */
export function inlineAmount(row, asWritten) {
  if (!row) return "";
  if (asWritten && typeof row.measure === "string" && row.measure.trim()) {
    // "1/2 tbsp (8 g)", never "1/2 tbsp (0.3 oz (8 g))"
    const g =
      String(row.unit ?? "").toLowerCase() === "g"
        ? `${Math.round(Number(row.qty) * 10) / 10} g`
        : formatRecipeQty(row.qty, row.unit);
    return `${row.measure.trim()} (${g})`;
  }
  return formatRecipeQty(row.qty, row.unit);
}

/**
 * @param {{ step?: number, text?: string, notes?: string[] }} step
 * @param {Record<string, any>[]} rows the ingredient rows the page shows, in recipe order
 * @param {{ asWritten: boolean, hbp: boolean }} opts `hbp`: the recipe is an HBP save
 * @returns {{ text: string, notes: string[] }}
 */
export function stepView(step, rows, { asWritten, hbp }) {
  let text = String(step?.text ?? "");
  let notes = Array.isArray(step?.notes)
    ? step.notes.filter((n) => typeof n === "string" && n.trim())
    : [];
  if (notes.length === 0 && hbp && text.includes(" · ")) {
    const [head, ...rest] = text.split(" · ");
    // temperatures were folded in the same way ("74 °C (poultry done
    // temp)"); they stay in the step, the cook needs them there
    const temps = rest.filter((r) => /^\d+(\.\d+)? °[CF] \(/.test(r));
    notes = rest.filter((r) => !temps.includes(r));
    text = [head, ...temps].join(" · ");
  }
  // a row number with no row (a bad save) prints nothing rather than "{{9}}"
  text = text.replace(SLOT_RX, (_, n) => inlineAmount(rows[Number(n) - 1], asWritten));
  return { text, notes };
}

/** @param {Record<string, any>} recipe */
export function hasInlineAmounts(recipe) {
  return (recipe?.instructions ?? []).some(
    (/** @type {any} */ s) => typeof s?.text === "string" && /\{\{\d{1,2}\}\}/.test(s.text),
  );
}
