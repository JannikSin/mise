// Something to put on (David, 2026-07-27: "can the mise app play music, some
// random thing while cooking or something on theme for the meal").
//
// It does NOT play anything itself, and that is a deliberate call rather than
// a shortcut. A web app cannot drive an Apple Music subscription without
// MusicKit, which needs a third-party script and a developer token, and this
// app ships under a CSP that allows no external scripts at all and stores no
// keys. What it can do is hand the phone a link, which on iOS opens the Music
// app directly.
//
// Two rules learned while building it:
//
//   SEARCH BY MUSIC, NOT BY FOOD. The obvious version, searching the cuisine,
//   is useless: "korean bbq" in Apple Music returns songs literally called
//   Korean BBQ. Every term below names a GENRE OR MOOD, so the results are
//   something to cook to.
//
//   SEARCH LINKS, NOT PLAYLIST IDS. A curated playlist id rots and 404s, and
//   a dead link mid-cook is worse than no link. A search always resolves.

/**
 * @typedef {{ id: string, label: string, term: string, why: string }} Pick
 */

/** Cooking picks, keyed loosely to what the food is. */
const KITCHEN = /** @type {[RegExp, Pick[]][]} */ ([
  [
    /korea|kimchi|bulgogi|gochujang|japan|miso|teriyaki|ramen|asian/i,
    [
      { id: "citypop", label: "City pop", term: "city pop", why: "80s Tokyo, warm and easy" },
      { id: "kpop", label: "K-pop", term: "k-pop hits", why: "loud, keeps the pace up" },
    ],
  ],
  [
    /italian|pasta|risotto|parmesan|basil|pesto|carbonara/i,
    [
      { id: "ratpack", label: "Rat Pack", term: "frank sinatra dean martin", why: "obviously" },
      { id: "italianclassics", label: "Italian classics", term: "italian classics", why: "" },
    ],
  ],
  [
    /taco|mexican|salsa|chipotle|carnitas|cotija|tortilla/i,
    [
      { id: "latin", label: "Latin kitchen", term: "latin cocina", why: "" },
      { id: "cumbia", label: "Cumbia", term: "cumbia", why: "impossible to chop slowly to" },
    ],
  ],
  [
    /curry|masala|tikka|dal|paneer|indian|thai|coconut/i,
    [
      { id: "bolly", label: "Bollywood", term: "bollywood hits", why: "" },
      { id: "desi", label: "Desi beats", term: "desi hip hop", why: "" },
    ],
  ],
  [
    /kebab|doner|hummus|tahini|falafel|shawarma|greek|feta/i,
    [
      { id: "medi", label: "Mediterranean", term: "greek cafe music", why: "" },
      { id: "arab", label: "Arabic pop", term: "arabic pop", why: "" },
    ],
  ],
  [
    /bbq|brisket|burger|steak|ribs|chili/i,
    [
      { id: "outlaw", label: "Outlaw country", term: "outlaw country", why: "grill music" },
      { id: "southernrock", label: "Southern rock", term: "southern rock", why: "" },
    ],
  ],
]);

/** The default rotation when a recipe matches nothing above. Cooking is the
 *  one time of day he is standing up with his hands busy, so these lean
 *  listenable rather than demanding. */
const HOUSE = /** @type {Pick[]} */ ([
  { id: "jazz", label: "Kitchen jazz", term: "cooking jazz", why: "the reliable one" },
  { id: "soul", label: "Old soul", term: "classic soul", why: "" },
  { id: "lofi", label: "Lo-fi", term: "lofi beats", why: "background, no lyrics to follow" },
  { id: "afro", label: "Afrobeats", term: "afrobeats", why: "" },
  { id: "disco", label: "Disco", term: "70s disco", why: "for a long prep" },
]);

/** Training picks. A core session is 5 minutes, so these are short-fuse. */
const TRAINING = /** @type {Pick[]} */ ([
  { id: "hype", label: "Hype", term: "workout hype", why: "" },
  { id: "rap", label: "Gym rap", term: "gym rap", why: "" },
  { id: "phonk", label: "Phonk", term: "phonk", why: "" },
  { id: "rock", label: "Hard rock", term: "workout rock", why: "" },
]);

/**
 * An Apple Music link for a term. Storefront-relative, so it opens in the
 * Music app on his phone and in the web player on a laptop.
 * @param {string} term
 * @returns {string}
 */
export function musicUrl(term) {
  return `https://music.apple.com/us/search?term=${encodeURIComponent(term)}`;
}

/**
 * What to put on for a recipe. `n` cycles through the options for that theme,
 * so the button can offer something else without ever being random (random
 * can serve the same thing twice and feels broken).
 * @param {Record<string, any> | null | undefined} recipe
 * @param {number} [n]
 * @returns {Pick & { url: string }}
 */
export function pickForRecipe(recipe, n = 0) {
  const hay = [
    recipe?.name ?? "",
    ...(recipe?.tags ?? []),
    recipe?.cuisine ?? "",
    ...(recipe?.ingredients ?? []).map((/** @type {any} */ i) => i.food ?? ""),
  ]
    .join(" ")
    .toLowerCase();
  const themed = KITCHEN.find(([re]) => re.test(hay));
  const list = themed ? [...themed[1], ...HOUSE] : HOUSE;
  const pick = /** @type {Pick} */ (list[((n % list.length) + list.length) % list.length]);
  return { ...pick, url: musicUrl(pick.term) };
}

/**
 * What to put on for a training session.
 * @param {number} [n]
 * @returns {Pick & { url: string }}
 */
export function pickForTraining(n = 0) {
  const pick = /** @type {Pick} */ (
    TRAINING[((n % TRAINING.length) + TRAINING.length) % TRAINING.length]
  );
  return { ...pick, url: musicUrl(pick.term) };
}
