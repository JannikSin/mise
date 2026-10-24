// Camera-pantry: merge Worker scan results into pantry.json.
// Seen in the photo means owned: shelf-stable "staple" reads refresh the
// item's state to plenty (mirrors ownItemToPantry semantics); everything
// else lands as a dated row with today's date.

import {
  sectionOf,
  slug,
  pantryItems,
  packPantry,
  isDatedItem,
  looksPerishable,
  plentyKey,
} from "./shopping.js";
import { canonicalFood, knownFoods } from "./ingredients.js";

/**
 * SAY WHAT YOU HAVE (David, 2026-09-06: "I can just voice type in what I
 * have... I have soy sauce, I have sesame oil... run through all the things
 * that I have and then we can get the pantry up to date"). One dictated or
 * pasted run-through becomes pantry items, through the SAME apply path as an
 * approved photo scan, so nothing about how a row lands differs by door.
 *
 * A NOTE ONLY ADDS OR UPDATES (Mise 2.0, I-06; post-mortem 10/18, failure
 * 2). His 7:02 pm note saved "there is", "one", "other stuff" and "it's
 * about it" as foods, "pasta there's rice there's flat seed" as one food,
 * and "we need more vanilla extract" as PLENTY, then threw his words away.
 * So, in plain terms:
 *  - items split on commas, semicolons, newlines, sentence ends, " and ",
 *    " also ", " then ", " plus ", and at "there's", "there is", "we have",
 *    "I have", "I've got": a dictated list carries those, not commas
 *  - every piece must name a REAL FOOD (the bank's foods, the pantry's own
 *    foods, or the everyday foods below). Filler is dropped wherever it
 *    sits ("um", "other stuff", "that's it in the fridge"); words that are
 *    not filler and not a known food go to `unsure`, never to the pantry,
 *    so a mishearing is never saved as PLENTY
 *  - "low on X", "running low on X", "need more X", "we need X", "X is
 *    almost gone" mark X LOW, never plenty
 *  - "out of X", "no more X", "used up the X", "X is gone" never change
 *    anything here: they become `outs`, a suggestion he confirms with a tap
 *    (markPantryOut). A note never removes or zeroes a row by itself
 *  - a leading amount is kept as the row's qty ("2 lbs chicken thighs",
 *    "3 cans black beans", "a dozen eggs", "half a bag of rice")
 *  - "frozen X" goes to the freezer; a perishable by the expiry table's own
 *    keywords goes to the fridge, dated today; everything else is a
 *    shelf-stable state (plenty, or low when said)
 *  - `said` is his words exactly as they came in, kept with the saved note
 * The result is a PREVIEW the person edits before it lands; the reader
 * never writes.
 * @param {string} text
 * @param {Iterable<string>} [known] food names the app already knows (the
 *   pantry's rows first, then the bank's ingredients). A piece that matches
 *   one is saved under that name, so "oats" updates the pantry's "Rolled
 *   oats" row instead of adding a second one.
 * @returns {PantryNote}
 */
export function readPantryNote(text, known = []) {
  const said = String(text ?? "").trim();
  const vocab = noteVocab(known);
  // RUN-ON PHRASES SPLIT AT THE NEXT QUANTITY (David's dictation, 2026-09-06:
  // "milk a huge thing of soy sauce about a container of basil pesto" landed
  // as ONE pantry row holding two gallons). A spoken list rarely carries the
  // commas; what it carries is a new amount in front of each new food, so a
  // number or article followed by a pack word ("a container of", "two bricks
  // of", "a huge thing of", "about a tub of") starts a new item.
  const QTY_START =
    /(?<!\bhalf )(?<!\bof )\b(?=(?:about\s+|roughly\s+|like\s+)?(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a couple of|a few|some|\d+(?:[./]\d+)?)\s+(?:(?:huge|big|large|giant|small|little|whole|new|full|half)\s+)?(?:things?|tubs?|cartons?|bricks?|blocks?|containers?|jars?|bottles?|bags?|box(?:es)?|cans?|packs?|packages?|jugs?|gallons?|quarts?|pints?|dozen|pounds?|lbs?|bunch(?:es)?|heads?|loa(?:f|ves)|sticks?|cups?|liters?|litres?)\b)/i;
  const raw = said
    .replace(/\r/g, "")
    .replace(/[’‘]/g, "'")
    // A HEDGE MEANS UNSURE (Tribunal Final Gate, 1.95: "not sure about pnut
    // butter" was saved PLENTY). Every spoken hedge is folded to "maybe" here,
    // before the split below, because "I don't know if we have X" would
    // otherwise be cut at "we have" and strand the hedge from its food.
    .replace(
      /\b(?:(?:i|we)(?:'m| am|'re| are)\s+)?(?:(?:i|we) (?:do not|don't|dont) know (?:if|whether)|(?:i'm|i am|we're|we are)? ?not (?:sure|certain) (?:about|if|whether)|(?:i'm|i am|we're|we are)? ?not (?:sure|certain)|maybe|unsure about)\s+(?:(?:(?:we|i)(?:'ve got|'ve| have| got)|there(?:'s| is| are))\s+)?/gi,
      "maybe ",
    )
    // THE PHONE WRITES "there's pasta there's rice" (10/18): each "there's"
    // or "I have" starts a new food, exactly like a comma would
    .split(
      /(\n|[,;]|\.\s+|\.$|\band\b|\bor\b|\bbut\b|\balso\b|\bthen\b|\bplus\b|\bthere(?:'s| is| are)\b|\b(?:i|we)(?:'ve got| have| got|'ve)\b(?!\s+(?:to|got to)\b))/i,
    )
    // each piece remembers the word that split it off, so "out of eggs and
    // butter" keeps butter OUT (Tribunal Engineer, 1.95: butter was saved
    // PLENTY). Only a list joiner carries the out on; a new sentence, "also",
    // "there's", "I have", "but" or "then" ends it.
    .flatMap((s, i, all) =>
      i % 2 === 1
        ? []
        : s.split(QTY_START).map((t) => ({ text: t.trim(), joiner: i > 0 && /^(?:,|and|or|plus)$/i.test(String(all[i - 1]).trim()) })),
    )
    .filter((p) => p.text);
  /** @type {PantryNote["items"]} */
  const items = [];
  /** @type {PantryNote["unsure"]} */
  const unsure = [];
  /** @type {PantryNote["outs"]} */
  const outs = [];
  const seen = new Set();
  const seenUnsure = new Set();
  const seenOut = new Set();
  const doubt = (/** @type {string} */ words) => {
    const name = words.replace(/\s+/g, " ").trim().toLowerCase();
    if (name.length < 3 || seenUnsure.has(name)) return;
    seenUnsure.add(name);
    const guess = closestFood(name, vocab);
    unsure.push(guess ? { name, guess } : { name });
  };
  let outCarry = false;
  let hedgeCarry = false;
  for (const { text: rawPiece, joiner } of raw) {
    let piece = rawPiece;
    if (!joiner) {
      outCarry = false;
      hedgeCarry = false;
    }
    // a hedged piece, and the foods joined to it ("maybe rice and beans"),
    // are only ever doubts
    /** @type {boolean} */
    let hedged = hedgeCarry;
    // said as a have ("and have eggs", "got milk"), read BEFORE the verb is
    // peeled below, so a carried "out of" never takes it (Tribunal, loop 3)
    const saidHave = /^(?:(?:i|we)(?:'ve)?\s+)?(?:still\s+|just\s+|also\s+)?(?:have|got(?!\s+rid\b)|picked up|bought|brought home|grabbed)\b/i.test(piece);
    // filler at the front, peeled until none is left: the way people
    // actually talk into a phone ("um so I have soy sauce")
    for (let prev = ""; prev !== piece;) {
      prev = piece;
      piece = piece
        .replace(
          /^(?:um+|uh+|okay|ok|so|yeah|yes|well|oh|like|basically|anyway|about|roughly)\b[\s,]*/i,
          "",
        )
        .replace(
          /^(?:i|we)(?:'ve| have| got(?!\s+rid\b)|'ve got| also have| still have| do have| know we have| think we have)\b(?!\s+(?:to|got to|rid)\b)\s*/i,
          "",
        )
        .replace(/^(?:there(?:'s| is| are))\s+/i, "")
        .replace(/^(?:what i think is|i think(?: it's| its| it is)?|i know)\s+/i, "")
        .replace(/^(?:(?:i|we)\s+)?(?:just\s+)?(?:got(?!\s+rid\b)|have|having|picked up|bought|brought home|grabbed)(?:\s+|$)/i, "")
        .replace(/^maybe\s+/i, () => {
          hedged = true;
          return "";
        })
        // "a huge thing of X": an amount nobody can count, so it is X, no qty
        .replace(
          /^(?:a|an|one|\d+)\s+(?:(?:huge|big|large|giant|small|little|whole|new|full)\s+)?things?\s+of\s+/i,
          "",
        )
        // "a huge tub of X" reads as "a tub of X": the size word is not a unit
        .replace(
          /^((?:a|an|one|two|three|four|five|six|\d+)\s+)(?:huge|big|large|giant|small|little|whole|new|full)\s+/i,
          "$1",
        )
        .trim();
    }
    piece = piece.replace(/[.!?]+$/g, "").trim();
    if (!piece) continue;
    // SOUNDS LIKE A REMOVAL: a suggestion he taps, never a change (I-06).
    // Checked after LOW's "almost out of" and "running out of" below would
    // be wrong, so those are excluded here by the anchor and the lookbehind.
    const outM =
      piece.match(
        /^(?:(?:we're|we are|i'm|i am|we|i)\s+)?(?:all\s+)?(?:out of|ran out of|run out of|used(?: up)? all(?: of)?|used up|finished(?: off)?|ate all(?: of)?|threw (?:out|away)|tossed|got rid of|get rid of|remove|take off|don't have(?: any)?|do not have(?: any)?|no longer have|no more|none(?: of(?: the)?)?|zero|no)\s+(.+)$/i,
      ) ??
      piece.match(/^(.+?)(?:\s+(?:is|are)|'s)\s+(?:all\s+)?(?:gone|out|finished|used up|empty)$/i) ??
      // "out of eggs and butter": butter shares the out, a suggestion only
      (outCarry && !saidHave && !/^(?:(?:running |getting )?low on|(?:almost|nearly|running|getting) out of|(?:need|could use|buy|get)\b|plenty of|lots of|(?:still\s+)?(?:have|got)\b|\d|a dozen|two dozen|half\b|(?:a|an|one|some|a few|a couple of)\s|(?:two|three|four|five|six|seven|eight|nine|ten|twelve)\b)/i.test(piece) ? [piece, piece] : null);
    if (outM) {
      outCarry = true;
      const name = cleanFood(/** @type {string} */ (outM[1]));
      for (const food of segmentFoods(name, vocab).foods) {
        const key = slug(food.name);
        if (seenOut.has(key)) continue;
        seenOut.add(key);
        outs.push({ name: food.name });
      }
      continue;
    }
    /** @type {"low" | undefined} */
    let state;
    const lowM =
      piece.match(
        /^(?:(?:we're|we are|i'm|i am)\s+)?(?:(?:running |getting )?low on|(?:almost|nearly|running|getting) out of|not (?:much|a lot of|many)|only a (?:little|bit of|few)|last of the|barely any|(?:(?:we|i)(?:'ve)?\s+)?(?:really |still |definitely )?(?:need|needs|could use|(?:gotta|have to|got to|should|must) (?:get|buy|pick up))(?: to (?:get|buy))?(?: more| some| a new| another)?|(?:buy|get|pick up)(?: more| some)?)\s+(.+)$/i,
      ) ??
      piece.match(
        /^(.+?)(?:\s+(?:is|are)|'s)\s+(?:running |getting )?(?:low|almost gone|nearly gone|almost out|almost empty|running out)$/i,
    );
    if (lowM) {
      state = "low";
      piece = /** @type {string} */ (lowM[1]);
    } else {
      piece = piece.replace(/^(?:plenty of|lots of|loads of|a lot of|tons of|enough)\s+/i, "");
    }
    piece = cleanFood(piece);
    hedgeCarry = hedged;
    // a leading amount, kept as the row's qty
    let qty = "";
    let zero = false;
    const qtyM = piece.match(
      /^((?:\d+(?:[./]\d+)?|half a|half an|half|a dozen|two dozen|a|an|one|two|three|four|five|six|eight|ten|twelve)\s*(?:lbs?|pounds?|oz|ounces?|kgs?|kilos?|grams?|g|liters?|litres?|l|ml|gallons?|quarts?|pints?|cups?|cans?|jars?|bottles?|bags?|boxes?|packs?|packages?|packets?|tubs?|cartons?|bunch(?:es)?|heads?|loaves|loaf|dozen|sticks?|blocks?|bricks?|jugs?|containers?)?)\s+(?:of\s+)?(.+)$/i,
    );
    if (qtyM) {
      const amount = /** @type {string} */ (qtyM[1]).trim().toLowerCase();
      piece = /** @type {string} */ (qtyM[2]).trim();
      // A COUNT OF ZERO IS AN OUT, NEVER A QTY (Tribunal Final Gate, 1.95:
      // "I have 0 eggs" landed qty 0 and zeroed his eggs row). Like every
      // other out it is a suggestion he confirms with MARK OUT (I-06).
      zero = /^0+(?:\s|$)/.test(amount);
      // a bare article is not a quantity ("a spinach" is just spinach)
      if (!zero && !/^(?:a|an|one)$/.test(amount)) {
        qty = amount
          .replace(/^half an? /, "0.5 ")
          .replace(/^half$/, "0.5")
          .replace(/^a dozen$/, "1 dozen")
          .replace(/^two dozen$/, "2 dozen")
          .replace(/^an? /, "1 ")
          .replace(/^one /, "1 ")
          .replace(/^two /, "2 ")
          .replace(/^three /, "3 ")
          .replace(/^four /, "4 ")
          .replace(/^five /, "5 ")
          .replace(/^six /, "6 ")
          .replace(/^eight /, "8 ")
          .replace(/^ten /, "10 ")
          .replace(/^twelve /, "12 ");
      }
    }
    piece = piece.replace(/\s+/g, " ").trim();
    if (!piece || piece.length > 80) {
      if (piece) doubt(piece);
      continue;
    }
    const { foods, leftover } = segmentFoods(piece, vocab);
    for (const words of leftover) doubt(words);
    if (zero) {
      outCarry = true;
      for (const food of foods) {
        const key = slug(food.name);
        if (seenOut.has(key)) continue;
        seenOut.add(key);
        outs.push({ name: food.name });
      }
      continue;
    }
    if (hedged) {
      // unsure, with no guess: the food itself was heard, only the claim
      // that he has it was hedged
      for (const food of foods) {
        const name = food.name.toLowerCase();
        if (seenUnsure.has(name)) continue;
        seenUnsure.add(name);
        unsure.push({ name });
      }
      continue;
    }
    foods.forEach((food, at) => {
      const name = food.name;
    const key = slug(name);
      if (seen.has(key)) return;
    seen.add(key);
      // the amount was said in front of the first food in the piece
      const q = at === 0 ? qty : "";
      // LOW IS A STATE, whatever the food (I-06): "running low on milk" used
      // to land milk as a fresh row dated today, which told the list he had
      // just bought it. LOW puts it on the next list, which is what he meant.
      if (state === "low") {
        items.push({ name, kind: "staple", qty: "", state, location: "unsorted" });
        return;
      }
    const frozen = /\bfrozen\b/i.test(name);
    // A COUNT IS INVENTORY (David, 2026-09-06: "it should know how many
    // lemons"). Anything said with an amount becomes a counted, dated row
    // even when the food is shelf-stable, because a staple row has no
    // quantity at all and "5 lemons" would have landed as a bare PLENTY.
    // Cans and jars go to the pantry shelf whatever the food inside sounds
    // like: "6 cans of coconut milk" is not fridge food.
      const canned = /\b(?:cans?|jars?|tins?)\b/i.test(q) || /\bcanned\b/i.test(name);
    const perishable = !canned && looksPerishable(name);
      const fresh = frozen || perishable || Boolean(q);
      items.push({
      name,
      kind: fresh ? "fresh" : "staple",
        qty: q,
      location: frozen ? "freezer" : perishable ? "fridge" : fresh ? "pantry" : "unsorted",
    });
    });
  }
  return { said, items, unsure, outs };
}

/**
 * The read-back's rows alone, for callers that only land foods (the walk's
 * merge, older tests). Same reader, so the same promises hold.
 * @param {string} text
 * @param {Iterable<string>} [known]
 * @returns {PantryNote["items"]}
 */
export function parsePantryDictation(text, known) {
  return readPantryNote(text, known).items;
}

/**
 * @typedef {{
 *   said: string,
 *   items: { name: string, kind: "staple" | "fresh", qty: string, state?: "low", location: "fridge" | "freezer" | "pantry" | "unsorted" }[],
 *   unsure: { name: string, guess?: string }[],
 *   outs: { name: string }[],
 * }} PantryNote
 */

/** "some", "the", trailing punctuation: never part of a food's name */
function cleanFood(/** @type {string} */ s) {
  return s
    .replace(
      /^(?:some|a few|a couple of|a couple|a bunch of|a bit of|any|the|my|our|all the)\s+/i,
      "",
    )
    .replace(/[.!?]+$/g, "")
    .trim();
}

// WORDS THAT ARE NEVER A FOOD on their own, wherever they sit in a piece
// (10/18: "there is", "one", "other stuff", "it's about it", "that's it in
// the fridge in the freezer" all became pantry rows). Compared with the
// apostrophes taken out, so "that's" is "thats".
const FILLER = new Set(
  (
    "um umm uh uhh er erm hmm so okay ok yeah yep yes no well oh like basically anyway " +
    "i im ive id we were weve wed you youre it its itll that thats this these those " +
    "there theres here is are was be been being have has had having got get gotten " +
    "also and or then plus but more some any the a an of in on at to for from with " +
    "other others another stuff thing things about think thought know guess maybe " +
    "probably kind sort just really still actually lot lots one ones all too what whats " +
    "else fridge freezer pantry cupboard cabinet counter shelf shelves door drawer " +
    "my our me us left bit little few couple bunch enough plenty much many good fine " +
    "pretty okay right now today also again both each every same different new old " +
    "need want see look looks looking guess pretty"
  ).split(" "),
);

// Words that describe a food without being one ("sharp cheddar", "dried
// figs"): these ride along with the food that follows them, always.
const DESCRIBES = new Set(
  (
    "fresh frozen canned sharp spicy sweet plain organic ground dried whole raw smoked " +
    "salted unsalted large small baby red green white brown black yellow dark light " +
    "extra virgin low fat free greek italian mild hot thick thin roasted toasted sliced " +
    "shredded chopped diced crushed instant steel cut old fashioned"
  ).split(" "),
);

// EVERYDAY FOODS a kitchen holds that the bank's own table may not name yet
// (figs, dates and protein powder were in David's 10/18 note). The view adds
// the pantry's foods and every bank ingredient on top of these.
const COMMON_FOODS = (
  "rice, white rice, jasmine rice, basmati rice, pasta, spaghetti, penne, macaroni, " +
  "noodles, ramen, rice noodles, lasagna noodles, quinoa, couscous, oats, oatmeal, flour, " +
  "sugar, brown sugar, powdered sugar, salt, pepper, olive oil, vegetable oil, canola " +
  "oil, coconut oil, avocado oil, butter, ghee, milk, cream, heavy cream, sour cream, " +
  "cream cheese, cheese, cheddar, mozzarella, parmesan, feta, ricotta, string cheese, " +
  "yogurt, greek yogurt, kefir, eggs, bread, bagels, tortillas, pita, naan, english " +
  "muffins, crackers, cereal, granola, chips, tortilla chips, popcorn, pretzels, nuts, " +
  "almonds, walnuts, pecans, cashews, peanuts, pistachios, peanut butter, almond butter, " +
  "jam, jelly, honey, maple syrup, syrup, vanilla, vanilla extract, baking soda, baking " +
  "powder, yeast, cocoa powder, cocoa, chocolate, chocolate chips, cornstarch, vinegar, " +
  "apple cider vinegar, balsamic vinegar, rice vinegar, soy sauce, hot sauce, ketchup, " +
  "mustard, mayo, mayonnaise, salsa, pesto, basil pesto, sriracha, tahini, hummus, " +
  "coconut milk, broth, stock, chicken broth, vegetable broth, tomato sauce, pasta sauce, " +
  "marinara, tomato paste, canned tomatoes, diced tomatoes, crushed tomatoes, beans, " +
  "black beans, pinto beans, kidney beans, chickpeas, lentils, tuna, salmon, shrimp, cod, " +
  "tilapia, fish, chicken, chicken breast, chicken thighs, ground beef, beef, steak, " +
  "pork, bacon, sausage, ham, turkey, ground turkey, tofu, tempeh, edamame, protein " +
  "powder, whey, whey protein, protein bars, dates, figs, raisins, dried fruit, dried " +
  "apricots, prunes, dried cranberries, flaxseed, flax seed, flax seeds, ground flaxseed, " +
  "chia seeds, hemp seeds, hemp hearts, sunflower seeds, pumpkin seeds, sesame seeds, " +
  "apples, bananas, oranges, lemons, limes, grapes, strawberries, blueberries, " +
  "raspberries, blackberries, berries, mixed berries, cherries, mango, pineapple, " +
  "peaches, pears, watermelon, melon, kiwi, avocado, tomatoes, cucumber, lettuce, " +
  "spinach, kale, arugula, cabbage, broccoli, cauliflower, carrots, celery, onions, red " +
  "onion, garlic, ginger, potatoes, sweet potatoes, peppers, bell peppers, jalapenos, " +
  "mushrooms, zucchini, squash, corn, peas, green beans, asparagus, snap peas, bok choy, " +
  "cilantro, parsley, basil, mint, dill, scallions, green onions, herbs, vegetables, " +
  "mixed vegetables, frozen vegetables, fruit, ice cream, pizza, waffles, juice, orange " +
  "juice, coffee, tea, sparkling water, soda, wine, beer, cinnamon, cumin, paprika, chili " +
  "powder, oregano, thyme, rosemary, turmeric, garlic powder, onion powder, curry powder, " +
  "red pepper flakes, nutmeg, bay leaves, spices, seasoning, italian seasoning, taco " +
  "seasoning, oat milk, almond milk, soy milk, cottage cheese, deli meat, lunch meat, hot " +
  "dogs, meatballs, dumplings, gnocchi, pancake mix, olives, pickles, capers, miso, " +
  "gochujang, curry paste, fish sauce, oyster sauce, worcestershire sauce, teriyaki " +
  "sauce, bbq sauce, ranch"
).split(/\s*,\s*/);

/**
 * Every food name the note reader accepts, keyed both ways the pantry
 * matches (canonical and plenty key, so "figs" is "fig"). A key maps to the
 * name to save under when it came from the pantry or the bank, or to "" for
 * the built-in lists (then his own word is kept).
 * @param {Iterable<string>} known
 * @returns {Map<string, string>}
 */
function noteVocab(known) {
  /** @type {Map<string, string>} */
  const m = new Map();
  const add = (/** @type {string} */ food, /** @type {string} */ as) => {
    const f = String(food ?? "").trim();
    if (!f) return;
    for (const k of [canonicalFood(f), plentyKey(f)]) {
      if (k && (!m.has(k) || (as && !m.get(k)))) m.set(k, as);
    }
  };
  for (const f of known ?? []) add(f, String(f ?? "").trim());
  for (const f of knownFoods()) add(f.replace(/-/g, " "), "");
  for (const f of COMMON_FOODS) add(f, "");
  return m;
}

/**
 * Split a piece into the foods it names. The longest known run of words
 * wins; up to two unknown words right before a food are its describing words
 * ("sharp cheddar cheese", "boy Scout popcorn"); filler is skipped; any other
 * unknown run is leftover, which the reader shows as "not sure".
 * @param {string} piece
 * @param {Map<string, string>} vocab
 * @returns {{ foods: { name: string }[], leftover: string[] }}
 */
function segmentFoods(piece, vocab) {
  const words = piece.split(/\s+/).filter(Boolean);
  const bare = (/** @type {string} */ w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
  const lookup = (/** @type {string} */ phrase) => {
    for (const k of [canonicalFood(phrase), plentyKey(phrase)]) {
      if (vocab.has(k)) return /** @type {string} */ (vocab.get(k));
    }
    return null;
  };
  /** @type {{ name: string }[]} */
  const foods = [];
  /** @type {string[]} */
  const leftover = [];
  /** @type {string[]} */
  let pending = [];
  const flush = () => {
    if (pending.length) leftover.push(pending.join(" "));
    pending = [];
  };
  for (let i = 0; i < words.length;) {
    let hit = 0;
    let as = "";
    for (let n = Math.min(5, words.length - i); n >= 1; n--) {
      const phrase = words.slice(i, i + n).join(" ");
      const found = lookup(phrase);
      if (found !== null) {
        hit = n;
        as = found;
        break;
      }
    }
    if (hit) {
      if (pending.length > 2) flush();
      if (pending.length && !pending.every((w) => DESCRIBES.has(bare(w)))) {
        // UNKNOWN WORDS GLUED ONTO A KNOWN FOOD DO NOT RIDE ALONG WHEN THEY
        // SOUND LIKE A FOOD (Tribunal Final Gate, 1.95: "flat seed rice" was
        // one row, "pnut butter" a staple). The whole run close to a known
        // food ("pnut butter" is "peanut butter") is one misheard food and
        // saves nothing; words close to a known food on their own ("flat
        // seed") are doubted and the food that follows is kept by itself.
        const lead = pending.join(" ");
        const food = words.slice(i, i + hit).join(" ");
        if (closestFood(`${lead} ${food}`, vocab)) {
          leftover.push(`${lead} ${food}`);
          pending = [];
          i += hit;
          continue;
        }
        if (closestFood(lead, vocab)) {
          flush();
        }
      }
      const said = [...pending, ...words.slice(i, i + hit)].join(" ");
      // his own word unless the pantry or bank already names this food, and
      // only when nothing describes it ("oats" saves as the pantry's
      // "Rolled oats"; "frozen berries" stays as said)
      foods.push({
        name: as && pending.length === 0 ? as : said.charAt(0).toLowerCase() + said.slice(1),
      });
      pending = [];
      i += hit;
      continue;
    }
    if (FILLER.has(bare(/** @type {string} */ (words[i])))) flush();
    else pending.push(/** @type {string} */ (words[i]));
    i++;
  }
  flush();
  return { foods, leftover };
}

/**
 * The known food a misheard phrase most likely was ("flat seed" is one
 * letter from "flaxseed"), or undefined. Only close calls: two edits at most,
 * on phrases of five letters or more, so a guess is a help and never a leap.
 * @param {string} phrase
 * @param {Map<string, string>} vocab
 * @returns {string | undefined}
 */
function closestFood(phrase, vocab) {
  const target = phrase.toLowerCase().replace(/[^a-z]/g, "");
  if (target.length < 5) return undefined;
  let best = /** @type {string | undefined} */ (undefined);
  let bestD = 3;
  for (const [key, as] of vocab) {
    const cand = key.replace(/-/g, "");
    if (Math.abs(cand.length - target.length) >= bestD) continue;
    const d = editDistance(target, cand);
    if (d < bestD) {
      bestD = d;
      best = as || key.replace(/-/g, " ");
    }
  }
  return best;
}

/** Levenshtein distance, small strings only */
function editDistance(/** @type {string} */ a, /** @type {string} */ b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        /** @type {number} */ (prev[j]) + 1,
        /** @type {number} */ (cur[j - 1]) + 1,
        /** @type {number} */ (prev[j - 1]) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return /** @type {number} */ (prev[b.length]);
}

/**
 * Does MARK OUT have anything to change for this food? The read-back shows
 * the button only when it would.
 * @param {Record<string, any>} pantry
 * @param {string} food
 * @returns {boolean}
 */
export function outMatches(pantry, food) {
  const key = plentyKey(food);
  return pantryItems(pantry).some(
    (it) => plentyKey(String(it.food)) === key && (isDatedItem(it) || Boolean(it.state)),
  );
}

/**
 * MARK OUT, the one tap that confirms an "out of X" from a note (I-06): a
 * shelf-stable row of that food goes to OUT (no state, buys on need), and a
 * counted row of it comes off the shelf. Only ever called from his tap.
 * @param {Record<string, any>} pantry
 * @param {string} food
 * @returns {Record<string, any>} new pantry (input untouched)
 */
export function markPantryOut(pantry, food) {
  const key = plentyKey(food);
  /** @type {Record<string, any>[]} */
  const next = [];
  for (const it of pantryItems(pantry)) {
    if (plentyKey(String(it.food)) !== key) {
      next.push(it);
      continue;
    }
    if (isDatedItem(it)) continue;
    const rest = { ...it };
    delete rest.state;
    next.push(rest);
  }
  return packPantry(next);
}

/** the most notes kept: about two months of weekly Sunday notes, with room */
export const PANTRY_NOTES_KEPT = 30;

/**
 * HIS WORDS ARE KEPT (I-06, post-mortem 10/18: "your original words weren't
 * kept anywhere"). One note per ADD: what he said, word for word, beside
 * what was saved from it, what the reader was not sure of, and the outs he
 * was offered. Household sibling file to pantry.json, like waste.json:
 * households/<h>/pantry-notes.json, shape { notes: [...] }, newest last.
 * @param {Record<string, any> | null | undefined} existing the file as read
 * @param {{ said: string, saved: Record<string, any>[], unsure: string[], outs: { name: string, marked: boolean }[], by?: string }} note
 * @param {Date} now
 * @returns {{ notes: Record<string, any>[] }}
 */
export function appendPantryNote(existing, note, now) {
  const notes = Array.isArray(existing?.notes) ? existing.notes.slice() : [];
  const at = now.toISOString();
  // unique per note: the 409 keyed-array merge keys on `id`
  const id = `${at}|${note.by ?? ""}`;
  if (!notes.some((/** @type {any} */ n) => n?.id === id)) {
    notes.push({
      id,
      at,
      ...(note.by ? { by: note.by } : {}),
      said: String(note.said ?? ""),
      saved: note.saved,
      unsure: note.unsure,
      outs: note.outs,
    });
  }
  return { notes: notes.slice(-PANTRY_NOTES_KEPT) };
}

/**
 * @param {Record<string, any>} pantry
 * @param {{ name: string, kind: string, qty: string, state?: string }[]} items approved scan items
 *   (`state: "low"` on a staple, from the dictation parser, lands it LOW
 *   instead of plenty: "running low on rice" is exactly the thing the list
 *   should buy next)
 * @param {string} todayIso local YYYY-MM-DD
 * @param {string} [location] shelf the new dated rows land on (fresh-start
 *   wizard's "another photo of the same shelf" is additive but still placed).
 *   Absent = legacy behavior: no location, rows read as "unsorted".
 * @returns {Record<string, any>} new pantry (input untouched)
 */
export function applyScanItems(pantry, items, todayIso, location) {
  const next = [...pantryItems(pantry)];

  for (const item of items) {
    const name = item.name.trim();
    if (!name) continue;
    if (item.kind === "staple") {
      const id = slug(name);
      const at = next.findIndex((it) => !isDatedItem(it) && it.id === id);
      const state = item.state === "low" ? "low" : "plenty";
      if (at >= 0) {
        next[at] = { ...next[at], state };
      } else {
        next.push({ id, food: name, section: sectionOf(name), state });
      }
    } else {
      // slug-dedupe so weekly re-scans ("Half-Cabbage" vs "half cabbage")
      // don't pile up duplicates. A duplicate is REFRESHED, not skipped
      // (Tribunal 2026-08-01): the camera is looking at the shelf right now,
      // so its reading beats a stale row — including one another device's
      // concurrent edit resurrected through the merge mid-wizard. SHELF-
      // AWARE (Tribunal B3): a fridge scan refreshes only a fridge row —
      // rewriting the freezer's pack of the same food would teleport it
      // between shelves and reset its age. Same food on another shelf gets
      // its own new row.
      const key = slug(name);
      // A NUMBER REPLACES A WORD (David, 2026-09-07): a counted row of a food
      // retires its bare PLENTY assertion, or the list would keep skipping
      // the food on the strength of the word while the count said otherwise.
      if (item.qty) {
        const canon = canonicalFood(name);
        for (let i = next.length - 1; i >= 0; i--) {
          const it = /** @type {any} */ (next[i]);
          if (!isDatedItem(it) && (it.id === key || canonicalFood(String(it.food)) === canon)) {
            next.splice(i, 1);
          }
        }
      }
      const dup = next.findIndex(
        (it) =>
          isDatedItem(it) &&
          slug(String(it.food)) === key &&
          (!location || (it.location ?? "unsorted") === location),
      );
      if (dup >= 0) {
        next[dup] = {
          ...next[dup],
          ...(item.qty ? { qty: item.qty } : {}),
          added: todayIso,
          ...(location ? { location } : {}),
        };
        continue;
      }
      next.push({
        id: crypto.randomUUID().slice(0, 8),
        food: name,
        qty: item.qty ?? "",
        added: todayIso,
        useSoon: false,
        ...(location ? { location } : {}),
      });
    }
  }
  return packPantry(next);
}

/**
 * WALK THE FRIDGE (David, 2026-10-18: "can I record a video, roll it past all
 * the shelves inside the fridge, and narrate everything? Can you process that
 * and update things?"). P6, the pantry is spent before it is replaced.
 *
 * Where in a clip to take its frames: `count` evenly spaced, each in the
 * middle of its slice, so neither the first frame (the phone still finding
 * focus) nor the last (the thumb reaching for stop) is used. A clip with no
 * readable length gives none, and the view says so instead of guessing.
 * @param {number} duration seconds
 * @param {number} [count]
 * @returns {number[]} seconds into the clip
 */
export function frameTimes(duration, count = 8) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const n = Math.max(1, Math.min(12, Math.round(count)));
  return Array.from({ length: n }, (_, i) => ((i + 0.5) * duration) / n);
}

/** a leading amount as a number ("2 lbs" 2, "half a bag" 0.5), or null */
function leadingAmount(/** @type {string} */ qty) {
  const s = String(qty ?? "").trim().toLowerCase();
  if (!s) return null;
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)/);
  if (frac) return Number(frac[1]) / Math.max(1, Number(frac[2]));
  const num = s.match(/^\d+(?:\.\d+)?/);
  if (num) return Number(num[0]);
  if (/^(half|1\/2)\b/.test(s)) return 0.5;
  if (/^(a|an|one)\b/.test(s)) return 1;
  if (/^a couple\b|^two\b/.test(s)) return 2;
  if (/^a few\b|^three\b/.test(s)) return 3;
  return null;
}

/**
 * One read-back from a walk: every frame's items, merged by food, then the
 * narration on top. The same food seen in several frames is one row keeping
 * the LARGER amount (a shelf filmed twice is the same carton, not two). What
 * he SAYS wins over what a frame guessed whenever both name an amount, and a
 * food only said is added. The result is the dictation preview shape, so it
 * lands through the same READ IT BACK, drop, ADD path as SAY WHAT YOU HAVE.
 * @param {{ name: string, kind: string, qty: string }[][]} frames items per scanned frame
 * @param {string} narration what he said while filming (may be empty)
 * @param {Iterable<string>} [known] food names the app knows (readPantryNote)
 * @returns {ReturnType<typeof parsePantryDictation>}
 */
export function mergeFridgeWalk(frames, narration, known) {
  /** @type {Map<string, ReturnType<typeof parsePantryDictation>[number]>} */
  const byFood = new Map();
  for (const items of frames ?? []) {
    for (const it of items ?? []) {
      const name = String(it?.name ?? "").trim();
      if (!name) continue;
      const key = canonicalFood(name);
      const kind = it.kind === "staple" ? "staple" : "fresh";
      const row = {
        name,
        kind: /** @type {"staple" | "fresh"} */ (kind),
        qty: String(it.qty ?? ""),
        // a walk is of the fridge: what it sees fresh is dated there today
        location: /** @type {"fridge" | "unsorted"} */ (kind === "fresh" ? "fridge" : "unsorted"),
      };
      const had = byFood.get(key);
      if (!had) {
        byFood.set(key, row);
        continue;
      }
      const a = leadingAmount(had.qty);
      const b = leadingAmount(row.qty);
      if ((b !== null && (a === null || b > a)) || (!had.qty && row.qty)) {
        byFood.set(key, { ...had, qty: row.qty });
      }
    }
  }
  for (const said of parsePantryDictation(narration, known)) {
    const key = canonicalFood(said.name);
    const had = byFood.get(key);
    // his words win: amount, low, and where it lives
    byFood.set(key, had ? { ...had, ...said, name: had.name, qty: said.qty || had.qty } : said);
  }
  return [...byFood.values()];
}

// ---------------------------------------------------------------------------
// THE WALK'S OWN NARRATION (P6, David 2026-10-18: "show everything and also
// narrate everything"). He talks while he films, so the words are already in
// the video; v1.7 made him type them again. These three pure steps turn the
// decoded audio into a small WAV the Worker can transcribe: one channel,
// 16 kHz (what Whisper listens at), 16-bit samples. 90 seconds of that is
// about 2.9 MB, so the clip itself never leaves the phone.
// ---------------------------------------------------------------------------

/** The longest narration sent: past this the walk is trimmed, and says so. */
export const NARRATION_MAX_SECONDS = 90;
/** The sample rate Whisper expects. */
export const NARRATION_RATE = 16000;

/**
 * Average every channel into one.
 * @param {Float32Array[]} channels
 * @returns {Float32Array}
 */
export function downmixToMono(channels) {
  const live = (channels ?? []).filter((c) => c && c.length > 0);
  if (live.length === 0) return new Float32Array(0);
  if (live.length === 1) return /** @type {Float32Array} */ (live[0]);
  const n = Math.min(...live.map((c) => c.length));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const c of live) sum += /** @type {number} */ (c[i]);
    out[i] = sum / live.length;
  }
  return out;
}

/**
 * Linear resampling to `toRate`. Plenty for speech headed to a transcriber,
 * and it keeps the step pure and testable.
 * @param {Float32Array} samples
 * @param {number} fromRate
 * @param {number} [toRate]
 * @returns {Float32Array}
 */
export function resampleLinear(samples, fromRate, toRate = NARRATION_RATE) {
  if (!samples || samples.length === 0 || !(fromRate > 0)) return new Float32Array(0);
  if (fromRate === toRate) return samples;
  const outLen = Math.max(1, Math.floor((samples.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const step = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = /** @type {number} */ (samples[j] ?? 0);
    const b = /** @type {number} */ (samples[j + 1] ?? a);
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * PCM16 mono WAV bytes (44-byte RIFF header + little-endian samples, clipped
 * to [-1, 1]).
 * @param {Float32Array} samples
 * @param {number} [rate]
 * @returns {Uint8Array}
 */
export function encodeWav16(samples, rate = NARRATION_RATE) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (/** @type {number} */ at, /** @type {string} */ s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, /** @type {number} */ (samples[i])));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/**
 * Decoded audio (an AudioBuffer-like: sampleRate, numberOfChannels,
 * getChannelData) to narration WAV bytes, capped at NARRATION_MAX_SECONDS.
 * @param {{ sampleRate: number, numberOfChannels: number, length: number, getChannelData: (i: number) => Float32Array }} audio
 * @returns {{ wav: Uint8Array, trimmed: boolean } | { reason: "no-audio" }}
 */
export function narrationWav(audio) {
  if (!audio || !(audio.numberOfChannels > 0) || !(audio.length > 0) || !(audio.sampleRate > 0)) {
    return { reason: "no-audio" };
  }
  const channels = [];
  for (let i = 0; i < audio.numberOfChannels; i++) channels.push(audio.getChannelData(i));
  const keep = Math.min(audio.length, Math.round(audio.sampleRate * NARRATION_MAX_SECONDS));
  const mono = downmixToMono(channels.map((c) => c.subarray(0, keep)));
  // silence is no narration: nothing above a whisper-quiet floor
  let peak = 0;
  for (let i = 0; i < mono.length; i += 64) peak = Math.max(peak, Math.abs(/** @type {number} */ (mono[i])));
  if (peak < 0.01) return { reason: "no-audio" };
  return {
    wav: encodeWav16(resampleLinear(mono, audio.sampleRate)),
    trimmed: keep < audio.length,
  };
}
