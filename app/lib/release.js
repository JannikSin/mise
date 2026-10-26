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
//
// RELEASE CHECKLIST, v1.6: deploy the Worker BEFORE the app. The guest LOG IN
// and SIGN UP screens call /guest/login, /guest/me and the login field of
// /invite/claim; against the old Worker they fail.

/** @typedef {{ version: string, date: string, notes: string[] }} Release */

export const UNRELEASED = "unreleased";

/** @type {Release[]} newest first */
export const RELEASES = [
  {
    version: UNRELEASED,
    date: "",
    notes: [
      "Sunday cooks two dinners: one for Sunday and Monday, and a second for Tuesday to Thursday, all prepped Sunday except the meat. Friday and Saturday each get their own dish. It is the new default when you cook Sunday, Friday and Saturday; in the kitchen rule, Sunday cooks can also be one pot for Mon to Thu, or nights you pick.",
      "The second dish's meat is cooked once on Tuesday by default, or each night if you choose. Only dishes whose meat cooks in about 15 minutes are picked for it, like ground beef, sliced chicken, shrimp or tofu.",
      "Plan says what to do each night: Sunday lists the prep and where the meat goes (fridge or freezer), Tuesday says how much meat to cook, and Wednesday and Thursday say reheat until steaming hot, 165 F, and what to move from the freezer the night before.",
      "List says where the second dish's meat goes when it gets home, and Sunday's prep minutes leave out the meat cooked later.",
      "Two dishes of the same kind, like two dump-and-bake feta pastas, no longer land in the same week when something else fits.",
      "SET MY WEEK in the middle of the week keeps the leftover nights already planned, even if the list was never ticked.",
      "Plan's every-day warning no longer runs two words together.",
      "SET MY WEEK answers on Plan right away: what it set, and which nights cook and which eat leftovers. Sunday's row says which nights its pot makes and for how many.",
      "Plan warns on a dinner when someone at the table cannot eat it, with their name and the reason.",
      "WHOLE TRIP on List clears JUST SOME DAYS, so BUILD goes back to the whole trip. SEND TO CART is a full button, and linking Kroger brings you back to List.",
      "The People card lists cooks only for the nights that cook. The recipe card closes when you change tabs or go Back, and the pencil button moved to the left so it no longer sits on top of the right-hand buttons. A snack left out of the rule says when the reason is the backpack setting.",
    ],
  },
  {
    version: "1.95",
    date: "2026-10-24",
    notes: [
      "SET MY WEEK keeps every meal you already set and fills only the empty ones. PICK DIFFERENT MEALS is still there when you want new picks.",
      "Typed allergies count as the whole family: typing cheese now catches cheddar, parmesan, mozzarella and every other cheese in the bank (31 of 31 recipes, up from 13). Dairy, nuts, eggs, gluten, soy, fish, shellfish and sesame work the same way, and hummus, everything bagel seasoning, TVP and chocolate chips are caught too.",
      "A new phone opens in seconds instead of minutes: about 270 requests where it used to make over 25,000.",
      "Each phone now syncs only its own household's plans, targets and meals, and clears any others it held.",
      "Voice notes only add or update your pantry. Saying \"need more rice\" or \"low on rice\" marks it LOW. Saying \"out of rice\" asks you to tap MARK OUT first. Words it can't place show as Not sure. Your own words are saved with each note.",
      "If someone else's allergies cannot be read yet, they are never passed as safe, and SET TABLE waits until the check is done.",
      "Curry roux is caught for gluten, soy and dairy allergies, and two foods typed together, like celery and okra, are each checked.",
      "The kitchen rule greys out a recipe someone at the table cannot eat, with the reason, and Plan warns when a meal is the same dish every day of the week.",
      "A guest who signed up today can be seated at tonight's dinner.",
      "COOK FOR on a recipe scales it from 1 to 24 portions in grams, and names the pan and how many batches.",
      "JUST SOME DAYS offers any days in the next week, up to 7.",
      "Any list item over $15 says so, so you can check the size before you buy.",
      "Basics you probably have wait under CHECK YOU HAVE THESE: HAVE IT adds one to your pantry, NEED IT puts it in the cart.",
      "After a cart send from this phone, the next send adds only what is new and names anything you now need more of.",
      "42 new breakfasts and snacks in the recipe bank.",
      "A shopping trip never starts in the past: a BUILD after your buy day shops from today to the day before the next one, so no day is bought twice.",
      "An app update never reloads the page while you are in the middle of editing the kitchen rule or something is still saving.",
      "If you change the kitchen rule's recipe picks, SET MY WEEK swaps any set meal the rule no longer allows.",
      "On a just-opened phone the List no longer tells the shopper there is nothing to buy.",
      "The kitchen rule's SAVE stays on screen while you edit, and leaving with unsaved changes asks first.",
      "The avoid box on the guest form and in your profile is a full-size box.",
      "SWITCH REPO in Settings no longer signs a phone out when there is nothing to switch, and asks before it does.",
      "Walk the fridge now listens: film the shelves while you say what you see, and what you said lands in the box for you to check. If the phone cannot hear it, the box stays for typing and says why.",
      "Sunday dinner is the batch for Mon to Thu: in the kitchen rule, Sunday cooks one pot that keeps and reheats, those nights eat it, and every phone names the same cook. Turn it off to cook a second Sunday pot instead.",
      "Sunday cooking can have a rough minutes limit in the kitchen rule; Plan shows the week's Sunday prep against it.",
      "Passkeys show the digits you type, take the whole width, and clear after a wrong try. Everyone can set their own in Settings (typed twice; changing one asks for the current one first), and David can clear one that someone forgot.",
      "Allergies catch more, for every profile including ones saved before: a dairy allergy now catches mozzarella, cheddar, queso and pesto; fish catches Worcestershire; eggs catch mayonnaise; gluten catches gnocchi; nuts catch pine nuts and pesto.",
      "When cooks take turns, the whole week is one list bought by the shopper, the other cook's nights included.",
      "Walk the fridge can read your video again.",
      "Saving the kitchen rule never drops a recipe you picked, and SET MY WEEK waits until the recipes have loaded on a new phone, which also loads much faster now.",
      "Easier to read on a phone: the kitchen rule form fits the screen, list amounts and prices no longer cut off, and no text box makes the iPhone zoom in.",
      "Guests: a paused log in says so and says how long, a missing login name says so right where you type it, and guest pages never show who in the house is cooking.",
    ],
  },
  {
    version: "1.8",
    date: "2026-10-18",
    notes: [
      "Settings has YOUR PROFILE: the full set of questions, filled in with what Mise already knows about you. Change anything and save; nothing else in your profile is touched. Your calorie target sits next to what Mise suggests from your numbers, and a target far from it asks you to say why.",
      "Each person sees only their own household, plus guests at their own table. David, as admin, sees everyone. David's profile has a passkey, so nobody can open it from another phone.",
      "One profile per person: Settings, Your profile, with the fuller questions. Anvil will read the same profile once Anvil's own update lands; until then Anvil keeps its own copy.",
    ],
  },
  {
    version: "1.7",
    date: "2026-10-18",
    notes: [
      "BUILD checks today's Pay Less prices and this week's sales on its own, and says so in one line: prices checked today, and how many items are on sale.",
      "Walk the fridge: on the List's PANTRY, film the shelves while you say what you see; Mise reads the video and your words, you check the read-back, and it all goes in.",
      "No more 3 pm snack ping. Reminders are now the morning's day ahead, cook nights, the store run and the 11 pm Ate it?.",
      "Add a recipe from a link, right on Plan: Mise fits it to you, checks everyone's allergies, and either puts it on a night this week or saves it to your recipes.",
    ],
  },
  {
    version: "1.6",
    date: "2026-10-18",
    notes: [
      "Guests get their own log in: the guest link opens Welcome to Mise with LOG IN or SIGN UP. Sign up is the profile survey plus a login name and a 4-digit passkey; next time they just log in. No one's name is ever listed.",
      "Once in, a guest sees only the meals you added them to, who cooks, their plate, and the recipe. Nothing of your kitchen, your family or your other guests.",
      "Guests also see their own profile, read only: what they eat, what they don't, and their numbers.",
    ],
  },
  {
    version: "1.5",
    date: "2026-10-18",
    notes: [
      "The kitchen rule has no end date. It keeps going, and pauses on its own for Purdue's Thanksgiving break (Nov 25 to 29) and winter break (Dec 20 to Jan 10). Your current rule switches over the first time you open the app.",
      "When you take turns, the cooking rotates but there is one list, bought by one person: the shopper named on the kitchen rule. Change who in People, EDIT.",
      "On a kitchen that does not cook every night, dinners lean on big pots and bakes that keep, and a cook night only picks a dish whose pan holds everyone. If a batch is too big for one pan, the week says so.",
      "One bag of chocolate chips instead of three. Mid-week, Plan leads with the days, and ATE EVERYTHING TODAY marks the whole day in one tap.",
      "Dining court trays are trays a person eats: at most two helpings of a dish, and toppings no longer count toward the protein.",
    ],
  },
  {
    version: "1.4",
    date: "2026-10-18",
    notes: [
      "After GOING TO THE STORE, the List can send your week to your Pay Less cart in one tap. It only adds to the cart; you still pick the pickup time and check out in the Pay Less app. Anything it cannot send is named, so you add it yourself. The first time, it asks you to sign in to Kroger.",
      "The List says which nights are not on it and who buys them, when you take turns.",
      "PICK DIFFERENT MEALS is back on Plan, for when you do not like the week you see, before you buy it.",
      "Reminders: one ping on each night you cook, and at about 11:00 pm an Ate it? for anything not marked eaten.",
      "Guests: the invite link opens straight to a welcome and their own profile form, with no other profiles shown and no sign-in; it asks which dinners they could come to, and People adds them to those nights in one tap.",
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
