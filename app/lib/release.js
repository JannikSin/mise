// RELEASE VERSIONS (David, 2026-10-05: "we should have version numbers each
// update so call what we have now v1, and we work from there"). One number a
// person reads, separate from the service-worker shell number (mise-shell-v224
// and on), which moves on every commit and means nothing to anyone using the
// app.
//
// The sandbox carries NO number of its own (David: "it is a work in progress
// newer version... it might be 1.1 or 1.15 or 1.5 or 2.0, it varies based on
// improvement shown"). It shows the live number plus "work in progress", and
// its changes collect under the top entry, version "unreleased".
//
// THE RULE: the number is chosen AT SHIP TIME, sized to the improvement. The
// session taking David's yes proposes it with a one-line reason, he confirms,
// and the session renames "unreleased" to that number and dates it with the
// ship day. Versions compare as decimals (1.1 < 1.15 < 1.5 < 2.0).
// tools/release.ps1 refuses a release whose top entry is not a number above
// live's or is not dated the ship day. Right after a release, next opens a
// fresh "unreleased" entry. Notes are for David: outcome, not mechanism.

/** @typedef {{ version: string, date: string, notes: string[] }} Release */

export const UNRELEASED = "unreleased";

/** @type {Release[]} newest first */
export const RELEASES = [
  {
    version: UNRELEASED,
    date: "",
    notes: [
      "House money counts only confirmed payments: WE BOUGHT GROCERIES and I PAID SOMEONE BACK on the List tab.",
      "Invite by link in SYS: invite a housemate or a guest, they make their own profile.",
      "Version numbers, shown here.",
      "✎ notes ask your name once and carry it; no 3-minute cutoff on a voice note.",
    ],
  },
  {
    version: "1.0",
    date: "2026-10-05",
    notes: [
      "The baseline: everything live on 5 Oct 2026, including the Plan-tab notice when a shared kitchen ends and the house-money load fix.",
    ],
  },
];

/** the newest SHIPPED version */
export const LIVE_VERSION = RELEASES.find((r) => r.version !== UNRELEASED)?.version ?? "1.0";

/**
 * The label a person sees.
 * @param {string | null} branch the data branch this origin owns (dataBranch())
 */
export function versionLabel(branch) {
  return branch === "sandbox" ? `v${LIVE_VERSION} + work in progress` : `v${LIVE_VERSION}`;
}
