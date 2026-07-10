// Rules-based remedies engine (blueprint §6.7). Pure code, so it works fully
// offline. Guidance is common home-care practice, not medical advice — the
// view carries the "see a doctor if..." line. Complex cases → ask Claude.

/**
 * @typedef {{ teas: string[], foods: string[], avoid: string[], notes: string[], recipeIds: string[] }} Protocol
 */

export const SYMPTOMS = [
  { id: "sore-throat", label: "sore throat" },
  { id: "congestion", label: "congestion" },
  { id: "nausea", label: "nausea" },
  { id: "low-energy", label: "low energy" },
  { id: "post-illness", label: "post-illness appetite" },
  { id: "stressed-down", label: "stressed / down" },
  { id: "headache", label: "headache" },
  { id: "muscle-soreness", label: "muscle soreness" },
  { id: "poor-sleep", label: "poor sleep" },
  { id: "coming-down-sick", label: "coming down with something" },
];

/** @type {Record<string, Protocol>} */
const RULES = {
  "sore-throat": {
    teas: ["ginger–honey–lemon tea", "chamomile before bed"],
    foods: ["warm congee", "honey by the spoon", "soft, warm food"],
    avoid: ["acidic juices", "rough or crunchy food", "shouting/straining your voice"],
    notes: ["warm salt-water gargle a few times a day", "keep drinks warm, not scalding"],
    recipeIds: ["ginger-honey-lemon-tea", "chicken-rice-congee"],
  },
  congestion: {
    teas: ["ginger tea with a pinch of cayenne", "peppermint tea"],
    foods: ["hot chicken–rice congee", "hot broth", "spicy food if you can handle it"],
    avoid: ["heavy dairy while blocked up", "dry rooms — crack a window or shower steam"],
    notes: ["long hot shower steam", "hydrate harder than feels necessary"],
    recipeIds: ["chicken-rice-congee", "ginger-honey-lemon-tea"],
  },
  nausea: {
    teas: ["plain ginger tea (skip the honey if sugar turns your stomach)", "peppermint tea"],
    foods: ["plain rice in small bites", "dry toast", "banana"],
    avoid: ["fatty or fried food", "strong smells", "big portions — graze instead"],
    notes: [
      "small sips of water constantly beats big glasses",
      "eat before you feel ready, tiny amounts",
    ],
    recipeIds: ["chicken-rice-congee"],
  },
  "low-energy": {
    teas: ["green tea — morning only"],
    foods: ["easy carbs + protein: smoothie or congee with an egg"],
    avoid: ["caffeine after noon", "sugar-crash snacks"],
    notes: [
      "check the sleep column first — low energy is usually sleep debt",
      "10-minute daylight walk works better than a third coffee",
    ],
    recipeIds: ["training-smoothie", "chicken-rice-congee"],
  },
  "post-illness": {
    teas: ["ginger–honey–lemon to ease back in"],
    foods: ["congee with chicken and egg", "yogurt", "smoothie — liquid calories count"],
    avoid: ["forcing full-size meals on day one", "greasy comeback meals"],
    notes: [
      "protein floor (~160g) matters more than the calorie target for a few days",
      "appetite lags recovery — small meals, more often",
    ],
    recipeIds: ["chicken-rice-congee", "training-smoothie", "cottage-cheese-pre-bed"],
  },
  headache: {
    teas: ["water first — a full glass, then reassess", "ginger tea if it's tension + nausea"],
    foods: ["something with salt if you've been sweating", "regular meal if you skipped one"],
    avoid: ["pushing through a screen session", "extra caffeine on top of a caffeine headache"],
    notes: [
      "most training-day headaches are hydration or a skipped meal",
      "dark room + 20 minutes beats toughing it out",
      "track if it follows heavy lifting days — mention the pattern to a doctor if regular",
    ],
    recipeIds: ["electrolyte-lemon-salt-drink"],
  },
  "muscle-soreness": {
    teas: ["ginger tea (mild anti-inflammatory)", "chamomile at night"],
    foods: ["protein at every meal — repair needs material", "berries + yogurt"],
    avoid: [
      "skipping the next session entirely — light movement clears soreness faster",
      "alcohol",
    ],
    notes: [
      "DOMS peaks ~48h and light cardio or a walk genuinely helps",
      "hot shower before bed, easy stretch after",
      "sharp or one-sided pain is not soreness — rest that and reassess",
    ],
    recipeIds: ["training-smoothie", "cottage-cheese-pre-bed"],
  },
  "poor-sleep": {
    teas: [
      "chamomile 30-60 min before bed",
      "nothing caffeinated after noon — including green tea",
    ],
    foods: ["normal dinner, not heavy, not late", "cottage cheese pre-bed if hungry"],
    avoid: [
      "screens in bed (the FITNESS.md rule exists for a reason)",
      "late heavy meals",
      "revenge bedtime scrolling",
    ],
    notes: [
      "magnesium glycinate per the plan",
      "wake time consistency matters more than bedtime",
      "one bad night changes nothing — protect the next one",
    ],
    recipeIds: ["cottage-cheese-pre-bed"],
  },
  "coming-down-sick": {
    teas: ["ginger–honey–lemon on repeat", "extra water beyond thirst"],
    foods: [
      "front-load protein while appetite lasts",
      "congee ready in the fridge beats deciding later",
    ],
    avoid: [
      "hard training — a walk is the ceiling today",
      "pretending it isn't happening until it's worse",
    ],
    notes: [
      "early rest is the highest-return move you have",
      "batch-cook the congee NOW while you still have energy",
      "sleep is the actual medicine — everything else is support",
    ],
    recipeIds: ["ginger-honey-lemon-tea", "chicken-rice-congee"],
  },
  "stressed-down": {
    teas: ["chamomile in the evening"],
    foods: ["regular meals — do not skip", "warm comfort food (bulgogi bowl counts)"],
    avoid: ["caffeine + doomscroll spiral", "alcohol as a fix", "skipping training entirely"],
    notes: [
      "magnesium at night per the plan",
      "a walk is the minimum effective dose",
      "tomorrow's plan pre-set = one less decision when flat",
    ],
    recipeIds: ["beef-bulgogi-rice-bowl", "cottage-cheese-pre-bed"],
  },
};

/**
 * Merge the protocols for the selected symptoms, deduping every list.
 * @param {string[]} symptomIds
 * @returns {Protocol | null}
 */
export function protocolFor(symptomIds) {
  /** @type {Protocol[]} */
  const matched = [];
  for (const id of symptomIds) {
    const rule = RULES[id];
    if (rule) matched.push(rule);
  }
  if (matched.length === 0) return null;
  /** @param {string[][]} lists */
  const merge = (lists) => [...new Set(lists.flat())];
  return {
    teas: merge(matched.map((p) => p.teas)),
    foods: merge(matched.map((p) => p.foods)),
    avoid: merge(matched.map((p) => p.avoid)),
    notes: merge(matched.map((p) => p.notes)),
    recipeIds: merge(matched.map((p) => p.recipeIds)),
  };
}
