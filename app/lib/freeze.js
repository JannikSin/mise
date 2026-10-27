// THE MOVE FREEZE (Mise 2.0, plan section 6 step B and step 21; P3 knows-you).
// On the switch morning the admin taps FREEZE in Settings. That writes one
// small file at the data root, `freeze.json`, on the backend the kitchen is
// still on (GitHub). The final migration refuses to run without it (its
// preflight, plan section 6 step 1), and every phone that reads it holds its
// queued changes instead of sending them, so nothing lands in the old store
// after the copy has been taken. UNFREEZE writes it back to frozen: false
// (rollback steps B to D: "unfreeze, no loss").
//
// The file names no one: `by` is the profile slug of whoever tapped.

export const FREEZE_PATH = "freeze.json";

/**
 * @typedef {{ frozen: boolean, at: string, by: string }} FreezeFile
 */

/**
 * @param {boolean} frozen
 * @param {string} by profile slug
 * @param {string} nowIso
 * @returns {FreezeFile}
 */
export function freezeRecord(frozen, by, nowIso) {
  return { frozen, at: nowIso, by: String(by).slice(0, 40) };
}

/**
 * Is the kitchen frozen? Only an explicit `frozen: true` counts, so a missing,
 * empty or malformed file never stops anyone's writes.
 * @param {unknown} file
 */
export function isFrozen(file) {
  return Boolean(file && typeof file === "object" && /** @type {any} */ (file).frozen === true);
}

/**
 * Should this queued path wait? Everything waits while frozen, except the
 * freeze file itself (UNFREEZE has to be able to land).
 * @param {unknown} file the current freeze.json
 * @param {string} path
 */
export function holdWrite(file, path) {
  return isFrozen(file) && path !== FREEZE_PATH;
}

/**
 * Is the move switched on for this SHELL? The freeze control shows only when
 * the shell carries `<meta name="mise-move" content="on">`, which the owner
 * adds to the build that runs on the switch morning. Every 1.9x shell, and
 * this one as committed, carries no such meta, so Settings is 1.95 there.
 * @param {{ querySelector?: (s: string) => any } | undefined} [doc]
 */
export function moveOn(doc = /** @type {any} */ (globalThis).document) {
  const meta =
    doc && typeof doc.querySelector === "function"
      ? String(doc.querySelector('meta[name="mise-move"]')?.getAttribute("content") ?? "").trim()
      : "";
  return meta === "on";
}
