// Guided-tour data + state (docs/tutorial-design.md v3). One linear tour,
// offered once at a profile's first login on a device, replayable from SYS.
// TOUR_STEPS is plain exported data: the overlay walks it, SYS renders the
// same array as the static "what everything does" list, and the tour test
// asserts every selector still exists in view source, so tour, manual, and
// markup cannot silently drift apart.

/** Tab label per route, in tour order — also groups the SYS static list. */
export const TOUR_TABS = /** @type {const} */ ({
  "#/today": "COOK",
  "#/plan": "PLAN",
  "#/list": "LIST",
  "#/train": "TRAIN",
  "#/": "HOME",
  "#/system": "SYS",
});

/**
 * @typedef {{ route: keyof typeof TOUR_TABS, selector: string, title: string, text: string }} TourStep
 */

/** @type {TourStep[]} */
export const TOUR_STEPS = [
  {
    route: "#/today",
    selector: ".todaylist",
    title: "Today's meals",
    text: "Everything planned for today. Tap a meal to open its recipe, portions already scaled to what you should eat.",
  },
  {
    route: "#/today",
    selector: ".hero.weeknav",
    title: "Flip through the week",
    text: "The arrows page through the week's days, so you can open tomorrow and pre-cook what you can tonight.",
  },
  {
    route: "#/today",
    selector: ".tile.buffer",
    title: "The buffer snack",
    text: "One batch-prepped fridge stand-by per week, the measured answer to still-hungry moments. Tally portions here as you eat them.",
  },
  {
    route: "#/today",
    selector: ".batchprep",
    title: "Batch prep",
    text: "What to cook ahead and when. It knows the calendar: past Sunday it becomes a catch-up list, and on Sunday it preps NEXT week.",
  },
  {
    route: "#/plan",
    selector: ".ask",
    title: "Generate my week",
    text: "One tap plans the whole week around your targets with overlapping ingredients. Tap again to re-roll. Mid-week it only replans days you haven't eaten.",
  },
  {
    route: "#/plan",
    selector: ".buildreport",
    title: "The build report",
    text: "What the week shares, how many items to shop, and honest warnings when a day falls short. Nothing is fudged.",
  },
  {
    route: "#/plan",
    selector: ".tray",
    title: "The recipe tray",
    text: "Drag any recipe down into any day's slot. The chips above filter by meal type.",
  },
  {
    route: "#/plan",
    selector: ".pin",
    title: "Pin a meal",
    text: "PIN locks an entry you want to keep. Generate and re-roll build around pins, never over them.",
  },
  {
    route: "#/plan",
    selector: ".outbtn",
    title: "Eating out",
    text: "Free lunch or restaurant dinner? OUT empties the slot, buys nothing for it, and credits realistic macros so the rest of the day still plans honestly.",
  },
  {
    route: "#/plan",
    selector: ".day.past",
    title: "Days already eaten",
    text: "Past days dim and go read-only. Re-rolls, targets, and the shopping list all skip them, the app never rewrites history.",
  },
  {
    route: "#/list",
    selector: ".actions .primary",
    title: "Build the list",
    text: "Turns the week into a priced grocery list, minus what your pantry already has. Works offline in the store.",
  },
  {
    route: "#/list",
    selector: ".lockbtn",
    title: "Lock a shopped week",
    text: "Once you've shopped, lock the week. Generate and re-roll refuse to touch a locked plan, so the food you bought stays the plan.",
  },
  {
    route: "#/list",
    selector: ".chips",
    title: "Pantry and house",
    text: "PANTRY holds what you own: ticked groceries flow in via ADD TO PANTRY, P+ marks things you already had. EVERYONE merges your house's lists into one trip.",
  },
  {
    route: "#/train",
    selector: ".intervaltimer",
    title: "Train",
    text: "Today's workout with one-entry logging, plus this interval timer for circuits: work, rest, rounds, beeps.",
  },
  {
    route: "#/",
    selector: ".grid",
    title: "Morning check-in",
    text: "Weigh in, log how you feel, see the day at a glance. The trend reads over 7 days, never a single morning.",
  },
  {
    route: "#/system",
    selector: ".tourrow",
    title: "SYS is the control room",
    text: "Token, profiles, house moves, data export, and this tour again, right here, any time.",
  },
];

/**
 * @typedef {{ status: "skipped" | "done" | "bailed", lastStep: number }} TourState
 */

/** @param {string} profileId */
const keyOf = (profileId) => `mise.tour.${profileId}`;

/**
 * The profile's tour record on this device, or null if never offered.
 * @param {string} profileId
 * @param {Pick<Storage, "getItem" | "setItem">} [storage] injectable for tests
 * @returns {TourState | null}
 */
export function readTourState(profileId, storage = localStorage) {
  try {
    const raw = storage.getItem(keyOf(profileId));
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && typeof p.status === "string"
      ? { status: p.status, lastStep: Number(p.lastStep) || 0 }
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} profileId
 * @param {TourState} state
 * @param {Pick<Storage, "getItem" | "setItem">} [storage]
 */
export function writeTourState(profileId, state, storage = localStorage) {
  try {
    storage.setItem(keyOf(profileId), JSON.stringify(state));
  } catch {
    // storage full/blocked: the tour just offers again next launch
  }
}
