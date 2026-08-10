// Writes the occasion-only recipe bank into seed-data/generated/recipes/.
//
// These are the foods an OCCASION places: clear liquids and low-residue meals
// for a colonoscopy prep, soft cold food after dental surgery, bland food for
// a stomach bug. Every one carries the `occasion-only` tag, which fences it
// out of `generatorEligible` permanently — apple juice is never a good Tuesday
// snack, and unlike `ai-special` there is no promotion that changes that.
//
// Food-group values are honestly ZERO across the board. That is the point:
// these meals deliberately fail the Daily Dozen, and pretending otherwise
// would let a floor pass reach for them. Nutrition is estimated and labelled.
//
// Run: node tools/make-occasion-recipes.mjs
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL("../seed-data/generated/recipes/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const ZERO_GROUPS = {
  beans: 0,
  berries: 0,
  otherFruit: 0,
  cruciferousVeg: 0,
  greens: 0,
  otherVeg: 0,
  flaxseed: 0,
  nuts: 0,
  spicesHerbs: 0,
  wholeGrains: 0,
  beverages: 0,
  method: "estimated",
};

/**
 * @param {object} spec
 */
function recipe(spec) {
  const {
    id,
    name,
    description,
    mealType,
    tags = [],
    ingredients,
    instructions,
    nutrition,
    totalTime = 5,
    servings = 1,
    groups = {},
    lessons = [],
  } = spec;
  return {
    id,
    name,
    description,
    servings,
    prepTime: Math.min(totalTime, 5),
    cookTime: Math.max(0, totalTime - Math.min(totalTime, 5)),
    totalTime,
    mealType,
    cuisine: "none",
    // occasion-only is the fence; the second tag says WHICH situation, so the
    // occasion editor can offer a swap from the right shelf
    tags: ["occasion-only", ...tags],
    difficulty: 1,
    purpose: ["sick-day"],
    effort: "assemble",
    ingredients,
    instructions: instructions.map((text, i) => ({ step: i + 1, text })),
    nutrition: { ...nutrition, method: "estimated" },
    foodGroups: { ...ZERO_GROUPS, ...groups },
    timesCooked: 0,
    lessons,
  };
}

const g = (qty, unit, food, extra = {}) => ({ qty, unit, food, ...extra });

const RECIPES = [
  // --- clear liquids -------------------------------------------------------
  recipe({
    id: "clear-broth-mug",
    name: "Clear Broth, a Mug",
    description:
      "Strained chicken or vegetable broth, drunk from a mug. On a clear-liquid day this is the closest thing to a meal you get, and the salt in it is doing real work.",
    mealType: "snack",
    tags: ["clear-liquid"],
    totalTime: 3,
    ingredients: [
      g(1.5, "cup", "chicken broth", {
        note: "or vegetable broth. Must be CLEAR: no noodles, no vegetables, nothing at the bottom",
      }),
    ],
    instructions: [
      "Heat the broth until steaming, not boiling.",
      "Strain it if there is anything at all floating in it. Clear means you can read through it.",
      "Drink it warm from a mug. Sipping it slowly makes it count for more than gulping it.",
    ],
    nutrition: { calories: 15, protein: 2, carbs: 1, fat: 0 },
    lessons: [
      "Bone broth is NOT a clear liquid. It is cloudy and it has fat in it. Use plain strained broth.",
    ],
  }),
  recipe({
    id: "clear-juice-glass",
    name: "Clear Juice",
    description:
      "Apple or white grape juice, no pulp. The two juices that stay legal on a clear-liquid day because you can see through them and neither is red or purple.",
    mealType: "snack",
    tags: ["clear-liquid"],
    totalTime: 1,
    ingredients: [
      g(1, "cup", "apple juice", { note: "or white grape juice. No pulp, nothing cloudy" }),
    ],
    instructions: ["Pour it. Over ice if that helps it go down."],
    nutrition: { calories: 115, protein: 0, carbs: 28, fat: 0 },
    lessons: ["Orange juice has pulp and is not clear. Grape juice that is purple is banned."],
  }),
  recipe({
    id: "lemon-gelatin-cup",
    name: "Lemon Gelatin",
    description:
      "Plain lemon or orange gelatin. It reads as food in a way liquid does not, which matters more than the calories on a long clear-liquid day.",
    mealType: "snack",
    tags: ["clear-liquid"],
    totalTime: 5,
    ingredients: [
      g(1, "cup", "gelatin dessert", {
        note: "LEMON, ORANGE or LIME only. Never red, purple or blue",
      }),
    ],
    instructions: [
      "Make it up per the box, or buy the cups ready made.",
      "Chill until set.",
      "Check the colour one more time. Red dye reads as blood on the camera and the whole procedure gets called off.",
    ],
    nutrition: { calories: 80, protein: 1, carbs: 19, fat: 0 },
  }),
  recipe({
    id: "lemon-lime-sports-drink",
    name: "Lemon-Lime Sports Drink",
    description:
      "Electrolytes in a clear form. On a prep day this is the one that keeps the headache away.",
    mealType: "snack",
    tags: ["clear-liquid"],
    totalTime: 1,
    ingredients: [
      g(16, "oz", "sports drink", { note: "lemon-lime or clear only. Never red, purple or blue" }),
    ],
    instructions: ["Pour it. Cold is easier to keep drinking than room temperature."],
    nutrition: { calories: 100, protein: 0, carbs: 26, fat: 0 },
  }),
  recipe({
    id: "lemon-ice-pop",
    name: "Lemon Ice Pop",
    description: "A clear ice pop. Cold, sweet, and it takes ten minutes to finish, which helps.",
    mealType: "snack",
    tags: ["clear-liquid"],
    totalTime: 1,
    ingredients: [g(2, "each", "ice pop", { note: "lemon, lime or clear. No red, purple or blue" })],
    instructions: ["Eat them slowly."],
    nutrition: { calories: 80, protein: 0, carbs: 20, fat: 0 },
    lessons: ["Not the creamy ones. Anything with milk in it is not a clear liquid."],
  }),
  recipe({
    id: "plain-tea-or-black-coffee",
    name: "Plain Tea or Black Coffee",
    description:
      "No milk, no cream, no non-dairy creamer. Sugar is fine. Skipping coffee entirely on a prep day earns you a caffeine headache on top of everything else.",
    mealType: "breakfast",
    tags: ["clear-liquid"],
    totalTime: 3,
    ingredients: [
      g(1, "cup", "black coffee", { note: "or plain tea. NOTHING milky added", staple: true }),
      g(1, "tsp", "sugar", { optional: true, staple: true }),
    ],
    instructions: [
      "Brew it as normal.",
      "Nothing white goes in it. Milk and creamer are both out on a clear-liquid day.",
    ],
    nutrition: { calories: 15, protein: 0, carbs: 4, fat: 0 },
    lessons: [
      "A true FASTING blood draw is stricter than a clear-liquid prep day: no coffee at all unless the lab says otherwise.",
    ],
  }),

  // --- low residue ---------------------------------------------------------
  recipe({
    id: "white-toast-scrambled-eggs",
    name: "White Toast and Scrambled Eggs",
    description:
      "White bread, butter, two eggs. On a low-residue day the white bread is the correct choice, not a lapse: the whole point is the fiber that is missing.",
    mealType: "breakfast",
    tags: ["low-residue"],
    totalTime: 8,
    ingredients: [
      g(2, "slice", "white bread", { note: "plain white, no seeds, no whole grain" }),
      g(2, "each", "egg"),
      g(1, "tsp", "butter", { staple: true }),
      g(1, "pinch", "salt", { staple: true }),
    ],
    instructions: [
      "Toast the white bread and butter it.",
      "Beat the eggs with a pinch of salt and scramble them soft over low heat.",
      "No vegetables, no seeds, nothing green on the plate today.",
    ],
    nutrition: { calories: 340, protein: 18, carbs: 30, fat: 16 },
  }),
  recipe({
    id: "white-rice-plain-chicken",
    name: "White Rice and Plain Chicken",
    description:
      "Skinless chicken breast, plain white rice, salt. The most boring plate in the bank and the most useful one on a prep day.",
    mealType: "lunch",
    tags: ["low-residue"],
    totalTime: 25,
    ingredients: [
      g(1, "cup", "white rice", { note: "cooked. White, never brown", staple: true }),
      g(5, "oz", "chicken breast", { note: "skinless, plain" }),
      g(1, "tsp", "olive oil", { staple: true }),
      g(1, "pinch", "salt", { staple: true }),
    ],
    instructions: [
      "Cook the white rice plain. No brown rice today, the bran is the problem.",
      "Season the chicken with salt only and cook it through in a little oil, about 6 minutes a side.",
      "Slice it and serve on the rice. No sauce with seeds, no vegetables, no skins.",
    ],
    nutrition: { calories: 480, protein: 42, carbs: 45, fat: 12 },
  }),
  recipe({
    id: "broiled-white-fish-white-rice",
    name: "Broiled White Fish, White Rice",
    description:
      "Cod or tilapia under the broiler with lemon, on white rice. Tender protein that digests easily.",
    mealType: "dinner",
    tags: ["low-residue"],
    totalTime: 20,
    ingredients: [
      g(6, "oz", "cod", { note: "or tilapia, any mild white fish" }),
      g(1, "cup", "white rice", { note: "cooked", staple: true }),
      g(1, "tsp", "olive oil", { staple: true }),
      g(0.5, "each", "lemon", { note: "juice only, no zest" }),
      g(1, "pinch", "salt", { staple: true }),
    ],
    instructions: [
      "Heat the broiler.",
      "Oil the fish, salt it, broil 8 to 10 minutes until it flakes.",
      "Squeeze lemon over it and serve on plain white rice.",
      "Skip any herb garnish. Whole herbs count as residue.",
    ],
    nutrition: { calories: 470, protein: 40, carbs: 45, fat: 11 },
  }),
  recipe({
    id: "plain-pasta-butter-parmesan",
    name: "Plain Pasta, Butter and Parmesan",
    description: "White pasta, butter, grated parmesan. No sauce, no vegetables, no pepper flakes.",
    mealType: "dinner",
    tags: ["low-residue"],
    totalTime: 15,
    ingredients: [
      g(3, "oz", "pasta", { note: "white/refined, not whole wheat", staple: true }),
      g(1, "tbsp", "butter", { staple: true }),
      g(2, "tbsp", "parmesan", { note: "finely grated" }),
      g(1, "pinch", "salt", { staple: true }),
    ],
    instructions: [
      "Boil the pasta in salted water until soft, a minute past al dente.",
      "Drain, keeping a splash of the water.",
      "Toss with butter and parmesan and enough pasta water to make it glossy.",
      "Nothing else goes in. No garlic, no chili, no herbs.",
    ],
    nutrition: { calories: 460, protein: 15, carbs: 63, fat: 16 },
  }),
  recipe({
    id: "white-bread-turkey-sandwich-plain",
    name: "Plain Turkey Sandwich on White",
    description:
      "White bread, sliced turkey, a scrape of mayonnaise. No lettuce, no tomato, no seeds.",
    mealType: "lunch",
    tags: ["low-residue"],
    totalTime: 5,
    ingredients: [
      g(2, "slice", "white bread", { note: "plain white, no seeds" }),
      g(4, "oz", "sliced turkey", { note: "plain deli turkey" }),
      g(1, "tsp", "mayonnaise", { staple: true, optional: true }),
    ],
    instructions: [
      "Build the sandwich.",
      "No lettuce and no tomato: raw vegetables and skins are exactly what a low-residue day is avoiding.",
    ],
    nutrition: { calories: 340, protein: 30, carbs: 30, fat: 10 },
  }),
  recipe({
    id: "cream-of-wheat-plain",
    name: "Cream of Wheat",
    description:
      "Refined wheat farina, made with milk or water. Smooth, warm, and no fiber in it at all.",
    mealType: "breakfast",
    tags: ["low-residue"],
    totalTime: 6,
    ingredients: [
      g(0.33, "cup", "cream of wheat", { note: "farina. NOT oatmeal, oats are high fiber" }),
      g(1, "cup", "milk", { note: "or water", staple: true }),
      g(1, "tsp", "sugar", { optional: true, staple: true }),
      g(1, "pinch", "salt", { staple: true }),
    ],
    instructions: [
      "Whisk the farina into simmering milk or water with a pinch of salt.",
      "Cook 3 minutes, whisking, until it thickens.",
      "Sweeten if you like. No berries, no nuts, no seeds on top.",
    ],
    nutrition: { calories: 250, protein: 10, carbs: 40, fat: 5 },
    lessons: ["Oatmeal is the reflex here and it is wrong: oats are one of the highest-fiber grains."],
  }),
  recipe({
    id: "plain-crackers-mild-cheese",
    name: "Saltines and Mild Cheese",
    description: "Plain white crackers with a little mild cheese. Something to chew that is legal.",
    mealType: "snack",
    tags: ["low-residue"],
    totalTime: 2,
    ingredients: [
      g(8, "each", "saltine crackers", { note: "plain white, no seeds, no whole grain" }),
      g(1, "oz", "mild cheddar", { note: "or any mild hard cheese" }),
    ],
    instructions: ["Slice the cheese thin and eat it with the crackers."],
    nutrition: { calories: 220, protein: 8, carbs: 22, fat: 11 },
  }),
  recipe({
    id: "canned-peaches-cottage-cheese",
    name: "Canned Peaches and Cottage Cheese",
    description:
      "Canned peaches in juice, drained, with cottage cheese. Canned fruit without skin is allowed where fresh fruit is not.",
    mealType: "snack",
    tags: ["low-residue"],
    totalTime: 2,
    ingredients: [
      g(0.5, "cup", "canned peaches", { note: "in juice, drained, no skin" }),
      g(0.5, "cup", "cottage cheese"),
    ],
    instructions: [
      "Drain the peaches well and spoon them over the cottage cheese.",
      "Canned and skinless is the rule. A fresh peach with the skin on is not the same food today.",
    ],
    nutrition: { calories: 180, protein: 14, carbs: 22, fat: 3 },
  }),

  // --- soft / post-surgical ------------------------------------------------
  recipe({
    id: "mashed-potato-plain",
    name: "Plain Mashed Potato",
    description: "Peeled potato mashed smooth with butter and milk. No skins, nothing to chew.",
    mealType: "dinner",
    tags: ["soft"],
    totalTime: 25,
    ingredients: [
      g(2, "each", "russet potato", { note: "PEELED. The skin is the fiber" }),
      g(1, "tbsp", "butter", { staple: true }),
      g(0.25, "cup", "milk", { staple: true }),
      g(1, "pinch", "salt", { staple: true }),
    ],
    instructions: [
      "Peel and cube the potatoes, boil until they fall apart on a fork, about 15 minutes.",
      "Drain and mash with warm milk, butter and salt until completely smooth.",
      "No skins, no lumps, no black pepper if the mouth is sore.",
    ],
    nutrition: { calories: 330, protein: 7, carbs: 55, fat: 10 },
  }),
  recipe({
    id: "cold-yogurt-cup-plain",
    name: "Cold Plain Yogurt",
    description: "Plain Greek yogurt, straight from the fridge. Cold, soft, and real protein.",
    mealType: "breakfast",
    tags: ["soft"],
    totalTime: 1,
    ingredients: [
      g(1, "cup", "greek yogurt", { note: "plain. No granola, no seeds, no berries with pips" }),
      g(1, "tsp", "honey", { optional: true, staple: true }),
    ],
    instructions: [
      "Eat it cold with a spoon.",
      "Nothing crunchy on top. After dental surgery the seeds are the thing that ruins it.",
    ],
    nutrition: { calories: 160, protein: 20, carbs: 12, fat: 4 },
  }),
  recipe({
    id: "cold-protein-smoothie-spoon",
    name: "Cold Protein Smoothie, by Spoon",
    description:
      "Banana, milk, whey, blended thick and eaten with a spoon. No straw: suction is what causes dry socket.",
    mealType: "lunch",
    tags: ["soft"],
    totalTime: 4,
    ingredients: [
      g(1, "each", "banana", { note: "ripe" }),
      g(1, "cup", "milk", { staple: true }),
      g(1, "scoop", "whey protein powder", { note: "vanilla or unflavored", staple: true }),
      g(4, "each", "ice cube", { staple: true }),
    ],
    instructions: [
      "Blend everything until completely smooth. Blend longer than you think.",
      "Eat it with a SPOON. No straw for a full week after an extraction: the suction pulls the clot out.",
      "Skip berries and anything with seeds while a socket is open.",
    ],
    nutrition: { calories: 340, protein: 32, carbs: 42, fat: 5 },
    lessons: ["No straws is the single instruction people break, and dry socket is the price."],
  }),
];

let n = 0;
for (const r of RECIPES) {
  writeFileSync(new URL(`${r.id}.json`, OUT), JSON.stringify(r, null, 2) + "\n");
  n++;
}
console.log(`wrote ${n} occasion-only recipes to seed-data/generated/recipes/`);
