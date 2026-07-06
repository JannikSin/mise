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
fitness/workouts.json     split templates + session log
fitness/daily.json        daily check-ins
fitness/activities.json   tennis/climbing/hiking sessions
meta.json                 app-level state (schema version, last-write info)
```

During development, fixture copies live in the app repo under `fixtures/` with the
same shapes. Never commit real user data to the app repo.

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

```jsonc
{
  "week": "2026-W28",
  "entries": [
    {
      "date": "2026-07-06",
      "slot": "dinner",                 // breakfast | lunch | dinner | smoothie
      "recipeId": "chicken-bulgogi-bowl", // exactly one of recipeId | freeText
      "freeText": "leftovers",          // e.g. "leftovers", "eating out"
      "servings": 2
    }
  ]
}
```

## Shopping list — `shopping.json`

Derived (aggregate week's ingredients → merge duplicates → subtract pantry
`onHand` staples → group by section). Check-state and manual items persist.

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

## Fitness — `fitness/workouts.json`

```jsonc
{
  "templates": [
    {
      "id": "upper-a",
      "name": "Upper A",
      "exercises": [
        { "name": "Bench Press", "targetSets": 4, "targetReps": "6-8" }
      ]
    }
  ],
  "sessions": [
    {
      "date": "2026-07-05",
      "templateId": "upper-a",          // ? sessions can be freeform
      "exercises": [
        {
          "name": "Bench Press",
          "sets": [{ "weight": 80, "reps": 8 }]  // weight in kg... TBD Task 8: David may prefer lb
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
      "weight": 78.4,                   // ? weigh-day mornings only
      "sleepHours": 7.5,                // ?
      "pushups": 60,                    // ? running count through the day
      "water": 6,                       // ? glasses
      "supplements": { "creatine": true, "magnesium": true, "multi": false, "fishOil": true },
      "calories": 3350,                 // ? auto-filled from day's plan, adjustable
      "protein": 205                    // ? grams
    }
  ]
}
```

## Fitness — `fitness/activities.json`

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
