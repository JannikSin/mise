# Mise — Data Schemas

The single source of truth for every JSON file in the private `mise-data` repo.
**Any schema change lands in this document in the same commit** (CLAUDE.md Part 2, rule 4).
The post-edit hook flags data files using fields not named here; the `schema-guard`
agent runs the full check before commits.

Derived from MISE_BLUEPRINT.md §5 (Mealie/Tandoor/KitchenOwl research: structured
ingredients, staple flags, slot-typed plans, derived shopping list; no stock ledgers).

## Conventions

- **Files are small and per-domain** to minimize write-conflict surface.
- **ids**: lowercase kebab-case slugs, unique within their domain (`chicken-bulgogi-bowl`).
  Exception: supplement ids are camelCase (`fishOil`) — they double as the keys of
  `fitness/daily.json`'s `supplements` check map.
- **dates**: ISO 8601 `YYYY-MM-DD` local dates; weeks as ISO week ids `2026-W28`.
- **timestamps**: ISO 8601 UTC with `Z` suffix, only where sync needs them.
- **units**: metric-friendly free strings (`g`, `ml`, `tbsp`, `clove`, `can`); `qty` is a number.
- **enums** are closed lists — extending one is a schema change (update this doc).
- Optional fields are marked `?`. Absent ≠ null: omit optional fields entirely.

## File layout (`mise-data`, private)

```
profiles.json              every profile that can sign in (ROOT, never scoped — see below)
recipes/<id>.json         one recipe per file
pantry.json               staples registry + perishables
plans/<week>.json         e.g. plans/2026-W28.json
shopping.json             current derived list + check-state
fitness/targets.json      macro targets, adjustment rules, priority stack
fitness/workouts.json     split templates + session log
fitness/daily.json        daily check-ins
fitness/activities.json   tennis/climbing/hiking sessions (schema reserved — no UI yet)
meta.json                 app-level state (schema version, last-write info)

profiles/<id>/...         same file set as above, for every profile except "david"
```

**Multi-profile scoping** (`app/lib/store.js`): the signed-in profile lives in
localStorage as `mise.activeProfile` (default `"david"`). David's files stay
at the data-repo root — his live synced `mise-data` repo is never migrated.
Every other profile's files live under `profiles/<id>/`, e.g. Mom's shopping
list is `profiles/mom/shopping.json`, her targets are
`profiles/mom/fitness/targets.json`. `profiles.json` itself is the one file
that is NEVER scoped, by any profile — it has to be readable before a
profile is even chosen. `read`/`write`/`readCollection` accept `{ raw: true }`
to skip scoping for the two cross-profile features below; everything else
stays scoped.

**Recipe bank** (pilot): root `recipes/` is the SHARED bank every profile
pulls from. A profile's working pool = bank recipes whose optional `phases`
tag admits the profile's `targets.phase` (absent tag = everyone) AND that
pass the profile's `targets.avoidIngredients` screen (case-insensitive
substring match on ingredient food names — "onion" also excludes "red
onion"), overlaid with the profile's own `profiles/<id>/recipes/` (same id
= the profile's adjusted variant wins; own recipes are never phase-filtered
or ingredient-screened — they were authored for that profile). Merge lives
in `app/lib/plan.js` `mergeRecipePool`; the generator and views only ever
see the merged pool. An empty `profiles/<id>/recipes/` is a working state —
the bank covers it.

**Shadow duplicates (2026-07-12 migration, DO NOT "clean up" blindly):**
`profiles/mom/recipes/` holds 29 files byte-identical to bank copies (her
29 unique recipes were adopted INTO the bank but her originals were kept).
They are LOAD-BEARING backward compatibility: any device still running
pre-bank app code reads only the profile directory and would lose those
recipes if the duplicates were deleted. Delete them only after every device
has post-bank code, and only with David's explicit OK. Her other 29 files
are REAL loss-adjusted variants (different nutrition), not duplicates —
diff against the bank before touching anything.

**Week lock rollout caveat:** a device running pre-lock app code neither
sees nor respects `plan.locked` — its GENERATE can still wipe a locked
week's entries through the id-keyed merge while `locked: true` survives.
Refresh every device after deploying the lock. New code guards in the
handler body, not just the disabled button.

**Combined household shopping list**: a read-time merge of every profile's
`shopping.json` (`app/lib/shopping.js` `mergeProfileLists`) shown as the
EVERYONE tab in List. No third file exists; ticking a combined item writes
the tick through to each source profile's own list. Swap suggestions
(`swapCandidates`) flag single-profile items in partial-container sections
(dairy/produce/spices/other) — report only, recipes are never auto-edited.

Schema-exemplar fixtures live in the app repo under `fixtures/` with the same
shapes; the post-edit hook's drift check reads them. Never commit real user
data to the app repo.

## Profiles — `profiles.json` (data-repo ROOT, never scoped)

```jsonc
{
  "profiles": [
    { "id": "david", "name": "David", "emoji": "🏋️", "phase": "gain" },
    { "id": "mom", "name": "Mom", "emoji": "🌿", "phase": "loss", "trainingEnabled": false },
    { "id": "laurie", "name": "Laurie", "emoji": "🥑", "phase": "recomp", "trainingEnabled": false, "household": "laurie" },
  ],
}
```

- `id`: lowercase kebab-case; used verbatim as the `profiles/<id>/` prefix
  for every file except `"david"`, which stays at the root.
- `trainingEnabled?`: boolean, absent = `true`. When `false`, the app hides the
  Train tab, Home's Train row, and the `#/train` route for that profile
  (`app/main.js`, `app\views\home.js`). Asked as a yes/no in the gate's ADD
  PROFILE questionnaire; toggled later from the SYS App tile
  (`app\views\system.js`), which rewrites this file.
- `household?`: string, absent = `"home"`. Groups profiles into one grocery
  trip: the List view's EVERYONE tab merges only profiles that share the
  active profile's household (`app/lib/shopping.js` `householdOthers`, wired
  in `app/main.js`). A profile alone in its household (e.g. Laurie in her own
  apartment) sees no EVERYONE tab at all; absent-field profiles keep merging
  exactly as before the field existed. Not asked in the gate questionnaire —
  edited from the SYS App tile ("MOVE HOUSEHOLD", `app\views\system.js`),
  which normalizes to lowercase-kebab and stores `"home"`/blank as absent.
  Moving is deliberately cheap so a visiting member can join a household for
  a week and move back.
- `family?`: string (lowercase-kebab), absent = ungrouped. The TOP-LEVEL
  grouping (2026-07-21): family is who a person IS, household is who they
  grocery-shop with right now. The profile gate groups its chooser by family
  once two or more distinct families exist; households remain the movable
  unit under SYS. Asked in the gate questionnaire, editable from SYS ("SET
  FAMILY"). Existing profiles without the field behave exactly as before.
- `phase` here is a display-only mirror of that profile's own
  `fitness/targets.json.phase` — shown on the profile-gate button before
  that profile's own data has loaded.
- **Writing this file (G2, 2026-07-21): every mutation goes through
  `patchProfiles` in `app/lib/store.js`**, which loads the REAL current list
  (cache, then network) and applies an id-targeted patch. It REFUSES to write
  when the list can't be established, because a whole-array replacement built
  from the David-only fallback is exactly the bug that erased a profile on
  2026-07-20: any device that hadn't synced would clobber every profile it
  didn't know about via the SYS toggles or ADD PROFILE. `allowSeed` (passed
  only by the two profile-creation flows) permits the from-scratch write on a
  confirmed-404 fresh data repo. Choosers display `readProfiles().fallback`
  honestly instead of silently showing the default list.
- New profiles are created by the gate's ADD PROFILE questionnaire
  (`app/views/profile-gate.js`): sex/age/height(ft+in)/weight(lb)/activity/
  goal → `targetsFromQuestionnaire` (`app/lib/fitness.js`, Mifflin-St Jeor
  × activity ± goal delta) writes a complete
  `profiles/<id>/fitness/targets.json` and appends to `profiles.json`.
  Recipes come from the shared bank, so no per-profile recipe seeding is
  needed.
- If the file is missing or unreachable, `store.js`'s `readProfiles()` falls
  back to a single default David profile so a fresh or pre-multi-profile
  install still boots straight into the app.

## Vitals — `profiles/<id>/health/vitals.json` (per-profile, scoped)

Read-only Apple Watch / Apple Health mirror for the Vitals dashboard
(`app/views/vitals.js`, route `#/vitals`, linked from Home). **The app never
writes this file.** A PWA cannot read HealthKit, so an Apple Shortcuts
automation on the phone posts the data (via the GitHub Contents API with the
same PAT, or a future Worker write endpoint). An absent or empty file is the
normal pre-connection state, not an error.

```jsonc
{
  "days": [
    {
      "date": "2026-07-18", // ISO; one row per day
      "steps": 8432, // ? whole steps
      "distanceMi": 3.7, // ? walking+running miles
      "activeKcal": 512, // ? active energy burned
      "restingHR": 58, // ? resting heart rate, bpm
      "hrvMs": 46, // ? heart-rate variability (SDNN), ms
      "sleepHours": 7.4, // ? asleep hours
      "vo2max": 44.2, // ? cardio fitness, ml/kg/min (updates rarely)
    },
  ],
  "ekg": [
    { "date": "2026-07-15", "result": "Sinus Rhythm", "avgBpm": 61 }, // ? Apple Watch ECG app
  ],
}
```

Every day-field is optional: a watch that never records HRV just omits it and
the dashboard hides that tile (`latestWith` returns null). Sparklines skip
days missing the field rather than plotting a zero. The Shortcut may append or
replace the whole `days` array; the app only reads.

## Prices — `prices.json` (data-repo ROOT, shared reference, read raw)

Store price catalogue for shopping-cost estimates. Not yet read by any app
code — reference data maintained by Claude sessions (researched 2026-07-18,
Chicagoland). Entries: `{ id, name, prices: { <store-slug>: { price, size,
estimate? } } }` with `updated`, `region`, `stores` at the top. `estimate:
true` = derived/recent estimate, absent = tracker-confirmed shelf price. A
store absent from an item's `prices` = not reliably stocked there.
Integration (`app/lib/prices.js`, read raw in `app/main.js`): the List view
shows a price chip per row (matched by word overlap ≥ 0.6 against name/id,
`~` = estimate), and a trip-total tile (subtotal + grocery tax from
`targets.region` + honest coverage line + cheapest-well-covered-store
ranking that never lets a store missing half the basket "win"). Chips price
at the profile's first `targets.stores` entry, slugified; fallback is the
cheapest covered store.

## Recipe — `recipes/<id>.json`

```jsonc
{
  "id": "chicken-bulgogi-bowl",
  "name": "Chicken Bulgogi Bowl",
  "description": "Weeknight bulgogi over rice with quick-pickled cucumber.",
  "sourceUrl": "https://…", // ? where it was researched from
  "image": "images/chicken-bulgogi.jpg", // ? repo-relative path
  "servings": 4,
  "prepTime": 15, // minutes
  "cookTime": 12, // minutes
  "totalTime": 27, // minutes
  "mealType": "dinner", // breakfast | lunch | dinner | smoothie | snack
  "cuisine": "korean",
  "tags": ["rice-bowl", "batch-friendly"],
  "difficulty": 1, // 1..3
  "equipment": ["blender"], // ? gear this recipe NEEDS beyond a stovetop and
  //   a knife (survey-v2 Q16 FILTER). ABSENT = stovetop only.
  //   Values: blender | oven | rice cooker | food processor |
  //   freezer. A profile whose targets.equipment lacks any listed
  //   item won't be auto-planned this recipe. Backfill only obvious
  //   cases (smoothies need "blender").
  "rating": 4, // ? 1..5, David's own
  "phases": ["gain"], // ? recipe-bank visibility: which targets.phase values
  //   this recipe serves (gain | loss | recomp | cut).
  //   ABSENT = serves every profile. Only tag the
  //   extremes (900-kcal bulk bowls -> ["gain"],
  //   preload soups -> ["loss","cut"]). Profile-local
  //   recipes ignore this field entirely.
  "purpose": ["recovery", "everyday"], // recovery | pre-activity | long-satiety | sick-day | everyday
  "effort": "assembly", // assembly (<15m) | cook (15-30m) | project (30m+)
  "ingredients": [
    {
      "qty": 500,
      "unit": "g",
      "food": "chicken thigh",
      "note": "boneless, thin-sliced", // ?
      "optional": false, // ? default false
      "staple": false, // ? true = assume on hand, excluded from shopping
    },
  ],
  "instructions": [{ "step": 1, "text": "Slice chicken thin against the grain." }],
  "nutrition": {
    "calories": 640, // per serving
    "protein": 52, // grams per serving
    "carbs": 61,
    "fat": 18,
    "method": "estimated", // estimated | usda-spot-checked
  },
  "foodGroups": {
    // ? Daily Dozen servings this recipe provides per serving
    "beans": 1, // legumes/tofu/tempeh/edamame, ~0.5 cup cooked = 1
    "berries": 0,
    "otherFruit": 0.5,
    "cruciferousVeg": 0, // broccoli, cabbage, kale, etc.
    "greens": 1,
    "otherVeg": 1,
    "flaxseed": 0,
    "nuts": 0.5,
    "spicesHerbs": 1, // meaningful culinary use, not a pinch garnish
    "wholeGrains": 2,
    "beverages": 0, // green tea etc; plain water excluded
    "method": "estimated", // estimated | book-verified
  },
  "batchPrep": {
    "sundayComponent": "Marinate + cook protein; rice in cooker.", // ?
    "weekdayAssembly": "Reheat, top, pickle. 10 min.", // ?
  },
  "timesCooked": 3,
  "lastCooked": "2026-06-28", // ?
  "lessons": ["Double the marinade — it carries the bowl."],
}
```

## Pantry — `households/<household>/pantry.json` (B2, 2026-07-21)

HOUSEHOLD-SHARED: one kitchen, one fridge, one pantry file, keyed by the
active profile's `household` slug (absent = `"home"`, so the default file is
`households/home/pantry.json`). Everyone in the household reads and writes
the same file; moving household in SYS re-points a profile to that
household's pantry on the next load (B3), because the path derives from
profiles.json every time. Always read/written raw, never profile-scoped
(`pantryPathFor` in app/lib/shopping.js).

LEGACY: pre-B2 pantries lived per-profile at `pantry.json` (David at root,
others under `profiles/<id>/`). New code falls back to that path when the
household file is absent and seeds the household file from it once; devices
still running pre-B2 code keep using the legacy path until they update, so
expect a brief divergence window on mixed versions, resolved in favor of the
household file the first time every device is current.

Two tiers, deliberately lightweight (no decrement-on-cook ledger, ever).

```jsonc
{
  "staples": [
    {
      "id": "cayenne",
      "name": "Cayenne",
      "section": "spices", // store section, see Shopping
      "onHand": true,
      "runningLow": false, // one tap → re-adds to shopping list
      "premium": false, // ? true = special occasions (saffron, porcini)
    },
  ],
  "perishables": [
    {
      "food": "half cabbage",
      "qty": "0.5 head", // ? free string, human-scale
      "added": "2026-07-04",
      "expires": "2026-07-11", // ?
      "useSoon": true, // ? surfaces in recipe recommendations
    },
  ],
}
```

## Meal plan — `plans/<week>.json`

Entries carry a unique `id` and multiple entries may STACK in the same
date+slot (hitting 3,400 kcal often needs more than one item per slot).
The `id` doubles as the merge key, so two devices editing the same week —
even the same slot — merge without losing either entry.

```jsonc
{
  "week": "2026-W28",
  "locked": false, // ? true = you've shopped for this week; see below
  "buffer": { "recipeId": "smoky-three-bean-edamame-protein-salad", "portions": 7 }, // ? see below
  "entries": [
    {
      "id": "b3e29f01", // unique in the file; merge key
      "date": "2026-07-06",
      "slot": "dinner", // breakfast | lunch | dinner | smoothie | snack
      "recipeId": "chicken-bulgogi-bowl", // exactly one of recipeId | freeText
      "freeText": "leftovers", // e.g. "leftovers", "eating out"
      "servings": 2,
      "pinned": false, // ? true = GENERATE WEEK must never clear or overwrite this entry
      "out": false, // ? true = eating-out placeholder (see below)
      "estCalories": 595, // ? out entries only: assumed macros of the restaurant meal
      "estProtein": 34, // ? (slotMacroEstimate: pool average for the slot x 0.85 undershoot)
    },
  ],
}
```

Absent `pinned` = unpinned (default behavior today, unchanged for existing data).

`out` (per-entry, optional; absent = normal entry) marks an EATING-OUT
placeholder — a free lunch, a restaurant dinner. Created by the slot's OUT
toggle in the planner (or by dragging the "eating out" tray chip), it is
always written with `pinned: true` and `freeText: "eating out"`, so
GENERATE/RE-ROLL never clears or refills the slot and the shopping list
ignores it (freeText has no ingredients). Unlike other freeText, an out entry
carries `estCalories`/`estProtein` — the ASSUMED macros of the restaurant
meal, computed at toggle time as the profile pool's average for that meal
type times a deliberate 0.85 undershoot (you don't know the restaurant
portion in advance; crediting slightly low lets the generator close the small
remainder with a skippable snack instead of planning the day around calories
that may not arrive). `dayTotals` counts the credit, so floors, top-up,
ceiling trim, meters, and shortfall reports all treat an out day like any
other day. Entries missing the estimate (pre-estimate data) are backfilled
from the live pool at the next GENERATE. The build report lists out slots
under `outDays` with their assumed totals (app/lib/weekbuilder.js).

`buffer` (whole-plan, optional; absent = no weekly buffer, unchanged for
existing data) names the week's BUFFER SNACK: one batch-prepped, measured
fridge stand-by (per the 2026-07-20 Greger consult: batchable snacks only,
phase-keyed calorie band, protein-dense). Chosen by GENERATE WEEK
(deterministic, re-rolls with the salt), its batch (`portions` servings) is
added to the derived shopping list like a planned entry. Portions eaten are
tallied per day on the Cook view into `fitness/daily.json` day rows as a
`buffer` count (a plain number, absent = 0) — display-only, it never feeds
plan `dayTotals`.

`locked` (whole-plan, not per-entry) guards against the week's meals silently
changing after groceries are already bought: toggled from the List view's
"GOING TO THE STORE" button (app/views/shopping.js). While `true`, GENERATE MY
WEEK / RE-ROLL WEEK refuse to run (button disabled), and adding, removing, or
moving an entry asks for confirmation first (app/main.js `handleDrop`,
`handleRemove`, `handlePlanAdd`) — pin/unpin is unaffected since it never
changes what's cooked. Absent `locked` = unlocked (default, unchanged for
existing data).

## Shopping list — `shopping.json`

Derived (aggregate week's ingredients → merge duplicates → subtract pantry
`onHand` staples → group by section). Check-state and manual items persist.
Displayed `qty`/`unit` are rounded up to a purchasable amount (whole counts,
sensible gram/ml/kg/L/cup/tbsp/tsp/lb/oz steps) after summing, not before.
STORED quantities stay metric and authoritative; the List and EVERYONE tabs
display a store-shelf conversion on top ("1.98 lb (900 g)") via
`toStoreUnits`/`formatStoreQty` in app/lib/shopping.js — a faithful convert
of the already-purchasable metric value, never re-rounded onto an imperial
grid (which would make the two numbers disagree or under-buy).

```jsonc
{
  "generatedFrom": "2026-W28", // ? week the list was derived from
  "items": [
    {
      "id": "chicken-thigh",
      "food": "chicken thigh",
      "qty": 1000,
      "unit": "g",
      "section": "meat", // produce | meat | dairy | dry-goods | frozen | spices | other
      "checked": false,
      "manual": false, // true = David added by hand, survives regeneration
      "fromRecipes": ["chicken-bulgogi-bowl"], // ?
    },
  ],
}
```

## Fitness — `fitness/targets.json`

The stable reference the fitness page renders (blueprint §6.6 "Targets" tab).
Seeded from the FITNESS.md system; edited rarely.

```jsonc
{
  "macros": {
    "calories": 3700,
    "caloriesFloor": 3500,
    "protein": 210, // grams
    "proteinFloor": 185,
    "fat": 100, // ? grams
    "carbs": 490, // ? grams
    "waterLiters": 3.5, // daily target midpoint
  },
  "adjustmentRule": "Weigh most mornings…", // plain-text calorie adjustment rule
  "phase": "gain", // ? gain | loss | recomp | cut, current training phase.
  //   The add-profile questionnaire only ever emits
  //   gain | loss | recomp; "cut" is hand-set later — a
  //   bank recipe tagged phases:["cut"] serves nobody
  //   until a profile is manually moved to cut.
  "phaseSince": "2026-07-10", // ? ISO date the current phase started
  "avoidIngredients": ["onion", "shallot"],
  // ? hard ingredient exclusions for this profile.
  //   Case-insensitive SUBSTRING match against bank
  //   recipe ingredient food names in mergeRecipePool
  //   ("onion" also blocks "red onion"). The profile's
  //   OWN recipes are exempt (authored to its rules).
  //   Absent = no screening.
  "region": { "country": "USA", "state": "IL" },
  // ? where this profile buys groceries, for sales tax on the List
  //   trip total (app/lib/prices.js GROCERY_TAX_RATE by state;
  //   absent field, unknown state, or country != "USA" = 0%).
  "tiredOf": ["pasta", "stir-fry"],
  // ? foods eaten too much of lately (survey "in a rut?"). SOFT variety
  //   penalty in weekbuilder pickCommittee (-1 per match, vs dislike's
  //   -2): loses ties, never banned. Absent = no penalty.
  "leftoverTolerance": "lots", // ? none | some | lots. Absent = some.
  //   Captured for leftover scheduling + the chat onboarder's context.
  "packsLunch": true, // ? packs lunch for work/school. Absent = false.
  "lunchMicrowave": false, // ? has a microwave at work (only meaningful
  //   when packsLunch). Absent/false + packsLunch = favor cold-packable.
  "mealsOutPerWeek": 2, // ? typical restaurant/dining-hall/free meals a week
  //   (gate survey 2026-07-21). Absent = rarely (0). Read by the assistant
  //   and future OUT-slot expectations; no generator behavior yet.
  "mealSlots": ["breakfast", "lunch", "dinner", "smoothie"],
  // ? ordered list of meal slots app/lib/weekbuilder.js's
  //   generateWeek proactively fills/committee-picks per day.
  //   Valid values: breakfast | lunch | dinner | smoothie.
  //   Snack is never listed here — it's always the reactive
  //   calorie/protein top-up pool, filled only as needed.
  //   Absent = ["breakfast", "lunch", "dinner", "smoothie"]
  //   (David's current behavior). A loss-phase profile with
  //   no smoothie (e.g. profiles/mom) lists
  //   ["breakfast", "lunch", "dinner"] so the generator
  //   doesn't force a 4th proactive meal past the calorie
  //   ceiling.

  // ---- survey-v2 onboarding answers (docs/survey-v2-design.md) ----
  // All optional; every field ABSENT = its safe default (no filter, no
  // weight). Written by the add-profile questionnaire via
  // targetsFromQuestionnaire (app/lib/fitness.js), editable later in SYS.
  "diet": "vegan", // ? enum omnivore | pescatarian | vegetarian | vegan.
  //   ABSENT = omnivore. FILTER in mergeRecipePool
  //   (app/lib/plan.js dietOf): removes bank recipes whose
  //   classification the diet doesn't admit. Own recipes exempt.
  "allergens": ["dairy", "gluten"], // ? preset ids the gate chips expand into
  //   avoidIngredients; kept so SYS re-renders the chips. Preset
  //   ids: nuts | peanuts | gluten | dairy | eggs | soy |
  //   shellfish | fish | sesame (ALLERGEN_TERMS in fitness.js).
  "snackAppetite": "meals", // ? enum grazer | meals. ABSENT = grazer.
  //   Caps macroTopUp snack stacking per day: grazer 3 (today's
  //   behavior), meals 1 (portion bumps do more of the work).
  "maxWeeknightMinutes": 30, // ? number. ABSENT = no cap. FILTER in
  //   generateWeek's pool(): drops recipes with totalTime over the
  //   cap from DINNER/LUNCH candidacy only. Honest-failure: a cap
  //   that empties a committee below 2 is relaxed for that slot and
  //   reported in WeekReport.timeBudgetRelaxed.
  "dislikeIngredients": ["mushroom", "olives"], // ? string array. ABSENT = none.
  //   WEIGHT (-2 per match) in pickCommittee bonus(): loses ties,
  //   never filters — a thin pool can't afford to hard-drop these.
  "cuisinePrefs": { "loved": ["italian"], "avoided": ["korean"] }, // ? ABSENT = neutral.
  //   WEIGHT in bonus(): +1 loved cuisine, -3 avoided. Max 3 loves.
  "maxDifficulty": 2, // ? 1 | 2 | 3. ABSENT = 3 (no filter). FILTER in
  //   pool(): drops recipes with difficulty over the cap from
  //   proactive-slot candidacy (still visible in the Cookbook).
  "equipment": ["oven", "rice cooker"], // ? string array of gear the profile
  //   HAS. ABSENT = assume everything. FILTER in pool(): drops
  //   recipes whose `equipment` need isn't covered. No blender also
  //   drops "smoothie" from mealSlots at questionnaire time. Values:
  //   blender | oven | rice cooker | food processor | freezer.
  "breakfastStyle": "savory", // ? enum sweet | savory | grab-and-go | surprise.
  //   ABSENT = surprise (no weight). WEIGHT (+1.5 on style match) in
  //   bonus(), applied to the breakfast committee only.
  "budget": "tight", // ? enum tight | normal | loose. ABSENT = normal.
  //   WEIGHT (tight only): +1 for the "cheap" tag, +0.5*foodGroups.
  //   beans, and doubles the ingredient-overlap dial so the week
  //   converges on fewer distinct shop items. No per-recipe price
  //   data exists yet — a future receipt-scanning feature (keyed by
  //   `stores`) plugs a real cost term in at pickCommittee's budget
  //   block (see the ponytail: hook there).
  "stores": ["Mariano's", "Aldi"], // ? string array of store names. CAPTURED
  //   ONLY today — the future key for per-store price data from
  //   receipt scanning. No mechanism consumes it yet.
  "shopsPerWeek": 2, // ? integer, ABSENT = 1. 1 = single weekly list
  //   (unchanged). >1 splits the List view into a pantry/bulk trip
  //   and a fresh trip (app/lib/shopping.js tripOf, app/views/
  //   shopping.js). Read by main.js -> ShoppingView.

  "tracks": ["sleep", "weight", "pushups", "water", "supplements", "dailyDozen"],
  // ? ordered list of Home check-in markers this profile
  //   shows (app/views/home.js reads it). Valid values:
  //   sleep | weight | waist | pushups | water |
  //   supplements | dailyDozen. Absent = the full David
  //   list above (back-compat for legacy/pre-multi-
  //   profile installs and the pre-load window).
  "dailyDozen": {
    // ? PER-DAY serving targets, Greger's published Daily Dozen
    "beans": 3,
    "berries": 1,
    "otherFruit": 3,
    "cruciferousVeg": 1,
    "greens": 2,
    "otherVeg": 2,
    "flaxseed": 1,
    "nuts": 1,
    "spicesHerbs": 1,
    "wholeGrains": 3,
    "beverages": 5,
  },
  "sleepHoursTarget": 8,
  "pushupsPerDay": 200,
  "priorityStack": ["Sleep", "Protein", "Training", "Water", "Everything else"],
  "nonNegotiables": ["1 L water on waking", "…"], // daily checklist source
  "supplementPlan": [
    {
      "id": "creatine",
      "name": "Creatine monohydrate",
      "dose": "5g",
      "timing": "daily, in smoothie",
      "notes": "", // ?
    },
  ],
}
```

The `supplementPlan[].id` values are the keys used in `fitness/daily.json`'s
per-day `supplements` check map.

`app/lib/weight.js`'s `weightTrend(days, todayIso, phase)` reads `phase` to
pick a verdict band: gain is on-target at +0.25 to +0.75 lb/wk; loss is
on-target losing 0.5 to 1.25 lb/wk (slower reads too-slow, including flat or
gaining; faster reads too-fast). `phase` defaults to `"gain"` when omitted.

## Fitness — `fitness/workouts.json`

Under the simplified logging flow (Phase 6), `sets` is written with exactly one
entry per exercise per session, the array shape is kept for backward
compatibility with any historical multi-set sessions, and
`personalRecords`/`seriesFor` read it unchanged either way.

```jsonc
{
  "_scheduleNote": "PLACEHOLDER mapping of existing templates, awaiting Be fit vault 3-day split", // ?
  "schedule": {
    // ? weekday -> templateId, fixed rotation (zero split-picking)
    "mon": "lower-a",
    "tue": "pull-a",
    "wed": "push-a",
    "thu": "pull-b",
    "fri": "lower-b",
    "sat": "push-b",
    "sun": null, // null = rest day
  },
  "templates": [
    {
      "id": "upper-a",
      "name": "Upper A",
      "exercises": [
        {
          "name": "Bench Press",
          "targetSets": 4,
          "targetReps": "6-8",
          "note": "Heavy. Primary overload lift.",
        }, // note ?
      ],
    },
  ],
  "sessions": [
    {
      "id": "a1b2c3d4", // unique in the file; merge key (multiple sessions/day allowed)
      "date": "2026-07-05",
      "templateId": "upper-a", // ? sessions can be freeform
      "exercises": [
        {
          "name": "Bench Press",
          "sets": [{ "weight": 80, "reps": 8 }], // weight in lb (Task 8 decision); 0 = bodyweight
        },
      ],
      "notes": "Felt strong; slept 8h.", // ?
    },
  ],
}
```

## Fitness — `fitness/daily.json`

One row per day; 10-second morning check-in.

```jsonc
{
  "days": [
    {
      "date": "2026-07-06",
      "weight": 180.4, // ? lb (Task 8 decision); weigh-day mornings only
      "waist": 34.5, // ? inches; weekly cadence by convention, not
      //   enforced — only profiles with "waist" in
      //   targets.tracks show this marker on Home
      "sleepHours": 7.5, // ?
      "pushups": 60, // ? running count through the day
      "water": 3.5, // ? LITERS in 0.25 steps (a cup ≈ 0.25 L — David's rule)
      "supplements": { "creatine": true, "magnesium": true, "multi": false, "fishOil": true },
      "calories": 3350, // ? auto-filled from day's plan, adjustable
      "protein": 205, // ? grams
      "dozen": {
        // ? hand-tracked Daily Dozen servings, David checks
        //   these off himself — recipes can't reliably deliver
        //   beverages/greens/other fruit/other veg alone
        "beverages": 3, // number of servings logged today, default 0
        "greens": 1,
        "otherFruit": 2,
        "otherVeg": 1,
      },
    },
  ],
}
```

`dozen`'s keys are a subset of `fitness/targets.json`'s `dailyDozen` keys — the categories
recipes alone can't cover (directive: David logs these by hand each morning/day; the
`generateWeek` build report already covers the recipe-deliverable categories via
`foodGroupGaps`). Absent `dozen` or absent key = 0 logged, not missing data.

## Fitness — `fitness/activities.json`

Reserved: no app code reads or writes this yet (activity logging is a planned
fast-follow; the purpose-recommendation hook is the reason `time` exists).

```jsonc
{
  "activities": [
    {
      "date": "2026-07-06",
      "type": "tennis", // tennis | climbing | hiking | other
      "time": "18:00", // ? local HH:MM, feeds purpose recommendations
      "durationMin": 90, // ?
      "intensity": 2, // ? 1..3
      "notes": "", // ?
    },
  ],
}
```

## Meta — `meta.json`

```jsonc
{
  "schemaVersion": 1, // bump on breaking schema change
  "lastWrite": { "device": "iphone", "at": "2026-07-06T18:20:11Z" }, // ? debugging aid
}
```
