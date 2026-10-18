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
      "After GOING TO THE STORE, the List can send your week to your Pay Less cart in one tap. It only adds to the cart; you still pick the pickup time and check out in the Pay Less app. Anything it cannot send is named, so you add it yourself. The first time, it asks you to sign in to Kroger.",
      "The List says which nights are not on it and who buys them, when you take turns.",
      "PICK DIFFERENT MEALS is back on Plan, for when you do not like the week you see, before you buy it.",
      "Reminders: one ping on each night you cook, and at about 11:00 pm an Ate it? for anything not marked eaten.",
      "Guests: the invite link asks which dinners they could come to, and People adds them to those nights in one tap.",
    ],
  },
  {
    version: "1.3",
    date: "2026-10-17",
    notes: [
      "Your four foods are in the bank as you make them: the doubled chili pot, the cheesy chicken pesto bake, Grandma's banana nut bread and the overnight oats jar. Flour is one row on the list whether a recipe writes grams or tablespoons.",
      "Plan shows the week and its meals; how the engine built it is folded at the bottom. A meal swipe reads as a meal and opens the tray picker. ATE IT on every meal. No smoothie slot.",
      "List: pick the store, see the total, and your share against your budget (the budget is per person, per week). One heading per aisle.",
      "Table is now People: add anyone to a dinner, link a roommate, invite by link. Change who cooks and which nights there.",
      "Settings is down to what you use; houses, data and test buttons fold under More.",
      "Parked, nothing deleted: house money, the Kroger cart buttons, PICK DIFFERENT MEALS, recipe browsing, the dinner chat, the tour.",
      "A bought day keeps its dishes but its portions and cook follow your rule again, and a batch prepped on Sunday evening still counts after 7:30 pm.",
    ],
  },
  {
    version: "1.2",
    date: "2026-10-13",
    notes: [
      "USE WHAT'S LEFT is gone from the Plan tab: leftovers get fixed in the plan, not with a button.",
      "The weigh-in tile left Mise: weight, sleep and the daily routine live in Anvil now.",
      "Menu scan, remedies and occasions are parked: their buttons are hidden, nothing is deleted.",
      "Standing meals can start this week, from today: SET THIS WEEK, FROM TODAY plans the week on screen, and SET NEXT WEEK is its own button.",
      "Cooking for one works: a standing week of one person is allowed, and when a housemate moves out the cook who stays keeps the week.",
      "A lighter green background, so Mise and Anvil look different at a glance.",
    ],
  },
  {
    version: "1.1",
    date: "2026-10-12",
    notes: [
      "Every planned day reaches your calorie floor: the snack bake is the cheapest one that fills the day, and protein may run over its ceiling (and says so) before calories run short.",
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
