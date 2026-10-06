// RELEASE VERSIONS (David, 2026-10-05: "we should have version numbers each
// update so call what we have now v1, and we work from there"). One number a
// person reads, separate from the service-worker shell number (mise-shell-v224
// and on), which moves on every commit and means nothing to anyone using the
// app. The live app shows `v<N>`; the sandbox shows the release it is building
// toward as `v<N>-next`.
//
// THE RULE: every promotion from next to live bumps the version. The top entry
// is the release in progress on next (date ""); the session that takes David's
// yes dates it with the ship day, and tools/release.ps1 refuses a release whose
// top version is not above live's or whose date is not the ship tag's day.
// Right after a release, next opens the following version with an empty date.
// Notes are written for David, one line per change, outcome not mechanism.

/** @typedef {{ version: number, date: string, notes: string[] }} Release */

/** @type {Release[]} newest first */
export const RELEASES = [
  {
    version: 2,
    date: "",
    notes: [
      "House money counts only confirmed payments: WE BOUGHT GROCERIES and I PAID SOMEONE BACK on the List tab.",
      "Invite by link in SYS: invite a housemate or a guest, they make their own profile.",
      "Release version numbers, shown here.",
      "✎ notes ask your name once and carry it; no 3-minute cutoff on a voice note.",
    ],
  },
  {
    version: 1,
    date: "2026-10-05",
    notes: [
      "The baseline: everything live on 5 Oct 2026, including the Plan-tab notice when a shared kitchen ends and the house-money load fix.",
    ],
  },
];

export const VERSION = RELEASES[0]?.version ?? 1;

/**
 * The label a person sees.
 * @param {string | null} branch the data branch this origin owns (dataBranch())
 */
export function versionLabel(branch) {
  return branch === "sandbox" ? `v${VERSION}-next` : `v${VERSION}`;
}
