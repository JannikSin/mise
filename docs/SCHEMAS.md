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
pantry.json               LEGACY root pantry (read as fallback only) — the live
                          pantry is households/<h>/pantry.json: one items array
                          + derived legacy write mirrors (see Pantry)
households/<h>/waste.json the waste ledger: explicit write-off events (see Waste)
plans/<week>.json         e.g. plans/2026-W28.json
shopping.json             current derived list + check-state
occasions.json            dated overrides that take days off the generator
fitness/targets.json      macro targets, adjustment rules, priority stack
fitness/daily.json        the daily check-in row — SHARED with anvil, see below
fitness/workouts.json     LEFT FOR ANVIL 2026-08-18. Mise no longer reads or
                          writes it; the file stays until anvil has read it
                          from the phone, then it is deleted from this repo
fitness/activities.json   LEFT FOR ANVIL 2026-08-18, same disposal
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
— they were authored for that profile). **Own recipes ARE diet- and
allergen-screened, as of 2026-08-10.** They used to be exempt on the reasoning
that a human authored them and had already respected the profile's rules; that
exemption followed the DIRECTORY rather than any actual verification, so
anything generating a file into `profiles/<id>/recipes/` would have inherited a
bypass around the one screen this codebase calls trust-ending. Verified before
the change: screening removes ZERO of the 58 hand-written variants on disk.
Merge lives in `app/lib/plan.js` `mergeRecipePool`; the generator and views
only ever see the merged pool. An empty `profiles/<id>/recipes/` is a working state —
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
FAMILY tab in List (named EVERYONE before 2026-07-25; docs and code now both say FAMILY). No third file exists; ticking a combined item writes
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
    {
      "id": "laurie",
      "name": "Laurie",
      "emoji": "🥑",
      "phase": "recomp",
      "trainingEnabled": false,
      "household": "laurie",
    },
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
- `household?`: string, absent = `"home"`. **User-facing name: HOUSE (S1,
  2026-07-21)** — every label and hint says "house" (a physical kitchen);
  the storage field and the `households/` path keep this legacy name
  deliberately, zero data migration. Groups profiles into one grocery
  trip: the List view's FAMILY tab merges only profiles that share the
  active profile's household (`app/lib/shopping.js` `householdOthers`, wired
  in `app/main.js`). A profile alone in its household (e.g. Laurie in her own
  apartment) sees no FAMILY tab at all; absent-field profiles keep merging
  exactly as before the field existed. Not asked in the gate questionnaire —
  edited from the SYS App tile ("MOVE HOUSEHOLD", `app\views\system.js`),
  which normalizes to lowercase-kebab and stores `"home"`/blank as absent.
  Moving is deliberately cheap so a visiting member can join a household for
  a week and move back.
- `capabilities?`: string[] (council 2026-08-02, shaped like
  `targets.tracks`): the EXTRA app surfaces this profile has. ABSENT =
  everything (David, legacy installs — zero migration). `[]` = the family
  minimum: Plan, List, Today's family dinners, Settings, and nothing else.
  Values consumed today: `"scoreboard"` (household scoreboard) and
  `"money"` (List's who-owes-who tile). `"checkin"` retired 2026-08-09 with
  the in-app daily check-in (personal tracking lives in Crystal now); the
  value is ignored if present. Train stays governed by
  `trainingEnabled`. Read in `app/main.js` (`hasCap`), rendered down as
  props — a NEW surface must argue its way into a capability value, so the
  family default stays minimal without anyone remembering to hide things.
  Hand-edited in profiles.json for now; no SYS UI until a second household
  needs one.
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
  goal → `targetsFromQuestionnaire` (`app/lib/targets.js`, Mifflin-St Jeor
  × activity ± goal delta) writes a complete
  `profiles/<id>/fitness/targets.json` and appends to `profiles.json`.
  Recipes come from the shared bank, so no per-profile recipe seeding is
  needed.
- If the file is missing or unreachable, `store.js`'s `readProfiles()` falls
  back to a single default David profile so a fresh or pre-multi-profile
  install still boots straight into the app.

## Vitals — `health/vitals.json`

**LEFT FOR ANVIL, 2026-08-18.** Mise has no Vitals screen and its Worker no
longer carries the `/vitals` ingest route. That route was never configured in
production — `VITALS_KEY` and `MISE_DATA_WRITE_TOKEN` were never set, and the
seven rows in this file dated 2026-07-12 to 07-18 are the seeded demo rows,
never a real export. anvil reads this file until David re-points Health Auto
Export at anvil's own Worker, after which it can be deleted from this repo.

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

Store price catalogue for shopping-cost estimates. LIVE app data since the
2026-08-18 pricing meter (Tier 0.2/0.3): `matchPrice`/`itemCost`/`tripTotal`
power the trip tiles (whole-package charging via `parsePackSize`, per-lb rows
pay what they weigh, unconvertible needs fall back flagged `estimate`, and
unpriced coverage renders loud: "N of M rows UNPRICED, total is a floor");
`applyReceipt` refresh-writes actual paid prices back into it; `money.js`
bills table events from it. Entries: `{ id, name, prices: { <store-slug>:
{ price, size, estimate?, at? } } }` with `updated`, `region`, `stores` at
the top. `estimate: true` = derived/recent estimate, absent =
tracker-confirmed shelf price. `at` (Tier 3.5, 2026-08-19) = ISO date this
store price was last written by a live source (Kroger refresh, receipt);
prices older than `STALE_PRICE_DAYS` (14) render † in the list, and rows
without `at` predate timestamps and stay governed by `estimate` alone. A
store absent from an item's `prices` = not reliably stocked there.
**Row ids are LEDGER KEYS (PF.3):** rows written by the live-price path or
learned from receipts use `canonicalFood(name)` as their id, the same key
pins.json and pantry matching use, and `applyReceipt` resolves a line
against a row id BEFORE falling back to the word-overlap matcher. Legacy
hand-written ids survive via that fallback.
Integration (`app/lib/prices.js`, read raw in `app/main.js`): the List view
shows a price chip per row (matched by word overlap ≥ 0.6 against name/id,
`~` = estimate), and a trip-total tile (subtotal + grocery tax from
`targets.region` + honest coverage line + cheapest-well-covered-store
ranking that never lets a store missing half the basket "win"). Chips price
at the profile's first `targets.stores` entry, slugified; fallback is the
cheapest covered store.

### Aisle maps — optional `aisles` key on `prices.json`

David, 2026-07-25: the store toggle should change the GROUPING, not just the
prices, so the list walks the store in order.

```jsonc
{
  "aisles": {
    "marianos": {
      "order": ["produce", "bakery", "meat", "seafood", "dairy", "canned"],
      "labels": { "canned": "Aisle 7", "spices": "Aisle 9" }, // ? shown beside the header
    },
  },
}
```

Hand-curated once per store, because a store's layout is a stable fact and no
grocery chain publishes it as data. Rules:

- `order` lists aisle names from the shared taxonomy (`AISLES` in
  `app/lib/ingredients.js`); unknown names are ignored.
- Anything the curated order omits still renders AFTER the curated part, in
  the default US walk order, so a half-finished aisle map can never hide
  groceries.
- Absent store, or absent `aisles` entirely = the default walk order and no
  aisle labels. Nothing breaks without it.

**Kroger note (verified 2026-07-25):** Mariano's is Kroger, and the Kroger
Products API does return per-store aisle number, side and shelf under
client-credentials OAuth (`product.compact` scope, ~10k calls/day, no partner
agreement). That is a real future source for `labels`, but coverage is not
guaranteed per item, so any integration must fall back to the curated order
per item rather than assume a lookup succeeded. Read Kroger's terms first,
particularly on client-side caching, since this app is offline-first.

## Pins — `pins.json` (data-repo ROOT, shared reference, read raw)

The ledger's identity file (fix list 3.2 promoted by PF.3): a confirmed
ingredient→product mapping per store. Resolution is learn-once — an
ingredient is searched at a store at most once, ever; after that its UPC is
refreshed directly. The pin key is `canonicalFood(food)`, the same key
catalogue row ids and pantry matching converge on.

```jsonc
{
  "updated": "2026-08-19",
  "redList": [], // brand names never auto-picked (P5: grows from real experience)
  "stores": {
    // catalogue store slug → Kroger locationId. Only stores listed here get
    // live features (the $? pick flow, REFRESH); others stay catalogue-only.
    "marianos": { "locationId": "53100502", "name": "Mariano's Vernon Hills" },
    "pay-less": { "locationId": "02100824", "name": "Pay Less Super Markets W Lafayette" },
  },
  "pins": {
    "chicken-breast": { // canonicalFood — THE ledger key
      "pay-less": {
        "upc": "0021142100000",
        "description": "Heritage Farm® Boneless Skinless Chicken Breasts",
        "size": "1 lb",
        "soldBy": "WEIGHT", // WEIGHT = priced per lb (catalogue stores "per lb")
        "confirmedAt": "2026-08-19", // ? the confirm-once tap happened
        "provisional": true, // ? auto-picked (seed / re-pin), awaiting the tap;
        // renders a ? button on the row. confirmPin swaps it for confirmedAt.
      },
    },
  },
}
```

Integration: `app/lib/kroger.js` (pure logic: rankCandidates with the
category/section/form gates + noise ranking, applyLivePrice write-through,
swap classes, allergen OUTPUT screen), Worker `/kroger/*` endpoints (the
client id/secret live only in Worker secrets), `views/shopping.js` ($? pick
sheet, ? confirm, REFRESH). Substitution rule (3.4): candidates for a row
are same-food by construction (every food word must appear), so an
auto-(re)pin is always a FORM swap; anything dish-changing exists only as a
manual choice in the pick sheet, and every offered product is
allergen-screened on its description + categories before it can be pinned.
Quota discipline (3.3): pins cache resolution forever, REFRESH is weekly and
by UPC, the app never loops live searches, and a revoked API degrades to
last-known (†-stale) prices.

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
      "staple": false, // ? LEGACY LABEL ONLY (2026-08-09, David: "staples
      //   run out"): the tag no longer suppresses buying — ownership is
      //   asserted only by pantry.json onHand (scans + P+). Kept in the
      //   schema as a display hint and for the weekbuilder's overlap scoring.
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
  "hbp": {
    // ? present only on recipes saved by the HBP Recipe Scan (#/annotate).
    //   The ONE schema addition of P2 (gate D1). Such recipes carry
    //   tags: ["hbp-annotated", "contains:<allergen>"...] and are fenced out
    //   of every auto-planner (generatorEligible + brigadePool) until a human
    //   sets promoted: true, the same promotion contract as ai-special.
    "objective": "fit-the-plan", // fit-the-plan | taste | same-time | faster | simpler
    "score": 70, // null for refusal-class (never scored); how the recipe is WRITTEN, not how it tastes
    "buckets": {
      "technique": "isolated",
      "precision": "several",
      "sequence": "isolated",
      "time": "none",
      "ingredients": "isolated",
    },
    "mode": "annotated", // clean | annotated | rebuild (refusal/abandon/tier-2 never save in v1)
    "riskGroups": false, // true = tier-2 temp / raw prep; renders the risk-group line
    "sourceQuote": "Simmer until thick", // verbatim line proving the fetch was real
    "allergensFound": ["wheat"],
    "summary": ["everything in grams"],
    "planFit": ["+50 g rice toward the 3700 target"],
    "steps": [
      // hbp.steps[].n matches instructions[].step: join on that to place
      // margin notes and temps against the right step in a future richer
      // renderer. (The save transform ALSO folds temps + notes into
      // instructions[].text, so every existing view renders them already.)
      {
        "n": 1,
        "notes": ["crust is flavor"],
        "temps": [{ "label": "done-ground", "unit": "C", "fromSource": false, "value": 71 }],
      },
    ],
    "ingredientMarks": [{ "food": "black beans", "wasOriginal": "2 cups" }],
    "transcription": "Beef Chili. Serves 4. …", // call-1 transcript, embedded ON SAVE only
  },
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

**ONE PANTRY (fix list 1.1, council 2026-08-18: the staples/perishables
split is dead).** The garlic bug was structural: a "staple" was a class the
shopping list could never reach, an assumption of ownership that became a
lie the moment the jar ran out. There is now ONE `items` array and no
exempt class. Every item is either:

- a **state item** (no date, no location): shelf-stable food carrying a
  per-item human assertion. `state: "plenty"` suppresses buying by name at
  derive time (the old `onHand`); `state: "low"` forces the item onto the
  next list (the old `runningLow`); state ABSENT means OUT — the item buys
  whenever a recipe needs it, like any other food. The PANTRY tab cycles
  PLENTY → LOW → OUT with one tap.
- a **tracked row** (`added` and/or `qty` and/or `location`): counted food.
  It expires by shelf life, subtracts from the trip by real quantity
  (`subtractPantryFromTrip`), gets consumed by cooking (`consumeForCook`),
  and arms the generator's useSoon steering. Exactly the old perishables,
  semantics unchanged, honesty fences intact: oldest row first, shortfall
  carries to the next pack, free-text `qty` rows are removed whole rather
  than fake-subtracted, ≤2% slivers are removed, un-marking a meal puts
  nothing back.

`staples` and `perishables` survive as derived WRITE MIRRORS so devices on
older app code keep functioning during the migration window (their reads
see the mirrors; a mirror edit made by an old device may be overwritten by
the next new-code write). New code never reads the mirrors — everything
routes through `pantryItems()`; `normalizePantry()` migrates a legacy
two-tier file to `items` on first load and is an identity function on an
already-packed file. **Mirror drop: dated and owned (PF.1, no-dark-features
rule): David confirms every device has updated, then the next Mise session
after 2026-09-01 removes the mirrors from `packPantry` and the reconcile
from `normalizePantry` in one commit. Until then the mirrors are
load-bearing for old devices; the reconcile can resurrect a deletion merged
against an old device's mirror write, which is the accepted cost of the
window and one more reason the window is short.**

```jsonc
{
  "items": [
    {
      // state item: an assertion, not an inventory count
      "id": "cayenne",
      "food": "Cayenne",
      "section": "spices", // store section, see Shopping
      "state": "plenty", // ? "plenty" | "low"; absent = OUT (buys on need)
      "premium": false, // ? true = special occasions (saffron, porcini)
    },
    {
      // tracked row: counted, dated, consumed
      "id": "a1b2c3d4", // stable id (P1): removal + 409 merges key on it, never on
      // array position. Pre-P1 rows self-heal a DETERMINISTIC id on read
      // (FNV over food|added|qty + twin index, so two devices healing the
      // same household pantry agree), persisted next write.
      "food": "half cabbage",
      "qty": "0.5 head", // ? free string, human-scale. "<number> <unit>" is what
      // cook-subtraction can do arithmetic on; anything else is
      // removed whole when the food is cooked.
      "added": "2026-07-04",
      "expires": "2026-07-11", // ? REAL since 2026-08-19 (PF.3): stamped at buy time
      // by applyJustBought (expiryFrom = added + shelfLifeDays for the row's
      // location) and PREFERRED over the regex inference by
      // perishableStatus/expirePerishables wherever present, so a corrected
      // date sticks. Rows without it (pre-stamp, scans) keep the inference.
      "useSoon": true, // ? surfaces in recipe recommendations
      "location": "fridge", // fridge | freezer | pantry | unsorted. The PANTRY tab's
      // shelf chips filter on this, and a photo sweep replaces
      // exactly one location. Bought food is placed by store
      // section (locationForBuy): frozen → freezer, the fresh
      // run → fridge, shelf-stable → pantry. "unsorted" is the
      // quarantine for unplaced rows — no sweep touches it.
      "group": "produce", // aisle, for grouping (aisleOf)
    },
  ],
  "staples": [], // derived write mirror (see above) — do not hand-edit
  "perishables": [], // derived write mirror — do not hand-edit
}
```

**Fresh start (2026-08-01, no schema change):** the PANTRY tab's START FRESH
wizard empties the whole file (staples included, behind the same confirm as
EMPTY EVERYTHING) then walks fridge → freezer → pantry shelves → spice
cabinet with the camera. Wizard scans run in "add" mode —
`applyScanItems(pantry, items, today, location)` places new perishables on
the step's shelf ADDITIVELY, because a wiped kitchen needs several photos
per shelf and a second fridge photo must extend the first, not replace it.
Non-wizard shelf scans keep sweep-replace semantics unchanged.

## Waste ledger — `households/<h>/waste.json` (PF.1, 2026-08-18)

Explicit write-off events for food that left the pantry WITHOUT being cooked.
Canon (Core-Purpose P6 + P11): expiry is never a silent delete, dormancy must
not launder waste past the ledger, and the weekly review's tossed-vs-used axis
reads exactly this file. History is append-only and cannot be backfilled.
Written by `appendWaste` (`app/lib/waste.js`) at the auto-expiry site in
`main.js`; read by the review engine when it lands (Tier 7.1).

```jsonc
{
  "events": [
    {
      // UNIQUE PER EVENT (rowId|date|reason) — the 409 keyed-array merge
      // keys on `id` and collapses duplicates, and the same pantry row can
      // legitimately expire twice (edit-beats-delete resurrection), so the
      // event id must never be the bare row id. Doubles as the appendWaste
      // idempotency key: every device runs the same sweep, one event lands.
      "id": "a1b2c3d4|2026-08-18|expired",
      "date": "2026-08-18", // the day it was written off
      "reason": "expired", // "expired" today; manual confirms and the review add theirs
      "rowId": "a1b2c3d4", // the pantry row's stable id, null for pre-id rows
      "food": "spinach",
      "qty": "1 bag", // ? carried from the row when present
      "added": "2026-08-01", // ? when it was bought/scanned in
      "location": "fridge", // ?
    },
  ],
}
```

## Tables (shared meals) — `households/<h>/events.json`

One shared meal = a TABLE (docs/tables-design.md, Tribunal-gated). The file
lives with the house (raw path, like the house pantry); the house is the
path, no houseId field. Every profile's app DERIVES virtual pinned plan
entries from every house's tables at read time — derived entries carry
`table: <id>` and are NEVER persisted into a plan file (main.js strips them
before every plan write).

```jsonc
{
  "tables": [
    {
      "id": "a1b2c3d4",
      "name": "Family dinner",
      "date": "2026-07-24",
      "slot": "dinner", // plan slot keys
      "recipeId": "doner-style-kebab-bowl", // must resolve in the BANK
      "buyerId": "mom", // ? GROCERY CLAIM (David 2026-08-03): who volunteered
      //   to BUY this dinner's ingredients ("I'll buy this" on the card, or
      //   the List's claim-all button). Cooking and buying are separate
      //   jobs. ABSENT = unclaimed: the batch rides NOBODY's shopping list
      //   — never added automatically, not even the cook's. Set/cleared via
      //   setTableBuyer (clearing removes the field). Must be an in-house
      //   profile or the claim is inert at derive time. Survives brigade
      //   regeneration like a seat's skip. The money ledger's payer is the
      //   buyer, falling back to the cook for unclaimed tables.
      "seats": [
        // seat id = profileId — id-keyed so concurrent seat edits merge
        { "id": "david", "servings": 1.5, "rawServings": 1.482 },
        // ? rawServings: the UNROUNDED, UNCLAMPED appetite ratio (sigma,
        //   per-person-plates-design §4.3), written in the SAME
        //   materialization write as servings so the pair is stale together
        //   or fresh together, and carried/recomputed under the same
        //   recipe-unchanged gate. The solve's target side divides by this;
        //   a seat whose servings no longer equal round(clamp(rawServings))
        //   was HAND-EDITED and the solve treats the human's number as the
        //   target (sigma := servings). Absent on legacy seats = same rule.
        { "id": "mom", "servings": 1, "status": "skipped" }, // ? absent = in
      ],
      "pot": "{\"synthV\":1,...}", // ? THE FROZEN POT (per-person-plates-design
      //   §10): the contract for MONEY AND BUYING, nothing else. A JSON
      //   STRING on purpose — mergeFieldWise treats strings atomically, so
      //   two devices' freezes can never interleave field-wise. Parsed shape:
      //   { synthV, inputs: { recipeRev, targets: { <profileId>:
      //   <github-blob-sha | "dirty" | "missing"> } }, synthMode: "solved",
      //   rows: [{ food, unit, qty, perSeat: { <profileId>: qty } }],
      //   topUps?: [{ food, unit: "g", qty, perSeat }] }. perSeat is each
      //   seat's share of the row, 3dp, so money bills pay-for-what-you-eat
      //   exactly; topUps are rung-3 floor top-ups (added food, validated
      //   outside the row-identity check, priced into the buy and billed to
      //   the eating seat). Written ONLY in solved mode, by
      //   setTablePot at buy-claim or COOKED (first trigger wins); dropped
      //   by unclaim-while-uncooked and by sameForEveryone; validated on
      //   every read (parsePot: full row identity vs the bank recipe,
      //   finite qtys, no merge keys) and DROPPED to the plain path when
      //   invalid. Survives brigade regeneration only while the recipe is
      //   unchanged. ABSENT on every uniform table — which today is all of
      //   them (zero assembly tags), the inert-deploy guarantee.
      "headId": "mom", // ? THE HEAD (per-person-plates-design §9): the one
      //   person whose plate decisions win for this table. Written ONLY by
      //   a human tap (setTableHead; TAKE THIS TABLE) — never stamped at
      //   materialization, which would break byte-identical offline merges.
      //   ABSENT = default chain: resolveHead falls through cook → first
      //   present seat in profiles.json order, re-validating presence on
      //   every read. Survives brigade regeneration even across a dish swap
      //   (it is about people, not food). Gates REDO PLATES; shown as
      //   "<name>'s table".
      "guests": 2, // ? GUEST PLATES (7.4, canon P8, 2026-08-19): "us plus
      //   two" is the same pot with two extra plates on a sensible default —
      //   one bank-recipe serving each. Clamped 0..10 (clampGuests, the F2
      //   seats bound). Guests join the cook's pot total and the buy;
      //   BILLING a guest stays parked in Mise-Later, so their cost rides
      //   the cook's ledger. Absent = 0.
      "cookedAt": "2026-07-24", // ? the serve step's COOKED confirmation
      //   (per-person-plates-design §7.2). Set once by setTableCooked, never
      //   cleared (you cannot un-cook food, same rule as a plan entry's
      //   cookedAt). ABSENT = not confirmed. Survives brigade regeneration
      //   only while the recipe is unchanged — carried onto a swapped dish
      //   it would mark a meal cooked that never was. This is the adoption
      //   signal the plates instrument reads; nothing else records that a
      //   shared meal actually happened.
      "tailor": {
        // ? AI plate-tailoring (Worker /tailor or the dinner discussion):
        //   one shared pot, per-seat plating adjustments toward each seat's
        //   own targets. Written whole by setTableTailor (whitelisted keys
        //   only); re-tailoring replaces it. Absent = never tailored.
        "at": "2026-07-23", // ISO date it was generated
        "seats": {
          "david": {
            // ? scale-first (2026-08-09): weighed grams of the finished dish
            //   on this plate; absent/0 on tailors from before the scale
            "portionGrams": 450,
            "plate": ["add 150 g cooked rice", "1 fried egg on top"], // 1-4 measured actions
            "estCalories": 1150, // this seat's plate after adjustments
            "estProtein": 66,
          },
        },
        // 0-4 sequenced one-pot notes ("portion one plate out before the onions")
        "cook": ["hold the bread back; plate one without it"],
      },
    },
  ],
}
```

Rules (binding, from the Tribunal gate):

- Derivation validates every table individually (date shape, known slot,
  recipe resolves, servings clamped 0.5-10) and skips invalid ones; the
  whole derive degrades to "no tables" on any failure.
- The recipe is screened against every seat's `diet`/`avoidIngredients`
  with the same `recipeConflicts` predicate the pool filter uses — at
  creation (inline seat warnings) AND at every derivation (conflict =
  banner, no pin, no macros).
- A seat with `status: "skipped"` derives nothing and is excluded from the
  cook's shopping sum.
- The COOK = the table's explicit `cookId` when it names an in-house
  profile whose seat is NOT skipped. A skipped named cook hands the role to
  the first non-skipped in-house seat (David 2026-08-09, superseding the
  2026-08-01 "still cooks and still pays" rule: SKIP MINE means "I'm not
  there", and the house must still eat).
- SHOPPING follows the BUYER, not the cook (claims, 2026-08-03): only the
  profile matching `buyerId` derives the summed-servings shopping
  pseudo-entries. No `buyerId` = no list anywhere carries the batch. Every
  other seat's entry is est-macro only (nothing to buy).
- A profile's own entry at the same date+slot wins over the table entry.
- Retention: derivation ignores tables >14 days past; every CRUD write
  (add, remove, seat patch) prunes them, malformed dates included.
- The cook's shopping sum counts every known non-skipped seat, INCLUDING
  seats whose own diet screen conflicts (a conflict is per-reader; the cook
  cannot know a guest's screen) — the cook may knowingly over-shop by that
  seat's portion.
- Derived entries additionally carry `viewRecipeId` (Cook-view recipe link)
  and, for the cook only, `cookTotal` (the batch total to cook). Both are
  DERIVED-ONLY fields: they exist in memory, never in any stored file.
- A tailored table's derived entry also carries `plate` (my seat's
  `tailor.seats[<me>].plate`), same derived-only rule, and its
  `estCalories`/`estProtein` use the tailored plate's estimate instead of
  recipe × servings (council 2026-07-23: the day meter counts the plate
  actually eaten, tailoring is never display-only theater).
- Worker-side deterministic avoid screen (council 2026-07-23, code-enforced
  AFTER the model, never an AI judgment): `/tailor` drops any plate line
  naming an ingredient on that seat's own avoid list; `/dinner` refuses a
  special whose ingredients hit ANY participant's avoid list and blanks
  plate notes that do.
- The dinner discussion (`#/dinner`, Worker `/dinner`) applies its decision
  as a normal table for tonight's dinner slot. A "special" (AI-invented)
  meal is first written to the shared bank as
  `recipes/special-<slug>-<date>.json` tagged `"ai-special"` (normal recipe
  schema, `nutrition.method` and `foodGroups.method` = `"estimated"`), so
  macros, shopping, and every seat's plan work unchanged.
- WEEK OF MEALS (Tables tab, Worker `/dinnerweek`, 2026-08-09): one call
  plans every remaining breakfast/lunch/dinner that has no table yet —
  people picked, slots picked (snacks/smoothies stay personal, never planned
  here), per-person ATTENDANCE days (`away`: personId → dates; an away day
  seats that person on NONE of the day's tables, so cook totals, plates and
  the buy all shrink with the seat, and the model is told to plan them no
  plate), optional cuisine/theme, per-meal bank pick or special, per-person
  plate specs with weighed gram amounts so each person lands near their own
  daily calories/protein while the house cooks each slot ONCE. Each meal
  lands as an ordinary table via the same apply path as `/dinner` (specials
  to the bank first, plates as the table's tailor block) with `buyerId`
  pre-set to the runner, so the groceries are claimable-free and the List is
  buildable the same day. Derivation, shopping claims, and the money ledger
  work unchanged. The same deterministic avoid screen runs per meal: a
  special hitting any never-serve list (ingredients, name, or instructions)
  drops that MEAL (reported in `notes`, never silently), and offending plate
  notes are blanked. Macro fields are clamped server-side (kcal ≤5000/serving,
  macros ≤500 g, plate estimates ≤6000 kcal) before anything is stored.
- **Generator trust gate (council 2026-07-23):** an `ai-special` recipe is
  settable as a table and browsable in the cookbook, but `generateWeek` and
  `poolAdequacy` exclude it (`generatorEligible` in weekbuilder.js) until a
  human/Greger audit sets the optional recipe field `promoted: true`. An AI
  estimate may propose and display; it never silently enters the
  generator's trusted denominator.

### Brigades (standing tables) — same file, `brigades` array

A BRIGADE is a standing table: two or more people in ONE house who eat the
same meals at their own portions. It stores only the standing rule.
Generation MATERIALIZES ordinary tables tagged `fromBrigade`, so every rule
above applies to a brigade meal unchanged — there is no second derivation
path, and no brigade-specific behaviour anywhere downstream.

```jsonc
{
  "brigades": [
    {
      "id": "e5f6a7b8",
      "name": "Mom + Laurie",
      "memberIds": ["mom", "laurie"], // 2+, all in THIS house. ORDER MATTERS
      //   when rotateCooks: the cook cycles through this array; the brigade
      //   form stores it in the picker's display order so the chips read as
      //   the rotation.
      "slots": ["dinner"], // plan slot keys
      "cookId": "mom", // ? who shops; absent = first member
      "rotateCooks": true, // ? cooks take turns (David 2026-08-01: "each person
      //   is responsible for 1-2 dinners"). The materialized table's cookId
      //   cycles through memberIds in order, one per calendar day from
      //   `from`, derived from the DATE (never a loop counter) so any device
      //   on any day assigns the same cooks and the id-keyed merge stays a
      //   no-op. Overrides `cookId`. Absent/false = single cook, unchanged.
      //   Mixed-version caveat: a pre-rotation device that materializes
      //   first stamps its single cookId and the idempotency guard keeps
      //   those tables until someone RE-ROLLs on current code.
      "from": "2026-07-27",
      "until": "2026-08-02", // REQUIRED, span capped at 28 days
    },
  ],
}
```

A materialized table carries two extra fields: `fromBrigade` (the brigade's
id) and `cookId`. Both are normal stored fields, unlike the derived-only
ones above.

Rules (binding, from the Tribunal plan gate):

- **Ids are DETERMINISTIC**: `b-<brigadeId>-<date>-<slot>`. Two members
  generating the same week offline must produce the same rows, or the
  id-keyed merge unions them and — because the cook's shopping entry is
  pushed before the one-pin-per-slot guard — the cook silently buys and is
  billed for every meal twice.
- **Any member may generate**; `cookId` decides who SHOPS, not who may run
  it. Materialization is idempotent on (brigade, date, slot).
- **Regeneration carries seats forward**, preserving `status` and edited
  `servings`, and rewrites only the recipe. Rebuilding seats would erase a
  `skipped` and cook a portion nobody eats.
- **Already-lived days are never touched** (`date < today` is skipped).
- **The pool is the INTERSECTION** of every member's `diet`/`avoidIngredients`
  screen, over the shared BANK only — each profile's `own` recipes are exempt
  from screening by design, which is unsafe once the meal is served to other
  people. An empty pool makes nothing and says so; a thin one is reported.
- **One house, rechecked at materialize time**, not trusted from creation: a
  member who moves out stops being planned for and stops riding the cook's
  list.
- `validBrigade` is a trust boundary like `validTable`: `until` required,
  span ≤ 28 days, 2+ member ids, known slots, non-empty id. Invalid brigades
  are dropped individually at normalize time.
- **A hand-set table beats a brigade meal** at the same date and slot, and
  the cook's shopping entries are deduped per date and slot, so one meal is
  bought once however many tables claim it.
- Portions come from each member's own targets, renormalized over that
  member's own `mealSlots`, rounded to 0.25 and clamped to [0.5, 3] (tighter
  than the hand-set table clamp of [0.5, 10]).
- Removing a brigade also removes its FUTURE tables; past ones stay, because
  the money ledger is entitled to meals that actually happened.

## Money ledger — `households/<h>/ledger.json`

Who-owes-who from shared Tables (roadmap M1). The table's COOK's device
records each FINISHED table once (idempotent by table id; entries are
id-keyed so concurrent recorders merge to one). Costing mirrors the
shopping list's honesty: prices.json floor-prices the recipe per serving,
anything unpriceable flags the entry `estimate` (shown with `~`). Shares
follow seat servings (2 servings owes twice 1). Mise never moves money:
balances settle in the real world, then SETTLED flips the flag.

```jsonc
{
  "entries": [
    {
      "id": "a1b2c3d4", // = the table's id
      "date": "2026-07-24",
      "payerId": "david", // the cook
      "total": 13.5,
      "estimate": false,
      "shares": { "david": 9, "mom": 4.5 }, // payer's own share = their own dinner, not a debt
      "settled": false,
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
  "locked": false, // ? LEGACY (7.2, 2026-08-19: the locked week is ABOLISHED).
  //   Old devices may still write it; normalizePlan tolerates it; no current
  //   code reads it. The replacement is `fallback` + the coverage check.
  "fallback": { "savedAt": "2026-08-19", "entries": [] }, // ? THE SHOPPED PLAN
  //   (7.2, canon P4: shopping locks the INGREDIENTS, never the plan).
  //   Written by GOING TO THE STORE (saveFallback) and auto-snapshotted
  //   before a post-shop GENERATE. The plan stays freely changeable;
  //   restoreFallback puts this shape back (cooked meals stay cooked). The
  //   one governing rule — every bought perishable gets used before it
  //   dies — is derived per render by app/lib/coverage.js and shown as the
  //   Plan tab's coverage banner, never stored.
  "shoppedAt": "2026-07-25", // ? groceries CONFIRMED bought (a scanned receipt
  //   sets this via setPlanShopped). Honest-state rule (2026-07-23): absent =
  //   not confirmed; the Worker's cook-reminder cron stays silent for the week.
  "spend": [{ "store": "pay-less", "date": "2026-08-19", "total": 73.81 }], // ?
  //   the SPEND leg of the one ledger (PF.3, 2026-08-19): each approved
  //   receipt appends its trip total here via setPlanShopped, so
  //   spent-vs-budgeted (P5) and the weekly review (P11) read a real paid
  //   number, not estimates. Absent = no receipt-confirmed spend recorded.
  "unlocked": ["turkey-chili"], // ? recipes opened by hand this week ("I already
  //   have this"), for cooking out of the pantry without a shop. Absent = none.
  //   THE RECIPE GATE (David, 2026-07-25): with no receipt, a recipe shows its
  //   name, macros and ingredients but NOT its steps, and cook mode refuses.
  //   The gate asks whether the HOUSE has shopped, not the person: a brigade
  //   has one cook and one receipt, so keying it to each profile's own plan
  //   would hide every instruction from everyone but the cook, permanently.
  //   Food safety is never gated (Red Team): shelf lives, temperatures and
  //   danger signs stay on the List tab whatever the receipt says.
  "buffer": { "recipeId": "smoky-three-bean-edamame-protein-salad", "portions": 7 }, // ? see below
  "manifest": { "generatedAt": "2026-08-18", "subsystems": {} }, // ? THE GENERATION
  //   MANIFEST (fix list 2.5, council 2026-08-18): what every subsystem did on
  //   this generate — budget mode, useSoon matches, philosophy vector, top-up
  //   restriction, floors + their lastReviewed date, plating (inert by council
  //   2026-08-12), weight trend, cooked-over-planned, protein in g/kg vs the
  //   Morton band. Written by generateWeek's call site (composeManifest in
  //   app/lib/manifest.js), rendered on Plan, persisted so every device sees
  //   it. tests/manifest.test.js fails the build if a registered subsystem
  //   reports nothing: the countermeasure to the fifth dark engine.
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
      "cookedAt": "2026-07-06", // ? confirmed cooked (Cook mode's DONE button,
      //   toggleEntryCooked — OR the recipe page's cook timer END, recordCook,
      //   7.10). Absent = never confirmed: the Plan scoreboard shows "not
      //   logged" instead of "eaten" on past days, and the cron keeps
      //   reminding until it's set. A date alone NEVER implies eaten.
      "cookSeconds": 1740, // ? the cook timer's recorded hands-on span (7.10,
      //   promise P7): what the recipe's stated time answers to. Written by
      //   recordCook at the timer's END; absent = cooked without the timer.
      "cookComment": "burned the first batch", // ? the "overrun was me, not
      //   the plan" note (setCookComment, <=200 chars); P11's review reads it
      //   beside stated-vs-recorded. Absent = no note.
    },
  ],
}
```

Absent `pinned` = unpinned (default behavior today, unchanged for existing data).

**`sameForEveryone` (table field, optional; absent = tailored).** Plate
tailoring is the DEFAULT as of 2026-08-10: every upcoming table in your own
house tailors itself once, automatically, because following the plan should be
what happens when nobody does anything. This flag is the opt-out for one meal
("everyone eats the same tonight"), and setting it DROPS any existing `tailor`
block, because those plates are exactly what the person just rejected.
Clearing it removes the field entirely and the auto-tailor picks the table up
again. Per-table on purpose: a cheat night is one dinner, not a new way of
eating. The auto-run is guarded to one table at a time and never retries a
table it has already attempted, so a failing table cannot loop on an AI call.

**NO SERVING COUNTS IN ANYTHING A PERSON READS (2026-08-10).** `servings` on a
recipe remains the denominator its macros are quoted against, and seat
`servings` remains the pot-share scalar. Neither is an amount of food anybody
should eat, and printing them invited exactly the wrong reading: the app used
to say "cooking 0.75 of 3", "cook x9.75", and "David x2.5 - Mom x0.75", which a
person reads as "am I eating two and a half servings?" (David: "what are you
trying to do, make me fat?"). Every user-facing surface now names WHOSE food it
is and lets the ingredient amounts carry the quantity. Keep it that way.

**`potFromBank` (shared-table pot lines only; absent = a normal entry).** A
cook/buyer's derived shopping pseudo-entry carries the BANK recipe's id and the
whole pot's serving total. `deriveShoppingList` resolves `recipeId` through the
MERGED pool, where a profile's own variant wins by id — so a buyer who owned a
same-id variant had the HOUSE shopped from their own smaller plate, scaled by a
seat total computed from the bank's calories (David, 2026-08-10; 17 of one
profile's 27 seated meals were this case). Pot lines are therefore flagged and
resolved against the bank map `deriveShoppingList` takes as its final argument.
The flag travels on the ENTRY rather than being handled by swapping the lookup
map, because a person's own plan entry and the shared pot line can carry the
SAME recipe id and need opposite resolutions.

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

THE FLUID WEEK (7.2, 2026-08-19; canon P4): `locked` is retired. GOING TO THE
STORE now writes `fallback` (the shopped plan, always there to return to) and
every edit stays allowed — SWITCH, OUT, add, swaps, all post-shop. The two
guards that replaced the cage: a post-shop GENERATE asks first and
auto-snapshots the fallback, and the coverage banner (app/lib/coverage.js
`perishableCoverage`) names every bought perishable with no meal before it
dies, re-derived on every plan change. Old devices still writing `locked`
merge harmlessly; nothing reads it.

## Shopping list — `shopping.json`

Derived (aggregate week's ingredients → merge duplicates → subtract pantry
`onHand` staples → group by section). Check-state and manual items persist.
The list is a to-do, not a record of what you own: applying a scanned receipt
(`applyReceiptStock`) ticks every row the till confirms and then runs the
Just-Bought path, so those rows LEAVE the list and land in the pantry. Rows
ticked in the aisle that the scan never read leave too — a missed OCR line
must not resurrect food already in the bag. A fully-bought list ends empty.
Displayed `qty`/`unit` are rounded up to a purchasable amount (whole counts,
sensible gram/ml/kg/L/cup/tbsp/tsp/lb/oz steps) after summing, not before.
STORED quantities stay metric and authoritative; the List and FAMILY tabs
display a store-shelf conversion on top ("1.98 lb (900 g)") via
`toStoreUnits`/`formatStoreQty` in app/lib/shopping.js — a faithful convert
of the already-purchasable metric value, never re-rounded onto an imperial
grid (which would make the two numbers disagree or under-buy).

**Fridge-first trips (2026-08-01, render-time only — no schema change):**
`subtractPantryFromTrip` (app/lib/shopping.js) subtracts the household
pantry's COUNTABLE perishables from the trip actually being shopped — the
FAMILY tab's merged list (once, after summing everyone), or a solo profile's
own list. Honesty fences mirror consumeForCook: free-text pantry quantities
never fake-subtract, unit-"x" rows (manual items, running-low staples) never
reduce, stock is consumed in item order so two rows can't claim the same
pack, remainders re-round UP to purchasable. Fully-covered rows render in an
"already in the kitchen" block instead of the buy list. STORED `shopping.json`
files are never rewritten by this pass (the receipt path below is the one
deliberate cross-profile list write) — that is what makes the render pass
safe for four devices sharing one pantry.

**The receipt ends the HOUSE's trip (2026-08-01, Tribunal-gated):** one
person shops the FAMILY tab and photographs the till roll; the scanner's
device then (1) BANKS the pantry exactly once from the MERGED household trip
— everyone's lists summed, fridge-first-reduced, so `banked === bought`
(banking from any single profile's rows was the Tribunal BLOCK: portions of
a summed row re-subtracting the same shared stock recorded ~nothing while
the real fridge filled); (2) clears till-confirmed AND aisle-ticked rows
from EVERY house profile's `shopping.json` via `clearReceiptRows` — a raw
cross-profile write, never banking (the merged bank in step 1 already
counted those rows); (3) shows an UNDO toast naming whose lists it touched.
`applyJustBought`'s fridge-first reduction is OPT-IN (`fridgeFirst`) and
only valid when the given rows ARE the rendered trip: a solo profile's list
or the merged house trip; a household member's manual ADD TO PANTRY banks
verbatim.

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
      "weekQty": 0, // ? FAMILY-trip narrowed tick (2026-08-09): when a
      //   day-narrowed household tick buys LESS than this row's week total,
      //   qty becomes the bought amount (so the receipt banks the truth) and
      //   the week total is stashed here; the untick restores it. Absent on
      //   every normally-built row; dropped at the next regeneration.
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
    // ? the floor week generation ENFORCES. Written wins over any formula
    //   (a written 1400 stays hand-set); absent = max(1200, calories - 200), the
    //   same derivation the questionnaire writes. Never a ratio of target —
    //   the generator enforced 0.95 x target until 2026-08-10, holding David
    //   to 199.5 g against his written 185. See targets.js enforcedFloors.
    "protein": 175, // grams (David's ratified 2026-08-18 numbers: 175 target,
    //   155 floor, set from GOAL weight per the nutrition council; the old
    //   210/185 pair is retired and must not reappear in fixtures)
    "proteinFloor": 155, // ? as caloriesFloor; absent = max(0, protein - 25)
    "caloriesCeiling": 3900,
    // ? OPTIONAL, rarely set. Above this the trim pass shaves servings back
    //   (never through a floor). Absent = 1.05 x calories. Unlike the floors
    //   this stays a ratio by design: a floor is a number the person agreed
    //   to, a ceiling is the generator's own slack for its top-up passes.
    "fat": 100, // ? grams
    "carbs": 525, // ? grams
    "waterLiters": 3.5, // daily target midpoint
  },
  // ? PLATE-scale engine fields (per-person-plates-design §4.5), all
  //   optional, all under macros, all DISTINCT from the day-level floors
  //   above (Tribunal: reusing those names made rung 3 fire on every plate):
  //   "plateProteinCapG": 100,   // max grams of PROTEIN (the macro) on one
  //                              // plate; ABSENT = 100, never silently off
  //   "plateCaloriesCap": 2500,  // max kcal on one plate; absent = 2500
  //   "plateCaloriesFloor": 300, // refuse-loudly floors, checked on the
  //   "plateProteinFloor": 15,   // PLATE, solved mode only; absent = OFF
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
  "avoidRecipes": ["office-lunch-box"],
  // ? recipe IDS banned outright for this profile (David 2026-08-01:
  //   "never wants to see the office lunch box again"). Exact-id filter in
  //   mergeRecipePool — unlike every other screen it ALSO removes own
  //   recipes, so the recipe vanishes from this profile's cookbook,
  //   generator, and swaps everywhere. brigadePool honors every member's
  //   list (a shared pot never serves a meal one member banned).
  //   Absent = none. Hand-edited for now; no SYS UI yet.
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
  // targetsFromQuestionnaire (app/lib/targets.js), editable later in SYS.
  "diet": "vegan", // ? enum omnivore | pescatarian | vegetarian | vegan.
  //   ABSENT = omnivore. FILTER in mergeRecipePool
  //   (app/lib/plan.js dietOf): removes bank recipes whose
  //   classification the diet doesn't admit. Own recipes exempt.
  "allergens": ["dairy", "gluten"], // ? preset ids the gate chips expand into
  //   avoidIngredients; kept so SYS re-renders the chips. Preset
  //   ids: nuts | peanuts | gluten | dairy | eggs | soy |
  //   shellfish | fish | sesame (ALLERGEN_TERMS in targets.js).
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
  "stores": ["Mariano's", "Aldi"], // ? string array of store names. The FIRST
  //   entry, slugified, is the default store the List view prices against
  //   (main.js -> ShoppingView storeSlug); the shopper can override per trip.
  "weeklyBudgetUsd": 100, // ? the weekly grocery number (P5, PF.3 spend leg).
  //   The trip tile shows the trip total, the EATEN-THIS-WEEK share (itemCost
  //   `eaten` — P5's stocking rule: whole packages are the trip, the consumed
  //   share is what the budget answers to), and over/under of eaten vs this.
  //   Absent = no budget line. Swap-to-fit generation is still Tier 7.11
  //   work; per David's 2026-08-18 ruling budget is a PROFILE option.
  "body": { "sex": "m", "age": 20, "heightIn": 73, "weightLb": 196, "activity": 3 },
  //   ? the stats the 7.12 soft sanity gate computes maintenance from
  //   (Mifflin-St Jeor × activity 1-5). Absent = the gate reports
  //   "unchecked" and stays quiet — it never guesses.
  "targetReason": "gain phase: council-verified surplus", // ? the written
  //   reason an out-of-band calorie target is deliberate (doctor's guidance,
  //   named protocol). With it, the gate is quiet; without it, an
  //   out-of-band target gets a loud planner advisory. NEVER a hard block.
  "currencies": [ // ? P5's other balances (7.11, 2026-08-19): value with its
    //   own rules and clock. Marginal-cost utilization: expiring/prepaid
    //   value spends before cash.
    {
      "id": "swipes",
      "name": "Dining swipes",
      "unit": "swipe",
      "perWeek": 14, // replenishes weekly; use-or-lose
      "expires": "weekly", // weekly | date:<iso> | never
      "venue": "buffet", // ? buffet = all-you-can-eat: a slot this covers
      //   ABSORBS the expensive macros (buffetMacroEstimate: protein x1.5,
      //   calories x1.15 vs pool average) so the grocery list buys less of
      //   the costliest thing it prices — David's swipe-protein arbitrage,
      //   generalized. Absent venue = a plain prepaid balance.
      "toGo": true // ? redeemable as a takeout container instead of eating
      //   in (a box of chicken breasts IS pantry stock). v1 records the
      //   field; the swipe→pantry flow is open 7.11 work.
    }
  ],
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
    // ? PER-DAY serving targets over foodGroups keys. Started as Greger's
    //   published Daily Dozen; per the 2026-08-18 nutrition council this is
    //   per-profile PREFERENCE DATA, decided per person against their
    //   calories, NEVER cloned between profiles (all four profiles carried
    //   a byte-identical copy until 2026-08-18). Groups absent from this
    //   record are silently skipped by the generator, so a trimmed record
    //   is the supported way to soften the philosophy.
    //   "beverages" is RETIRED (2026-08-18): it is a hydration habit, not a
    //   recipe-selection variable, and the bank supplies ~5 servings total
    //   against a 35/week target, so the key produced a permanently
    //   unsatisfiable gap warning. Hydration lives in tracks: "water".
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
  },
  "lastReviewed": "2026-08-18",
  // ? ISO date a human last audited this file's numbers against the current
  //   ratified targets. Added 2026-08-18 after the stale-210/185 finding:
  //   a floor is trusted, so a stale floor is worse than a stale bonus. The
  //   generation manifest is expected to surface this date per profile.
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

## Fitness — `fitness/workouts.json` (LEFT FOR ANVIL 2026-08-18)

> Kept here as the format of record while the file still lives in this repo.
> Mise reads and writes nothing in it.


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
      "batched": ["chicken-bulgogi-bowl"], // ? recipe ids whose batch component
      //   was ticked ✓ DONE on the Cook tab's batch block TODAY (honest-state:
      //   batching is confirmed by the tap, never assumed)
    },
  ],
}
```

`dozen`'s keys are a subset of `fitness/targets.json`'s `dailyDozen` keys. LEGACY as of
2026-08-09: the in-app daily check-in (weight/sleep/water/supplements/dozen check-offs)
retired — David's personal tracking lives in Crystal now, and Mise relies on the recipes
being good (`generateWeek` still closes food-group gaps via `foodGroupGaps`). Old fields
stay readable; the vitals ingest still writes sleep/weight from the watch export, the
Cook tab's batch block writes `batched`, the buffer counter writes `buffer`, and **since
PF.1 (2026-08-18) the Plan tab's WEIGH-IN tile writes `weight` again** — it is the
manifest's calibration signal (weightTrend) and had NO write path from the check-in's
retirement until PF.1. Absent `dozen` or absent key = 0 logged, not missing data.

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

## Occasions — `occasions.json`

Dated overrides: days the week generator must NOT plan. A medical prep, a
holiday, travel, a race. Written by the Occasions screen (Settings ->
Occasions), which is the whole point of the file: a new _kind_ of situation
used to require new code, and now it is data anyone can create in the app.

Cross-profile like `plans/` and `shopping.json`: one person can set a
medical prep up for another on their own phone, so the writer uses
`{ raw: true }` and the path of the occasion's OWNER, not the signed-in
profile.

```jsonc
{
  "occasions": [
    {
      "id": "colonoscopy-2026-03-15-p2", // example values throughout
      // deterministic from preset + anchor + person, so applying the same
      // occasion twice from two devices merges to ONE, never two
      "name": "Colonoscopy prep",
      "emoji": "⚕",
      "presetId": "colonoscopy", // ? which hand-written preset it came from
      "profileId": "p2", // whose days these are
      "from": "2026-03-12", // first owned date (derived, not authored)
      "to": "2026-03-16", // last owned date
      "anchor": "2026-03-15", // ? the date the person actually knows
      "disclaimer": "This is the standard protocol...",
      // ? copied from the preset at creation, so an occasion already applied
      //   keeps the wording it was accepted under even if the preset changes
      "offTables": true,
      // seats come off every shared table on these dates. Default true: a
      // seat somebody cannot eat still sizes the pot and still lands on
      // somebody's shopping list.
      "createdAt": "2026-08-10T16:04:00Z", // ?
      "days": {
        "2026-08-13": {
          "label": "Clear liquids only",
          "note": "Nothing solid, all day...", // ? shown on the day
          "items": [
            { "slot": "breakfast", "recipeId": "clear-broth-mug", "servings": 1 },
            {
              "slot": "snack",
              "freeText": "Bowel prep solution - timing and dose per your letter",
              "note": "Cold, through a straw...", // ? per-item instruction
            },
          ],
        },
      },
    },
  ],
}
```

**How an occasion reaches the plan.** `applyOccasion` REPLACES every entry on
an owned date with the occasion's script (a low-residue day with yesterday's
lentil soup still on it is not a low-residue day) and writes each entry with
`pinned: true`, `occasion: <id>`, `occasionName`, and an optional
`occasionNote`. Entry ids are deterministic (`occ-<occasionId>-<date>-<slot>-<i>`)
so a two-device merge sees one entry, not two. An occasion spanning two ISO
weeks patches BOTH plan files.

**How the generator sees it.** `generateWeek` reads `entry.occasion` off the
plan and HOLDS those dates: they are set aside untouched, exactly like a day
already eaten. No committee fills them, no macro top-up, no Daily Dozen floor
pass, no ceiling trim, and no shortfall line about them. The held days are
named in `report.occasionDays` so the hand-off is stated, never silent.
Without the hold, the top-up pass would stack four snacks onto a clear-liquid
prep day chasing a 1400 kcal floor, which is exactly the failure the occasion
exists to prevent.

**The food.** Occasion presets place recipes tagged `occasion-only`, which
`generatorEligible` fences out of every automatic pick permanently. Unlike
`ai-special` there is no `promoted` escape: apple juice does not become a good
Tuesday snack once somebody audits it. Those recipes also declare ZERO across
every Daily Dozen food group, honestly, so no floor pass can reach for them.

**Safety.** Presets are hand-written in `app/lib/occasions.js`, versioned and
reviewed. They are never model-generated and never model-edited (council
2026-08-07: allergy and safety intents are never model-writable). Medical
presets carry a `disclaimer` the UI shows with an explicit acknowledgement
before it will apply, and the draft's food is screened against the OCCASION
OWNER's `diet`/`avoidIngredients`/`avoidRecipes` — not the device owner's,
whose allergens filtered the picker. A conflict blocks APPLY with no override.

## Meta — `meta.json`

```jsonc
{
  "schemaVersion": 1, // bump on breaking schema change
  "lastWrite": { "device": "iphone", "at": "2026-07-06T18:20:11Z" }, // ? debugging aid
}
```
