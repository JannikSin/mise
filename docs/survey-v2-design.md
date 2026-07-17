# Survey v2 Design: Onboarding Questionnaire for Public Mise

Status: DESIGN ONLY. No survey code is changed by this document. `app/views/profile-gate.js` is owned by another agent; this is the spec it (and `targetsFromQuestionnaire`) will implement.

Goal: two people who answer the survey differently must get visibly different generated weeks. Today the only levers the questionnaire pulls are Mifflin-St Jeor macros, phase, and mealSlots; every profile draws from the same unfiltered bank with the same scoring. This design adds the missing axes and maps each one to a concrete generation mechanism.

## Design constraints

- Finishable in under 5 minutes. Everything is chips and steppers except the name field and one optional free-text exclusion box. Required core is 12 taps plus 4 numbers plus a name.
- Progressive: the survey works if the user stops after the required section. Every optional answer has a safe default (no filter, no weight). All of it is editable later in SYS.
- Every question maps to a mechanism that exists in `app/lib/plan.js` / `app/lib/weekbuilder.js` today, or to a new mechanism described concretely below. No question is collected "for later."
- All new answers land in the profile's `fitness/targets.json` (the file `targetsFromQuestionnaire` already writes). Every new field named here is a schema change and must land in `docs/SCHEMAS.md` in the same commit that implements it.

## Mechanism vocabulary

Three ways an answer can shape the plan, in decreasing strictness:

- **FILTER**: recipe removed from the working pool before committees are picked. Implemented in `mergeRecipePool` (app/lib/plan.js:58) or the `pool()` helper inside `generateWeek` (app/lib/weekbuilder.js). Reserved for safety and identity: allergies, dietary pattern, hard time/skill/equipment limits.
- **WEIGHT**: term added to the `bonus()` score inside `pickCommittee` (app/lib/weekbuilder.js:163). The recipe stays eligible; it just wins or loses ties. Reserved for taste: dislikes, cuisines, budget, breakfast style. A weight can never empty a pool, which is why taste must never be a filter.
- **TARGET ADJUSTMENT**: changes `targets` values the generator already reads: `macros`, `mealSlots`, `dailyDozen`.

## Question set

### Section 1: REQUIRED, "about you" (exists today, unchanged)

| # | Question | Field | Mechanism |
|---|----------|-------|-----------|
| 1 | Name | profile `name`/`id` | identity |
| 2 | Emoji | profile `emoji` | identity |
| 3 | Sex | questionnaire input | TARGET: Mifflin-St Jeor constant, waterLiters |
| 4 | Age | questionnaire input | TARGET: Mifflin-St Jeor |
| 5 | Height ft+in | questionnaire input | TARGET: Mifflin-St Jeor |
| 6 | Weight lb | questionnaire input | TARGET: Mifflin-St Jeor, protein g/lb |
| 7 | Activity level (5 chips) | questionnaire input | TARGET: TDEE multiplier |
| 8 | Goal lose/maintain/gain | `targets.phase` | TARGET: calorie delta; FILTER: `recipe.phases` tag via `mergeRecipePool` (exists) |

### Section 2: REQUIRED, "what you eat" (new, ~1 minute)

**Q9. Dietary pattern** (single chip: omnivore / pescatarian / vegetarian / vegan)

- Field: `targets.diet` (new, enum `"omnivore" | "pescatarian" | "vegetarian" | "vegan"`, absent = omnivore).
- Mechanism: FILTER, new. Add a `dietOf(recipe)` classifier next to `mergeRecipePool` in app/lib/plan.js:
  - Keyword classes over NON-optional ingredient `food` names: MEAT (chicken, beef, turkey, pork, lamb, kofta, sausage...), FISH (salmon, tuna, cod, shrimp, anchovy, dashi...), DAIRY (milk, yogurt, cheese, whey, butter, feta, halloumi, cottage...), EGG (egg).
  - vegan admits none of the four; vegetarian admits DAIRY+EGG; pescatarian admits FISH+DAIRY+EGG; omnivore admits all.
  - A recipe tag in {"vegan","vegetarian","pescatarian"} short-circuits the classifier (new recipes carry these tags; the classifier is the fallback for the untagged legacy bank).
  - `optional: true` ingredients are skipped by the classifier, so "add ground turkey if you want" does not disqualify an otherwise plant-based chili. See the shared fix under Q10.
- Why filter not weight: serving beef to a vegetarian is a trust-ending bug, not a taste miss.

**Q10. Allergies and hard exclusions** (multi-chip: nuts / peanuts / gluten / dairy / eggs / soy / shellfish / fish / sesame, plus one free-text box "anything else, comma separated")

- Fields: `targets.allergens` (new, array of preset ids, kept so SYS can re-render the chips) and the existing `targets.avoidIngredients` (mechanism already live in `mergeRecipePool`, case-insensitive substring screen).
- Mechanism: FILTER, exists. Each preset chip expands to a term list appended to `avoidIngredients`, e.g. nuts -> ["almond","walnut","cashew","pecan","pistachio","hazelnut","peanut","nut butter"], gluten -> ["wheat","pasta","bread","couscous","farro","orzo","pita","flour","noodle","barley","bulgur","soy sauce","panko","seitan"], dairy -> ["milk","yogurt","cheese","whey","butter","cream","feta","halloumi","cottage","parmesan"]. The expansion table lives beside `targetsFromQuestionnaire` in app/lib/fitness.js so SYS and the gate share it. Free-text terms append verbatim.
- Required one-line fix that ships with this: the `containsAvoided` check in `mergeRecipePool` (app/lib/plan.js:60) must skip ingredients with `optional: true`, and recipes whose gluten/dairy item carries a swap note stay excluded (safety first: the screen only reads the food name, never trusts a note). Without the optional-skip, several bank recipes with optional yogurt toppings vanish from dairy-free pools unnecessarily.
- Why substring screen is enough: it is already conservative ("onion" blocks "red onion"); allergy handling wants false positives over false negatives.

**Q11. Meals per day** (chips: breakfast? yes/skip; smoothie? yes/no; snacks? grazer/three-squares)

- Field: existing `targets.mealSlots` (mechanism fully live: `generateWeek` proactively fills exactly the listed slots; snack is always the reactive top-up pool and never listed).
- Mapping: skip breakfast -> drop "breakfast" from mealSlots (calories redistribute automatically because the macro floor pass and portion bumps operate on whatever slots exist). Smoothie yes -> append "smoothie". The grazer/three-squares chip does not change mealSlots; it sets `targets.snackAppetite` (new, `"grazer" | "meals"`, absent = grazer) which `macroTopUp` reads to cap snack stacking per day at 3 (grazer, today's behavior) or 1 (meals; the portion-bump lever then does more of the work, which it already tries first).

**Q12. Weeknight time budget** (chips: 15 min / 30 min / 45+ min)

- Field: `targets.maxWeeknightMinutes` (new, number, absent = no cap).
- Mechanism: FILTER, small extension of one that exists. `pickCommittee` already excludes `effort: "project"` unconditionally; the `pool()` helper in `generateWeek` additionally drops recipes with `totalTime > maxWeeknightMinutes` from dinner/lunch candidacy. Breakfast/smoothie/snack pools are exempt (they are near-universally under 20 min). 45+ behaves as today.
- Honest-failure rule: if the cap empties a committee below 2, generation proceeds with the cap ignored for that slot and the week report gains a plain-English line ("time budget too tight for the dinner pool; showing 40-minute dinners"), same never-fudge philosophy as `poolInsufficiency`.

### Section 3: OPTIONAL, "make it yours" (skippable, safe defaults)

**Q13. Dislikes** (free chips, "foods you'd rather not see")

- Field: `targets.dislikeIngredients` (new, string array, absent = none).
- Mechanism: WEIGHT, new term in `pickCommittee`'s `bonus()`: `-2 * dislikeHits(r)` using the same substring matcher as `useSoonHits`. A disliked-ingredient recipe still appears when the pool is thin; it just never wins a tie. Not a filter, deliberately: dislikes are preferences, and a vegan+gluten-free+nut-free pool cannot afford to also hard-drop mushrooms.

**Q14. Cuisine preferences** (chip grid of the bank's cuisines; tap once = love, tap twice = avoid, max 3 loves)

- Field: `targets.cuisinePrefs` (new, `{ loved: string[], avoided: string[] }`, absent = neutral).
- Mechanism: WEIGHT in `bonus()`: `+1` if `r.cuisine` is loved, `-3` if avoided. Values chosen relative to the existing terms (useSoon is `*3`, gap bonus `*2`) so cuisine taste can steer ties but never override nutrition.

**Q15. Cooking skill** (chips: beginner / comfortable / confident)

- Field: `targets.maxDifficulty` (new, 1 | 2 | 3, absent = 3).
- Mechanism: FILTER in `pool()`: drop `difficulty > maxDifficulty` from proactive-slot candidacy (recipes stay visible in the Cookbook; this only affects auto-planning). Beginner = 1, comfortable = 2, confident = 3 (no filter).

**Q16. Kitchen equipment** (multi-chip: blender / oven / rice cooker / food processor / freezer space)

- Fields: `targets.equipment` (new, string array of what they HAVE; absent = assume everything) and a new OPTIONAL recipe field `equipment: string[]` (what a recipe NEEDS beyond a stovetop and a knife; absent = stovetop only). Recipe field is a schema change: add to SCHEMAS.md Recipe block when implemented, and backfill only the obvious cases (smoothies need "blender").
- Mechanism: FILTER in `pool()`: drop recipes requiring equipment the profile lacks. Special case handled as TARGET adjustment at questionnaire time: no blender -> never emit "smoothie" in mealSlots.

**Q17. Breakfast style** (chips: sweet / savory / grab-and-go / surprise me)

- Field: `targets.breakfastStyle` (new, enum, absent = "surprise me" = no weight).
- Mechanism: WEIGHT applied only when picking the breakfast committee: `+1.5` for tag match. Tag conventions: sweet matches tags {"sweet"} or foodGroups berries/otherFruit > 0.5; savory matches tags {"savory"} or beans+otherVeg > 0.5 with fruit = 0; grab-and-go matches tags {"grab-and-go","make-ahead","blend-and-go"} or `effort: "assembly"`. Uses existing recipe data; two new tags (sweet/savory) get added to breakfast recipes opportunistically, untagged recipes fall back to the foodGroups heuristic.

**Q18. Budget sensitivity** (chips: tight / normal / not a concern)

- Field: `targets.budget` (new, enum `"tight" | "normal" | "loose"`, absent = normal).
- Mechanism: WEIGHT, tight adds `+1` for the "cheap" tag and `+0.5 * foodGroups.beans` in `bonus()` (beans are the cheapest protein in the bank), and raises the ingredient-overlap term's weight from 1x to 2x so tight-budget weeks converge on fewer distinct shopping items (the overlap machinery is already the core of `pickCommittee`; this just turns the existing dial). No new recipe field needed; a per-recipe `costTier` stays out until proven necessary.

**Q19. Training** (single toggle)

- Field: `trainingEnabled`, owned by another agent's work; the survey simply hosts the toggle. When enabled, that agent's flow controls workout tracks/slots. Referenced here only so the survey page layout reserves a row for it.

## Flow and timing

1. Screen 1 (required): who + body numbers + goal. Existing gate content, unchanged. ~90 sec.
2. Screen 2 (required): Q9 diet, Q10 allergy chips, Q11 meals, Q12 time. Four chip rows. ~60 sec.
3. Screen 3 (optional, single "skip all" affordance): Q13-Q18 plus the training toggle. ~2 min if fully answered, 2 sec if skipped.

Under 5 minutes fully answered; under 3 skipping section 3.

## Why plans now genuinely differ

Two public users, same body stats: a vegan gluten-free beginner with 15-minute nights gets a pool filtered to roughly the 16-recipe diversity set plus assembly bowls, smoothie committee of pea/soy blends, snacks topping up from edamame and roasted chickpeas. An omnivore confident cook with no exclusions gets today's David-shaped week. The committees, the shopping list, the Daily Dozen coverage report, and the macro top-ups all diverge because the POOL and the SCORING diverge, not because any new generation engine was built: every mechanism above is either live today or a bounded extension of `mergeRecipePool`, `pool()`, or `bonus()`.

## Implementation order (for whoever builds it)

1. `mergeRecipePool` optional-ingredient skip + `dietOf` classifier + `targets.diet` (biggest differentiation per line of code).
2. Allergen preset expansion table + `targets.allergens` (reuses the live avoidIngredients screen).
3. `pool()` filters: `maxWeeknightMinutes`, `maxDifficulty`, `equipment`.
4. `bonus()` weights: dislikes, cuisine, breakfast style, budget.
5. Gate UI screens 2-3 + `targetsFromQuestionnaire` extension + SCHEMAS.md update (same commit).

Each step is independently shippable and independently testable against `tests/weekbuilder.test.js` patterns (pure functions, fixture pools).
