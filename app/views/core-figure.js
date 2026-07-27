import { html } from "htm/preact";

// Animated stick figures for the core sessions (David, 2026-07-27: "I had to
// read the description for some of them while I was supposed to be doing
// them"). A cue you have to READ mid-plank arrives at the worst possible
// moment; a shape you can GLANCE at does not.
//
// Inline SVG with CSS keyframes rather than images, GIFs or video, for three
// reasons that all matter here: the app ships under a strict CSP with no
// external hosts, every byte is precached by the service worker so it has to
// work offline on a bedroom floor, and a schematic line drawing reads better
// at arm's length than a photo of someone else's body.
//
// Deliberately crude. These say WHICH SHAPE and WHICH WAY IT MOVES. The
// tempo and the form detail stay in the cue text, which is now shown during
// the lead-in, before you are upside down.

/** Exercise name → figure key. Matched loosely so "Front plank" and "Plank"
 *  land on the same drawing and a new session name does not silently render
 *  nothing. */
const FIGURES = /** @type {[RegExp, string][]} */ ([
  [/copenhagen/i, "copenhagen"],
  [/hip dip/i, "hipdip"],
  [/side plank/i, "sideplank"],
  [/dead bug/i, "deadbug"],
  [/hollow/i, "hollow"],
  [/reverse crunch/i, "reversecrunch"],
  [/crunch/i, "crunch"],
  [/leg raise/i, "legraise"],
  [/flutter/i, "flutter"],
  [/bicycle/i, "bicycle"],
  [/russian/i, "twist"],
  [/plank/i, "plank"],
]);

/** @param {string} name */
export function figureKeyFor(name) {
  for (const [re, key] of FIGURES) if (re.test(name ?? "")) return key;
  return "";
}

// Shared bits. The floor is always at y=52 so every figure reads at the same
// scale, and a mat you can place yourself against.
const floor = html`<line class="f-floor" x1="4" y1="52" x2="116" y2="52" />`;

/** @type {Record<string, () => any>} */
const DRAW = {
  plank: () => html`
    ${floor}
    <circle class="f-head" cx="26" cy="24" r="5" />
    <line class="f-limb" x1="30" y1="26" x2="96" y2="42" />
    <line class="f-limb" x1="31" y1="27" x2="30" y2="52" />
    <line class="f-limb" x1="96" y1="42" x2="104" y2="52" />
  `,
  sideplank: () => html`
    ${floor}
    <g class="f-body">
      <circle class="f-head" cx="26" cy="20" r="5" />
      <line class="f-limb" x1="30" y1="24" x2="98" y2="46" />
      <line class="f-limb" x1="31" y1="25" x2="26" y2="52" />
      <line class="f-limb" x1="98" y1="46" x2="108" y2="52" />
      <line class="f-limb f-arm" x1="34" y1="24" x2="34" y2="8" />
    </g>
  `,
  hipdip: () => html`
    ${floor}
    <g class="f-hips">
      <circle class="f-head" cx="26" cy="20" r="5" />
      <line class="f-limb" x1="30" y1="24" x2="98" y2="46" />
      <line class="f-limb" x1="31" y1="25" x2="26" y2="52" />
      <line class="f-limb" x1="98" y1="46" x2="108" y2="52" />
    </g>
    <path class="f-arrow" d="M62 12 v10 M58 18 l4 5 l4 -5" />
  `,
  copenhagen: () => html`
    ${floor}
    <rect class="f-box" x="84" y="34" width="30" height="18" rx="2" />
    <g class="f-hips">
      <circle class="f-head" cx="20" cy="24" r="5" />
      <line class="f-limb" x1="24" y1="28" x2="86" y2="40" />
      <line class="f-limb" x1="25" y1="29" x2="20" y2="52" />
      <line class="f-limb f-top" x1="60" y1="35" x2="90" y2="34" />
    </g>
  `,
  deadbug: () => html`
    ${floor}
    <line class="f-spine" x1="30" y1="46" x2="78" y2="46" />
    <circle class="f-head" cx="24" cy="44" r="5" />
    <g class="f-alt-a">
      <line class="f-limb" x1="34" y1="45" x2="16" y2="30" />
      <line class="f-limb" x1="78" y1="46" x2="92" y2="28" />
    </g>
    <g class="f-alt-b">
      <line class="f-limb" x1="34" y1="46" x2="46" y2="30" />
      <line class="f-limb" x1="78" y1="46" x2="104" y2="44" />
    </g>
  `,
  hollow: () => html`
    ${floor}
    <g class="f-shake">
      <path class="f-limb" d="M22 32 Q60 52 104 30" />
      <circle class="f-head" cx="18" cy="30" r="5" />
    </g>
  `,
  crunch: () => html`
    ${floor}
    <line class="f-limb" x1="70" y1="48" x2="88" y2="34" />
    <line class="f-limb" x1="88" y1="34" x2="104" y2="50" />
    <g class="f-fold">
      <line class="f-spine" x1="70" y1="48" x2="32" y2="44" />
      <circle class="f-head" cx="27" cy="43" r="5" />
    </g>
  `,
  reversecrunch: () => html`
    ${floor}
    <line class="f-spine" x1="26" y1="48" x2="66" y2="48" />
    <circle class="f-head" cx="21" cy="46" r="5" />
    <g class="f-roll">
      <line class="f-limb" x1="66" y1="48" x2="90" y2="34" />
      <line class="f-limb" x1="90" y1="34" x2="100" y2="48" />
    </g>
  `,
  legraise: () => html`
    ${floor}
    <line class="f-spine" x1="26" y1="48" x2="64" y2="48" />
    <circle class="f-head" cx="21" cy="46" r="5" />
    <g class="f-swing">
      <line class="f-limb" x1="64" y1="48" x2="108" y2="46" />
    </g>
    <path class="f-arrow" d="M96 16 v14 M92 25 l4 6 l4 -6" />
  `,
  flutter: () => html`
    ${floor}
    <line class="f-spine" x1="26" y1="46" x2="64" y2="46" />
    <circle class="f-head" cx="21" cy="44" r="5" />
    <g class="f-alt-a"><line class="f-limb" x1="64" y1="46" x2="106" y2="36" /></g>
    <g class="f-alt-b"><line class="f-limb" x1="64" y1="47" x2="106" y2="48" /></g>
  `,
  bicycle: () => html`
    ${floor}
    <line class="f-spine" x1="34" y1="44" x2="70" y2="46" />
    <circle class="f-head" cx="29" cy="42" r="5" />
    <g class="f-alt-a">
      <line class="f-limb" x1="70" y1="46" x2="60" y2="28" />
      <line class="f-limb" x1="36" y1="42" x2="56" y2="30" />
    </g>
    <g class="f-alt-b">
      <line class="f-limb" x1="70" y1="46" x2="106" y2="42" />
      <line class="f-limb" x1="36" y1="44" x2="20" y2="32" />
    </g>
  `,
  twist: () => html`
    ${floor}
    <line class="f-limb" x1="60" y1="50" x2="86" y2="38" />
    <line class="f-limb" x1="86" y1="38" x2="100" y2="50" />
    <g class="f-rotate">
      <line class="f-spine" x1="60" y1="50" x2="38" y2="28" />
      <circle class="f-head" cx="34" cy="24" r="5" />
      <line class="f-limb f-arm" x1="46" y1="36" x2="66" y2="34" />
    </g>
  `,
};

/**
 * The animated figure for an exercise, or nothing when the name matches no
 * drawing (a missing figure must never blank the timer).
 * @param {{ name: string, small?: boolean }} props
 */
export function CoreFigure({ name, small = false }) {
  const key = figureKeyFor(name);
  const draw = DRAW[key];
  if (!draw) return null;
  return html`
    <svg
      class="corefig fig-${key} ${small ? "small" : ""}"
      viewBox="0 0 120 60"
      role="img"
      aria-label="${name} demonstration"
    >
      ${draw()}
    </svg>
  `;
}
