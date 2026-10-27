// Mise 2.0: the JS port of `private.plate_of` (P8 plates). It turns a person's
// full targets into the plate card other people's phones receive. The server
// makes the real plates; this port exists so tests can run every cross-person
// reader on a plate (tests/plate-parity.test.js) and so the migration can
// predict them. tests/plate-of.test.js requires the SQL and this to agree.
import {
  PLATE_FIELDS,
  PLATE_MACROS_DROPPED,
  PLATE_CURRENCY_KEYS,
  PLATE_MEAL_SLOT_DROPPED,
} from "./plate-fields.js";

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} targets a targets document
 * @returns {Record<string, unknown>} the plate card
 */
export function plateOf(targets) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!isObject(targets)) return out;
  for (const k of PLATE_FIELDS) {
    if (!(k in targets)) continue;
    const v = targets[k];
    if (k === "macros" && isObject(v)) {
      out[k] = Object.fromEntries(Object.entries(v).filter(([m]) => !PLATE_MACROS_DROPPED.includes(m)));
    } else if (k === "currencies" && Array.isArray(v)) {
      out[k] = v.map((c) =>
        isObject(c) ? Object.fromEntries(Object.entries(c).filter(([ck]) => PLATE_CURRENCY_KEYS.includes(ck))) : c,
      );
    } else if (k === "mealSlots" && Array.isArray(v)) {
      out[k] = v.map((s) =>
        isObject(s) ? Object.fromEntries(Object.entries(s).filter(([sk]) => !PLATE_MEAL_SLOT_DROPPED.includes(sk))) : s,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}
