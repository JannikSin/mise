import { html } from "htm/preact";
import { DOZEN_GROUPS, dozenRemaining } from "../lib/dozen.js";

/**
 * Daily Dozen habit tally: beverages/greens/other fruit/other veg aren't
 * deliverable by recipes alone, so David checks them off by hand each day —
 * same stepper pattern as the pushups/water counters. Standalone so Home
 * (owned elsewhere right now) can mount it without this file touching it.
 * @param {{
 *   day: Record<string, any> | undefined,
 *   targets: Record<string, any> | null,
 *   onPatchDay: (patch: Record<string, any>) => void
 * }} props
 */
export function DozenTally({ day, targets, onPatchDay }) {
  const have = day?.dozen ?? {};
  const goals = targets?.dailyDozen ?? {};
  const remaining = dozenRemaining(day, targets);

  const step = (/** @type {string} */ key, /** @type {number} */ delta) => {
    onPatchDay({ dozen: { ...have, [key]: Math.max(0, (have[key] ?? 0) + delta) } });
  };

  return html`
    <div class="slots counters">
      ${DOZEN_GROUPS.map(
        ({ key, label }) => html`
          <div class="checkrow counter ${remaining[key] === 0 ? "done" : ""}" key=${key}>
            <button
              class="stepbtn"
              aria-label="Remove one ${label.toLowerCase()} serving (now ${have[key] ?? 0})"
              onClick=${() => step(key, -1)}
            >
              −1
            </button>
            <span class="food">${label}</span>
            <span class="countnum num">${have[key] ?? 0}<small>/${goals[key] ?? "—"}</small></span>
            <button
              class="stepbtn plus"
              aria-label="Add one ${label.toLowerCase()} serving (now ${have[key] ?? 0} of ${goals[key] ?? "—"})"
              onClick=${() => step(key, 1)}
            >
              +1
            </button>
          </div>
        `,
      )}
    </div>
  `;
}
