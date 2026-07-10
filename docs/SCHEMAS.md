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
recipes/<id>.json         one recipe per file
pantry.json               staples registry + perishables
plans/<week>.json         e.g. plans/2026-W28.json
shopping.json             current derived list + check-state
fitness/targets.json      macro targets, adjustment rules, priority stack
fitness/workouts.json     split templates + session log
fitness/daily.json        daily check-ins
fitness/activities.json   tennis/climbing/hiking sessions (schema reserved — no UI yet)
meta.json                 app-level state (schema version, last-write info)
```

Schema-exemplar fixtures live in the app repo under `fixtures/` with the same
shapes; the post-edit hook's drift check reads them. Never commit real user
data to the app repo.

## Recipe — `recipes/<id>.json`

```jsonc
{
  "id": "chicken-bulgogi-bowl",
  "name": "Chicken Bulgogi Bowl",
  "description": "Weeknight bulgogi over rice with quick-pickled cucumber.",
  "sourceUrl": "https://…",            // ? where it was researched from
  "image": "images/chicken-bulgogi.jpg", // ? repo-relative path
  "servings": 4,
  "prepTime": 15,                       // minutes
  "cookTime": 12,                       // minutes
  "totalTime": 27,                      // minutes
  "mealType": "dinner",                 // breakfast | lunch | dinner | smoothie | snack
  "cuisine": "korean",
  "tags": ["rice-bowl", "batch-friendly"],
  "difficulty": 1,                      // 1..3
  "rating": 4,                          // ? 1..5, David's own
  "purpose": ["recovery", "everyday"],  // recovery | pre-activity | long-satiety | sick-day | everyday
  "effort": "assembly",                 // assembly (<15m) | cook (15-30m) | project (30m+)
  "ingredients": [
    {
      "qty": 500,
      "unit": "g",
      "food": "chicken thigh",
      "note": "boneless, thin-sliced",  // ?
      "optional": false,                // ? default false
      "staple": false                   // ? true = assume on hand, excluded from shopping
    }
  ],
  "instructions": [{ "step": 1, "text": "Slice chicken thin against the grain." }],
  "nutrition": {
    "calories": 640,                    // per serving
    "protein": 52,                      // grams per serving
    "carbs": 61,
    "fat": 18,
    "method": "estimated"               // estimated | usda-spot-checked
  },
  "foodGroups": {                // ? Daily Dozen servings this recipe provides per serving
    "beans": 1,                  // legumes/tofu/tempeh/edamame, ~0.5 cup cooked = 1
    "berries": 0,
    "otherFruit": 0.5,
    "cruciferousVeg": 0,         // broccoli, cabbage, kale, etc.
    "greens": 1,
    "otherVeg": 1,
    "flaxseed": 0,
    "nuts": 0.5,
    "spicesHerbs": 1,            // meaningful culinary use, not a pinch garnish
    "wholeGrains": 2,
    "beverages": 0,               // green tea etc; plain water excluded
    "method": "estimated"         // estimated | book-verified
  },
  "batchPrep": {
    "sundayComponent": "Marinate + cook protein; rice in cooker.",  // ?
    "weekdayAssembly": "Reheat, top, pickle. 10 min."               // ?
  },
  "timesCooked": 3,
  "lastCooked": "2026-06-28",           // ?
  "lessons": ["Double the marinade — it carries the bowl."]
}
```

## Pantry — `pantry.json`

Two tiers, deliberately lightweight (no decrement-on-cook ledger, ever).

```jsonc
{
  "staples": [
    {
      "id": "cayenne",
      "name": "Cayenne",
      "section": "spices",              // store section, see Shopping
      "onHand": true,
      "runningLow": false,              // one tap → re-adds to shopping list
      "premium": false                  // ? true = special occasions (saffron, porcini)
    }
  ],
  "perishables": [
    {
      "food": "half cabbage",
      "qty": "0.5 head",                // ? free string, human-scale
      "added": "2026-07-04",
      "expires": "2026-07-11",          // ?
      "useSoon": true                   // ? surfaces in recipe recommendations
    }
  ]
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
  "entries": [
    {
      "id": "b3e29f01",                 // unique in the file; merge key
      "date": "2026-07-06",
      "slot": "dinner",                 // breakfast | lunch | dinner | smoothie | snack
      "recipeId": "chicken-bulgogi-bowl", // exactly one of recipeId | freeText
      "freeText": "leftovers",          // e.g. "leftovers", "eating out"
      "servings": 2,
      "pinned": false   // ? true = GENERATE WEEK must never clear or overwrite this entry
    }
  ]
}
```
Absent `pinned` = unpinned (default behavior today, unchanged for existing data).

## Shopping list — `shopping.json`

Derived (aggregate week's ingredients → merge duplicates → subtract pantry
`onHand` staples → group by section). Check-state and manual items persist.
Displayed `qty`/`unit` are rounded up to a purchasable amount (whole counts,
sensible gram/ml/kg/L/cup/tbsp/tsp/lb/oz steps) after summing, not before.

```jsonc
{
  "generatedFrom": "2026-W28",          // ? week the list was derived from
  "items": [
    {
      "id": "chicken-thigh",
      "food": "chicken thigh",
      "qty": 1000,
      "unit": "g",
      "section": "meat",                // produce | meat | dairy | dry-goods | frozen | spices | other
      "checked": false,
      "manual": false,                  // true = David added by hand, survives regeneration
      "fromRecipes": ["chicken-bulgogi-bowl"] // ?
    }
  ]
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
    "protein": 210,                     // grams
    "proteinFloor": 185,
    "fat": 100,                         // ? grams
    "carbs": 490,                       // ? grams
    "waterLiters": 3.5                  // daily target midpoint
  },
  "adjustmentRule": "Weigh most mornings…",  // plain-text calorie adjustment rule
  "phase": "gain",                // ? gain | recomp | cut, current training phase
  "phaseSince": "2026-07-10",     // ? ISO date the current phase started
  "dailyDozen": {                 // ? PER-DAY serving targets, Greger's published Daily Dozen
    "beans": 3, "berries": 1, "otherFruit": 3, "cruciferousVeg": 1,
    "greens": 2, "otherVeg": 2, "flaxseed": 1, "nuts": 1,
    "spicesHerbs": 1, "wholeGrains": 3, "beverages": 5
  },
  "sleepHoursTarget": 8,
  "pushupsPerDay": 200,
  "priorityStack": ["Sleep", "Protein", "Training", "Water", "Everything else"],
  "nonNegotiables": ["1 L water on waking", "…"],  // daily checklist source
  "supplementPlan": [
    {
      "id": "creatine",
      "name": "Creatine monohydrate",
      "dose": "5g",
      "timing": "daily, in smoothie",
      "notes": ""                       // ?
    }
  ]
}
```

The `supplementPlan[].id` values are the keys used in `fitness/daily.json`'s
per-day `supplements` check map.

## Fitness — `fitness/workouts.json`

Under the simplified logging flow (Phase 6), `sets` is written with exactly one
entry per exercise per session, the array shape is kept for backward
compatibility with any historical multi-set sessions, and
`personalRecords`/`seriesFor` read it unchanged either way.

```jsonc
{
  "_scheduleNote": "PLACEHOLDER mapping of existing templates, awaiting Be fit vault 3-day split", // ?
  "schedule": {                   // ? weekday -> templateId, fixed rotation (zero split-picking)
    "mon": "lower-a", "tue": "pull-a", "wed": "push-a",
    "thu": "pull-b", "fri": "lower-b", "sat": "push-b",
    "sun": null                   // null = rest day
  },
  "templates": [
    {
      "id": "upper-a",
      "name": "Upper A",
      "exercises": [
        { "name": "Bench Press", "targetSets": 4, "targetReps": "6-8", "note": "Heavy. Primary overload lift." } // note ?
      ]
    }
  ],
  "sessions": [
    {
      "id": "a1b2c3d4",                 // unique in the file; merge key (multiple sessions/day allowed)
      "date": "2026-07-05",
      "templateId": "upper-a",          // ? sessions can be freeform
      "exercises": [
        {
          "name": "Bench Press",
          "sets": [{ "weight": 80, "reps": 8 }]  // weight in lb (Task 8 decision); 0 = bodyweight
        }
      ],
      "notes": "Felt strong; slept 8h."  // ?
    }
  ]
}
```

## Fitness — `fitness/daily.json`

One row per day; 10-second morning check-in.

```jsonc
{
  "days": [
    {
      "date": "2026-07-06",
      "weight": 180.4,                  // ? lb (Task 8 decision); weigh-day mornings only
      "sleepHours": 7.5,                // ?
      "pushups": 60,                    // ? running count through the day
      "water": 3.5,                     // ? LITERS in 0.25 steps (a cup ≈ 0.25 L — David's rule)
      "supplements": { "creatine": true, "magnesium": true, "multi": false, "fishOil": true },
      "calories": 3350,                 // ? auto-filled from day's plan, adjustable
      "protein": 205,                   // ? grams
      "dozen": {                        // ? hand-tracked Daily Dozen servings, David checks
                                         //   these off himself — recipes can't reliably deliver
                                         //   beverages/greens/other fruit/other veg alone
        "beverages": 3,                 // number of servings logged today, default 0
        "greens": 1,
        "otherFruit": 2,
        "otherVeg": 1
      }
    }
  ]
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
      "type": "tennis",                 // tennis | climbing | hiking | other
      "time": "18:00",                  // ? local HH:MM, feeds purpose recommendations
      "durationMin": 90,                // ?
      "intensity": 2,                   // ? 1..3
      "notes": ""                       // ?
    }
  ]
}
```

## Meta — `meta.json`

```jsonc
{
  "schemaVersion": 1,                   // bump on breaking schema change
  "lastWrite": { "device": "iphone", "at": "2026-07-06T18:20:11Z" } // ? debugging aid
}
```
