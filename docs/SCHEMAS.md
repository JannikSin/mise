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
pantry.json               LEGACY root pantry (read as fallback ONLY for the
                          undeclared "home" household — see Pantry seeding) —
                          the live pantry is households/<h>/pantry.json: one
                          items array + derived legacy write mirrors (see Pantry)
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

**Pantry seeding across households** (2026-08-26): a household with no
`households/<h>/pantry.json` yet starts EMPTY. The legacy root `pantry.json`
is copied in only when the active profile's household resolves to `"home"`
(`LEGACY_PANTRY_HOUSEHOLD` in `app/lib/shopping.js`), which is what a pre-B2
profile with no `household` field resolves to and therefore the only kitchen
that file ever described. Before this, ANY empty household inherited it, so
declaring a new household silently furnished it with someone else's shelves:
David's Wayne house opened holding 52 staples at "plenty" that were never in
it, and the shopping list refused to buy them because the pantry said it had
them. A DECLARED HOUSEHOLD IS A NEW KITCHEN. Scan it in (List → PANTRY →
FRESH START); do not expect it to arrive stocked.

**Combined household shopping list**: a read-time merge of every profile's
`shopping.json` (`app/lib/shopping.js` `mergeProfileLists`) shown as the
HOUSEHOLD tab in List (named EVERYONE before 2026-07-25, FAMILY until 2026-08-26; docs and code now both say HOUSEHOLD, because the tab merges a HOUSEHOLD and a household is not always a family — David's Wayne-house roommate is not kin). No third file exists; ticking a combined item writes
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
  trip: the List view's HOUSEHOLD tab merges only profiles that share the
  active profile's household (`app/lib/shopping.js` `householdOthers`, wired
  in `app/main.js`). A profile alone in its household (e.g. Laurie in her own
  apartment) sees no HOUSEHOLD tab at all; absent-field profiles keep merging
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
{ price, size, estimate?, at?, regular?, sale? } } }` with `updated`,
`region`, `stores` at the top. `estimate: true` = derived/recent estimate,
absent = tracker-confirmed shelf price. `sale: true` (2026-08-19, David's
"can you find sales" ask) = `price` is the Kroger promo/card price and
`regular` carries the non-sale price beside it; the next refresh clears
both when the sale ends. `at` (Tier 3.5, 2026-08-19) = ISO date this
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

## Equipment — `recipe.equipment[]` and `targets.equipment[]`

**Added 2026-08-22 (David: "you can't tell me to make something for equipment
that I don't have").** `weekbuilder.js` has excluded recipes a profile lacks
gear for since survey-v2, but **not one of the 126 bank recipes declared any
equipment**, so `r.equipment ?? []` was empty every time and the filter
excluded nothing, forever. A working filter over data nobody wrote.

- **`recipe.equipment: string[]`** — capabilities the recipe REQUIRES. Never a
  brand, never a specific pan. Backfilled across all 126 from each recipe's own
  instruction text; 33 no-cook plates correctly declare nothing.
- **`targets.equipment: string[]`** — what a kitchen HAS.
  ⚠️ **ABSENT and EMPTY are different and the difference is load-bearing.**
  Absent means undeclared, so everything is offered and nobody's week changes
  until they say. `[]` means a kitchen with nothing in it. Collapsing them
  silently empties someone's week.
- **Vocabulary and substitution live in `app/lib/equipment.js`.** Owning a
  Dutch oven satisfies `pot` and `saucepan`; a pot satisfies a saucepan but
  never the reverse, because volume is the point; a wok satisfies a skillet; a
  toaster oven satisfies an oven. An air fryer deliberately does NOT satisfy an
  oven, being the substitution most likely to end with a sheet pan that does
  not fit. `worker/src/lib.js` carries its own copy of the id list because it
  cannot import from `app/`, and `tests/equipment.test.js` fails if the two
  drift.
- **In the app:** SYS → Your kitchen. Tick what you own and it shows how many
  recipes and dinners are cookable, warns when no dinner is, and prints what
  one more item would unlock. Measured on the live bank: undeclared 126/126,
  microwave only 35/126 with **0 dinners**, a realistic dorm 104/126, adding an
  oven +9.

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
        // ---- the store's own answer, kept (2026-08-22) ----
        // `trimProduct` has always returned these three on every lookup, free,
        // under the scope we already hold. Until 2026-08-22 `setPin` dropped
        // all of them, so Mise asked Pay Less where things were, was told, and
        // sorted by a hardcoded taxonomy identical for every store on earth.
        // ALL THREE ARE OPTIONAL: absent means Kroger did not say, which is
        // common, so every reader must carry a fallback. Never written as "".
        "aisle": "AISLE 12", // PER STORE, which is why it lives on the pin and
        // not on the catalogue row. Feeds aisleLabelsFromPins(), which derives
        // a store's section→aisle walk map as the MODAL aisle of that
        // section's pins, and declines to label a section whose pins disagree.
        "brand": "Heritage Farm",
        "categories": ["Meat", "Chicken"], // capped at 6
        "seenAt": "2026-08-22", // when this store data was last OBSERVED. A
        // store reset moves aisles, so an aisle is only as good as its date.
        // Set by setPin, by confirmPin (a human stood in front of it), and by
        // refreshPinFacts on every weekly refresh.
        "confirmedAt": "2026-08-19", // ? the confirm-once tap happened
        "provisional": true, // ? auto-picked (seed / re-pin), awaiting the tap;
        // renders a ? button on the row. confirmPin swaps it for confirmedAt.
      },
    },
  },
  "misses": {
    // NEGATIVE cache (repricer.js, 2026-08-30): plentyKey(food) → store →
    // dateIso (plentyKey, not pinKey: it is the key the repricer dedupes
    // search slots by, so banana/bananas share one miss entry) of the
    // last live search whose PRODUCTS came back empty — the store genuinely
    // carries nothing under this name. The build-time repricer skips a missed
    // food for 30 days (MISS_EXPIRY_DAYS), then it becomes eligible again;
    // recordMiss prunes expired entries on every write. Products that came
    // back but were all gated out (stock-out, red list, allergen, sizeless
    // pack) record NOTHING — a stock-out ends by Thursday (Red Team,
    // 2026-08-30) — and a search that THREW (network, 429) also records
    // nothing: failure to ask is not an answer. This is NOT the redList,
    // which is a brand filter on candidates.
    "fresh-dill": { "pay-less": "2026-08-30" },
  },
}
```

**The build-time repricer (`app/lib/repricer.js`, 2026-08-30).** BUILD prices
its own list, fire-and-forget after the list saves: stale/unpriced pinned
rows re-price by UPC (chunks of ≤40, at most 3 calls), then a budget of 12
live searches goes to the most expensive still-unpriced pinless rows, cheapest
left for the next build. Budget arithmetic: 3×2 + 12×1 = 18 of the worker's
30 rate units per 10 minutes, leaving headroom for human taps. The worker's
`/kroger/byId` echoes `requested` (how many UPCs it processed after its
60-cap) so a truncated batch is reported, never silently dropped. One pins
save + one prices save per run, only when something changed — and when the
live books moved while the run was in flight (a $? tap, a confirmed pin, a
receipt), the run's ops replay onto the live books via `reapplyOps`, which
skips any food+store a human touched: the user's write always wins.
Auto-picked pins stay `provisional`; the price tile's "N auto-picked ·
REVIEW" line walks them through the existing confirm sheet, auto-advancing
to the next on each confirm (the per-row `?` button is retired).

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

**Store-facts backfill (2026-08-22).** The weekly REFRESH already holds a
fresh product for every pinned UPC and used to spend it on price alone, so a
pin made before this date could never gain an aisle and `size`/`brand` on an
old pin stayed frozen forever. `refreshPinFacts` now runs on every refreshed
product and costs nothing, because the payload is already in hand. It updates
only what the STORE says (description, size, soldBy, aisle, brand, categories,
seenAt) and never touches `upc`, `confirmedAt` or `provisional`, which are
identity and what a human decided. Re-pinning to a different product remains
`setPin`'s job and still requires a person. It also runs when the price is
missing, because knowing where a thing sits is useful without a price.

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
  // ? THE PLATING TAG, and mind the name collision above: `effort:
  //   "assembly"` is about how long the dish takes, `assembly: "plated"` is
  //   about whether it can be portioned per person. They are unrelated.
  //
  //   "plated" means: at serving time the protein and the starch are still
  //   in separate pans, so a cook can put more protein and less rice on one
  //   plate and the reverse on another without re-cooking anything. That is
  //   the only thing that makes synth.js's per-seat instruction executable —
  //   "300 g of the chicken" is not an instruction you can follow when the
  //   chicken is suspended in a curry.
  //
  //   ABSENT is the default and means mixed: one pot, one ladle, everybody
  //   gets a share of the pan. The tag IS the rollout mechanism (council
  //   2026-08-12), so an untagged recipe behaves exactly as it did before
  //   the engine existed, bit for bit. Untag to roll back.
  //
  //   A tagged recipe MUST have every non-flavor ingredient row priced in
  //   synth.js's MACRO and PLATE_GRAMS tables, or the whole recipe fails
  //   closed to "this dish is one thing nutritionally". tests/promises.test.js
  //   (P8) checks that for every tagged recipe on every run.
  "assembly": "plated", // ? plated | absent (= mixed)
  "portable": true, // ? survives hours in a backpack: no fridge, no cooking,
  //   no fork required (spec 2026-08-25). ABSENT = not portable. Read by
  //   generateWeek's snack pool when a profile declares
  //   `targets.snackPortable: true` — that profile's auto-planned snacks
  //   (floor pass, macro top-up, weekly buffer, trim swaps) come only from
  //   flagged recipes, honest-relaxed to the full pool if zero carry it.
  //   Meaningful on mealType "snack"; harmless elsewhere.
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
  // P12, added 2026-08-19 (session koenig). REQUIRED on every bank recipe,
  // and `null` is a legal, meaningful value: "never audited", said plainly.
  // What is NOT legal is the field being absent, because that is the state
  // the promise rotted in — "every recipe in the bank is audited" could be
  // neither confirmed nor refuted, and an unfalsifiable promise reads as a
  // passing one.
  //
  // There is deliberately NO separate `philosophy` field. `audited.standard`
  // IS the philosophy claim, and it cannot be made without citing evidence.
  // Two fields would let an unaudited recipe declare a voice it was never
  // checked against, which reopens exactly the loophole this closes.
  //
  // `evidence` must be a real quote from this recipe's own record, so any
  // claim here can be checked by a person in ten seconds. tests/promises.test.js
  // fails the build on an audit block with no evidence.
  //
  // AND THE FIELD IS NOW LEVERAGE, not just a label (2026-08-19): an
  // annotator import (`ai-special` / `hbp-annotated`) is fenced out of
  // GENERATE until it carries BOTH `promoted: true` AND an audit block.
  // Canon P12 always said "promoted into the bank only through this audit";
  // until today the flag alone was the whole gate.
  //
  // `standard` names the REVIEWING VOICE, never a claim about the dish. A
  // beef kofta audited by the Greger review carries standard "greger": it
  // means the review happened and its finding is recorded, not that the
  // recipe is plant-based. Whether the bank should hold more than one
  // nutrition philosophy is the pending council's question, and nobody
  // invents a second standard before it sits.
  "audited": {
    "standard": "greger", // greger | clinical (nutrition voice, or a medical constraint)
    "on": "2026-08-19",
    "by": "greger-agent, recorded in this recipe's own lessons",
    "evidence": "Greger pass 1: swapped batch rice to brown.",
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
      "group": "produce", // aisle, for grouping (aisleOf). DERIVED ON READ,
      // never authoritative — see "The aisle is derived" below.
    },
  ],
  "staples": [], // derived write mirror (see above) — do not hand-edit
  "perishables": [], // derived write mirror — do not hand-edit
}
```

**The aisle is derived, not stored (2026-08-27).** An undated staple carries it
as `section`, a dated row as `group`; both are recomputed from the food name by
`aisleOf` on every read (`healItem`), exactly as `normalizeShoppingList` has
recomputed its `section` since the aisle list widened. They used to be written
once at scan time and kept forever behind `?? aisleOf(...)`, which meant a fix
to the taxonomy could never reach a row that was already wrong and rescanning
the shelf was the only cure. **Nothing is lost, because no screen lets a person
set a row's aisle by hand: `aisleOf` is the only author.** `normalizePantry`'s
settled check counts the aisle as part of mirror consistency, so a file whose
stored aisles disagree with the current taxonomy is repacked rather than passed
through by reference.

David's first Wayne camera scan (2026-08-26) is why: `cayenne pepper` filed
under PRODUCE because the produce rule claimed `pepper` before the spices rule
could see `cayenne`; `almond butter` filed under DAIRY on `butter`; and
`bananas`, `lemons` and `pumpkin seeds` filed under OTHER because every keyword
in the taxonomy was singular inside a word boundary while a camera writes what
the label says, and labels are plural. The rules are ordered specific-before-
general and each fix names the food that broke it.

**Fresh start (2026-08-01, no schema change):** the PANTRY tab's START FRESH
wizard empties the whole file (staples included, behind the same confirm as
EMPTY EVERYTHING) then walks fridge → freezer → pantry shelves → spice
cabinet with the camera. Wizard scans run in "add" mode —
`applyScanItems(pantry, items, today, location)` places new perishables on
the step's shelf ADDITIVELY, because a wiped kitchen needs several photos
per shelf and a second fridge photo must extend the first, not replace it.
Non-wizard shelf scans keep sweep-replace semantics unchanged.

## Household — `households/<household>/household.json` (P6, 2026-08-19)

The kitchen itself, as opposed to the people in it. Added session koenig; no
such file existed before, which is why a week could be generated that does not
physically fit the fridge it will live in, why two people sharing one oven each
declared it privately, and why moving out on a known date looked exactly like
living somewhere forever.

**Every field is optional and every absence is a working state.** A household
that has declared nothing behaves exactly as the app did before this file
existed. That is the only way to add a model to an app people are already using.

```jsonc
{
  "headId": "david",          // who assigns roles. Absent = nobody yet, and the
                              // first writer becomes it (refusing everybody
                              // would make the file unreachable)
  "members": [
    { "id": "david", "roles": ["cook", "shopper"] },
    { "id": "roommate", "roles": ["eater"] }      // roles: cook | shopper | eater
  ],
  "equipment": ["oven", "freezer", "blender"],    // absent = has everything,
                                                  // same meaning as the
                                                  // per-profile field
  "capacityL": {              // LITRES, as the appliance is sold
    "fridge": 120,
    "freezer": 40,
    "pantry": 90
  },
  "occupancy": {
    "from": "2026-08-24",
    "until": "2026-12-19"     // THE DRAIN-DOWN TARGET. Perishables must reach
                              // zero by this date, so a food's real deadline is
                              // the earlier of its own date and this one, and
                              // days past it are not planned. Absent = a
                              // permanent home, never pushed to eat its stock.
  }
}
```

**Capacity is checked against a stated assumption, not a measured one.**
Refrigerated food is mostly water, so grams convert to millilitres closely
enough to be useful; what is not close enough is pretending a fridge packs
solid. `PACKING_EFFICIENCY` in `app/lib/household.js` is 0.55, it is a named
constant rather than a magic number, and the first week that overflows a fridge
it said would fit should move it.

**Capacity REPORTS, it never refuses.** A person whose fridge is genuinely too
small needs to know before they shop, not to be told their week is illegal.

**Trip cadence deliberately stays on `targets.shopsPerWeek`**, where it already
worked before this file existed. Moving it for tidiness would be churn.

---

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
      //   jobs. Set/cleared via setTableBuyer (clearing removes the field).
      //   Must be an in-house profile or the claim is inert at derive time.
      //   Survives brigade regeneration like a seat's skip.
      //   THE EFFECTIVE BUYER (effectiveBuyerOf, 2026-08-30): an explicit
      //   in-house buyerId always wins; absent one, a BRIGADE table
      //   (fromBrigade) is bought by its NAMED cook — t.cookId, seated, not
      //   skipped, in this household — because a standing arrangement where
      //   the cook shops their own nights must not need 28 manual claims a
      //   month. Never a positional/seat-order fallback (reordering seats
      //   must not move a buy). For every other table ABSENT = unclaimed:
      //   the batch rides NOBODY's shopping list, never added automatically.
      //   The money ledger's payer is the buyer, falling back to the cook
      //   for unclaimed tables. The claim-all button skips fromBrigade
      //   tables for the same reason.
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
- THE GUESTHOUSE (2026-08-29 plenum, David's named yes on the spec's two
  gates): a guest profile is an ordinary profiles.json entry with
  `household: "guesthouse"` plus a normal `profiles/<id>/profile/
  targets.json`, created by the guest themselves on the host's phone at
  `#/guest` (the profile gate's questionnaire in guest mode). Guesthouse
  members are seatable at any house's table (labeled, after housemates),
  their targets size their tailored plates, their share hits the list and
  the per-seat pot; cook/buyer stay in-house (`cookOf` unchanged). A
  guesthouse profile is NEVER a sign-in identity: the gate's picker
  refuses them, so guests share nothing with each other and see nothing.
  The anonymous ➕ GUEST PLATE walk-in path survives unchanged with
  GUEST_TARGETS. Invite-by-link (remote onboarding + guest status page via
  Worker KV) is specced, NOT built: new unauthenticated write surface,
  full review pass first — owner: next Mise session, by 2026-09-04.
- SCAN MY PLATE (Hall screen, Worker `/hallplate`, 2026-08-29 plenum): a
  photo of the actual tray at a dining court plus that meal's published
  items -> matched items with portion counts. The model only identifies
  and counts portions in multiples of each item's own stated serving; every
  matched macro is computed server-side from Purdue's published numbers
  (`validateHallPlate`), never taken from the model. Unmatched food comes
  back as clamped `extras`. The result is composeTray-shaped, so LOG THIS
  rides the existing hall-tray plan write unchanged (P1, P10).
- THE WEEK IS COMPOSED, NOT ASKED FOR (2026-08-30, session monolith; this
  replaces the retired Worker `/dinnerweek` AI week run of 2026-08-09). The
  brigade card's SET THIS WEEK runs `planBrigadeWeek` (`app/lib/compose.js`):
  deterministic, offline, no model in the loop. Per slot, candidates come
  from `brigadePool` (every member's screens intersected + the one
  `autoPlanEligible` fence + `slotAvoid` + grab-and-go + portable-snack);
  the FNV rotation names each day's START pick, and the day composer then
  solves every seated member's servings JOINTLY so each person's day lands
  inside their own remaining calorie band ([target, target+100] after
  covered credit) and protein band ([floor, ceiling], pulled toward aim),
  swapping candidates fresh-before-repeat when the start picks cannot land.
  Acceptance is GRADUATED: a seat that cannot reach target degrades to its
  own calorie floor with the shortfall NAMED in the per-seat `report`
  (statuses: band | floor | miss | over | no-targets); a whole-day refusal
  does not exist. Covered credit is per member per DATE (`memberCoverage`):
  their own plan's pinned/OUT entries (which also take that seat off the
  slot's pot, written `status: "skipped", auto: true` — machine skips are
  recomputed every run, human declines carry), presumed dining swipes at
  the currency's stated tray, and fixed slots ONLY where they pass that
  member's own screens. A seat's `edited: true` servings (stamped by
  patchSeat, never inferred) bind the solve while the dish is unchanged.
  THE SHADOW SWEEP: upcoming tables the retired AI run wrote
  (`fromWeekRun: true`, or the pre-stamp "Family <slot>" naming) at the
  brigade's own date+slots are cleared before composing — a standing
  brigade owns its span; hand-set tables survive and still outrank at
  derivation. The runner's swipes are seeded pinned into their own plan
  (`planSwipes`) and reported (`swiped`); housemates' swipes are ASSUMED
  and reported (`assumed`) — their plans are theirs alone to write.
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
      "salt": 2, // ? the re-roll counter. PICK DIFFERENT MEALS bumps it and
      //   stores it HERE so every device reshuffles identically: the week
      //   engine is deterministic (same inputs, same week), so a re-roll
      //   must change an input or the button returns the identical seven
      //   days. Absent = 0.
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
  //   2026-08-19 (7.11, P5): subsystems.away added — { slots, swipeSlots,
  //   creditCalories, creditProtein, cookedNeedRatio, fullNeedRatio }. The
  //   generator aims the cooked week's protein density at the REMAINING need
  //   after away/swipe credits (the swipe arbitrage), and this line proves it
  //   on every generate. cookedNeedRatio null = manifest backfilled from a
  //   stored plan; only a real GENERATE re-aims the committees.
  "entries": [
    {
      "id": "b3e29f01", // unique in the file; merge key
      "date": "2026-07-06",
      "slot": "dinner", // breakfast | lunch | dinner | smoothie | snack
      "recipeId": "chicken-bulgogi-bowl", // exactly one of recipeId | freeText
      "freeText": "leftovers", // e.g. "leftovers", "eating out"
      "servings": 2,
      "pinned": false, // ? true = GENERATE WEEK must never clear or overwrite this entry
      "fixed": true, // ? written by GENERATE for a targets.fixedSlots slot
      //   (spec 2026-08-25): the profile's declared every-day recipe at 1
      //   serving. UNLIKE pinned it does not survive a regenerate (a profile
      //   that drops fixedSlots gets committees back on the next GENERATE),
      //   but every swap surface honours it: the engine's trim/top-up
      //   passes, budget swapToFit, and shopping substitutionPlan all leave
      //   a fixed entry alone. Absent = normal entry.
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
stand-by (per the 2026-07-20 Greger consult: batchable snacks only,
phase-keyed calorie band, protein-dense). Chosen by GENERATE WEEK
(deterministic, re-rolls with the salt), its batch (`portions` servings) is
added to the derived shopping list like a planned entry. Portions eaten are
tallied per day on the Cook view into `fitness/daily.json` day rows as a
`buffer` count (a plain number, absent = 0) — display-only, it never feeds
plan `dayTotals`. Default `portions` = one per live day. Under
`targets.snackStyle: "weekly"` the buffer pick is ALSO the only snack the
passes may plan, and `portions` = the sum over live days of max(1, that
day's planned snack servings), so the Sunday batch covers both the planned
portions and a stand-by for every other day.

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
STORED quantities stay metric and authoritative; the List and HOUSEHOLD tabs
display a store-shelf conversion on top ("1.98 lb (900 g)") via
`toStoreUnits`/`formatStoreQty` in app/lib/shopping.js — a faithful convert
of the already-purchasable metric value, never re-rounded onto an imperial
grid (which would make the two numbers disagree or under-buy).

**Fridge-first trips (2026-08-01, render-time only — no schema change):**
`subtractPantryFromTrip` (app/lib/shopping.js) subtracts the household
pantry's COUNTABLE perishables from the trip actually being shopped — the
HOUSEHOLD tab's merged list (once, after summing everyone), or a solo profile's
own list. Honesty fences mirror consumeForCook: free-text pantry quantities
never fake-subtract, unit-"x" rows (manual items, running-low staples) never
reduce, stock is consumed in item order so two rows can't claim the same
pack, remainders re-round UP to purchasable. Fully-covered rows render in an
"already in the kitchen" block instead of the buy list. STORED `shopping.json`
files are never rewritten by this pass (the receipt path below is the one
deliberate cross-profile list write) — that is what makes the render pass
safe for four devices sharing one pantry.

**The receipt ends the HOUSE's trip (2026-08-01, Tribunal-gated):** one
person shops the HOUSEHOLD tab and photographs the till roll; the scanner's
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
      "weekQty": 0, // ? HOUSEHOLD-trip narrowed tick (2026-08-09): when a
      //   day-narrowed household tick buys LESS than this row's week total,
      //   qty becomes the bought amount (so the receipt banks the truth) and
      //   the week total is stashed here; the untick restores it. Absent on
      //   every normally-built row; dropped at the next regeneration.
    },
  ],
}
```

## Food profile — `profile/targets.json` (was `fitness/targets.json`)

**Renamed 2026-08-22 (David).** Mise and Anvil are separate apps, and
everything in this file is Mise's: macros, the calorie floor and ceiling, the
protein band, phase, meal slots, food groups, avoided ingredients, the weekly
budget. It sat under `fitness/` only because it predates the split.

**Both paths are live, on purpose.**

| | path | who writes it |
|---|---|---|
| canonical | `profile/targets.json` | Mise, via `writeTargetsOf` |
| mirror | `fitness/targets.json` | Mise, same call, same object |

- **Reads** (`readTargetsOf`) try the canonical path and fall back to the
  legacy one, so a profile that has not been migrated behaves exactly as it
  did before. Never read either path directly; the fallback is the point.
- **Writes** (`writeTargetsOf`) write both. Mise is the ONLY writer of either
  — Anvil throws `refusing to write ${path}: owned by Mise` — so the mirror
  cannot drift.
- **The mirror exists for Anvil**, which reads `fitness/targets.json` as its
  calorie and protein spine (`anvil/app/lib/github.js`, `MISE_TARGETS`).
  ⚠️ **Deleting `fitness/targets.json` before Anvil is repointed breaks
  Anvil.** Removing the mirror is a coordinated two-repo change, not a
  cleanup.

`fitness/daily.json` is NOT part of this rename. Both apps write that file
deliberately, through one sha-and-merge path with field-wise resolution.
That is designed sharing, not leftover mixing.

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
    "protein": 190, // grams. THE FLOOR (proteinFloor is deleted; council
    //   2026-08-19 "protein IS the floor", value raised to 190 on David's
    //   yes 2026-08-26). The retired tokens 210, 185, 175 and 155 must not
    //   reappear in fixtures or docs as current values.
    "proteinFloor": 155, // ? LEGACY, deleted on David's profile. When absent
    //   the floor IS `protein` itself (targets.js enforcedFloors; the old
    //   `protein - 25` derivation silently defeated the 08-19 verdict and
    //   is gone). Write it only to place a soft floor BENEATH the number.
    "caloriesCeiling": 3900,
    // ? OPTIONAL, rarely set. Above this the trim pass shaves servings back
    //   (never through a floor). Absent = 1.05 x calories. Unlike the floors
    //   this stays a ratio by design: a floor is a number the person agreed
    //   to, a ceiling is the generator's own slack for its top-up passes.
    //   THE DAY COMPOSER (compose.js, 2026-08-30) additionally DERIVES a
    //   proteinCeiling of round(protein x 1.15) when none is written — four
    //   of five live profiles carry none, and an unconstrained upper band
    //   re-creates the measured 229-270 g overshoot. Derived, and said here
    //   rather than discovered; write proteinCeiling to override it. Its aim
    //   is proteinAim ?? protein. A profile with no protein number at all
    //   gets no protein optimization (the composer only optimizes numbers
    //   the person tracks).
    // "proteinAim": 215,
    //   ? council 2026-08-26: A SETPOINT AND A LIMIT MUST NEVER BE THE SAME
    //   VARIABLE. The AIM is what the protein trim converges bought grams
    //   to, clamped at the ceiling; the COMMITTEES deliberately steer
    //   density by the FLOOR, not the aim (documented council deviation:
    //   aim-steering measured 224-254 g bought on cook weeks — committees
    //   deliver the floor, the trim alone converges down to the aim); the
    //   FLOOR (protein) only guards; the CEILING (proteinCeiling) is the
    //   outer money bound. ABSENT = the ceiling (else the floor; with no
    //   ceiling written the trim never runs and the manifest reports no
    //   aim). From 08-24 to 08-26 the floor doubled as the aim, which was
    //   INFEASIBLE on swipe days (94 g locked in fixed slots > 90 g
    //   spendable) and failed silently — the class of bug this field ends.
    //   The trim's give-up reports per-day residuals to the manifest
    //   (floors.trimResiduals); the residual list describes the last
    //   GENERATE, not later hand edits (avg/over-day fields recompute, the
    //   residuals do not).
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
  "phaseExit": { "onGoalWeightLb": 215, "reviewBy": "2026-12-20" },
  // ? council 2026-08-26 (Longo's granted demand): the phase ENDS and its
  //   surplus + protein architecture are RE-DECIDED (never inherited) at
  //   goal weight or the review date, whichever comes first. Informational
  //   today (no engine reads it); it exists so a phase cannot become an
  //   architecture by inertia — without it the gain phase was an 8-18 month
  //   default with no scheduled re-evaluation anywhere.
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
  "slotAvoid": { "breakfast": ["egg"] },
  // ? PER-SLOT ingredient exclusions (David 2026-08-30: "I don't want eggs
  //   in the morning" — while the egg in his dinner fried rice stays
  //   legal). Same case-insensitive substring semantics as avoidIngredients,
  //   scoped to the named slot; enforced in brigadePool (intersected across
  //   members like every other screen). Absent = none.
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
  "fixedSlots": { "breakfast": "berry-walnut-greek-yogurt-bowl" },
  // ? "this recipe, every day" per slot, DECLARED ON THE PROFILE
  //   (spec 2026-08-25: David eats the same yogurt bowl every
  //   morning by choice). NOT the office-lunch-box special case:
  //   no id lives in code, any profile can fix any slot it lists
  //   in mealSlots, and the named recipe must survive the same
  //   screens as a committee pick (diet, avoid, equipment,
  //   trust) — a fixed id the screens removed falls back to a
  //   normal committee and the manifest's fixedSlots line says
  //   so. Daily repetition bypasses the ≤2-repeat rotation by
  //   declared intent; variety comes from the recipe's own
  //   `rotation` block if it carries one. Absent = no slot fixed.
  "snackPortable": true,
  // ? every auto-planned snack (floor pass, macro top-up, weekly
  //   buffer, trim swaps) must carry `portable: true` (spec
  //   2026-08-25: "smth i can bring in my backpack"). Honest-relax:
  //   zero portable recipes = full pool + a manifest line, never a
  //   silent empty pool. Absent = no filter.
  "dinnerAnchor": true,
  // ? council 2026-08-26 (minimum-presence, an ADHERENCE rule by its own
  //   written justification, no physiological citation attached): a profile
  //   that declares it never gets an anchor-less dinner SOLO-auto-planned.
  //   The generator's dinner pool drops recipes tagged "carb-forward"
  //   (dishes whose protein was deliberately scaled out); they stay
  //   choosable by hand and as second plates. SCOPE: the solo week
  //   generator only — shared-table brigades screen through brigadePool,
  //   which (like the time cap and maxDifficulty) does not apply this
  //   filter. Honest-relax when the filter would empty the pool, said in
  //   the manifest. ABSENT = no filter.
  "snackStyle": "weekly",
  // ? enum weekly | absent. "weekly" = ONE snack recipe for the whole
  //   week (spec 2026-08-25 part 2, David: "each week can be its own
  //   snack... smth i batch prep for the week"): the buffer pick is
  //   selected FIRST and becomes the only snack candidate every pass
  //   may place, so planned snack entries and the stand-by batch are
  //   the same batch-prepped recipe; plan.buffer portions then cover
  //   max(1, planned servings) per live day. Next week's salt/overlap
  //   jitter rotates the pick. Composes with snackPortable (the pick
  //   comes from the filtered pool). ABSENT = per-day variety from
  //   the full snack pool (today's behavior for every other profile).

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
  //   GRAB-AND-GO is also a HARD screen for shared brigade breakfasts
  //   (brigadePool, 2026-08-30): when ANY member declares it, breakfast
  //   candidates must be effort "assembly" — nothing cooked at eating time.
  //   The screen keys on effort, never on tags: the pancakes carry
  //   meal-prep tags and still need a 7am griddle.
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
      // "estCalories": 1200, "estProtein": 90,
      //   ? THE STATED TRAY (2026-08-24, raised 2026-08-25): what this
      //   person says a swipe meal actually delivers. When estProtein > 0
      //   it beats the derived x1.5/x1.15 figure everywhere: the swipe
      //   placeholder's credit, AND the dining-hall composer's aim (hall.js
      //   — self-checking, the screen says so when the hall cannot reach
      //   it). GENERATE RE-STAMPS every currency placeholder from the
      //   CURRENT stated numbers (weekbuilder pinnedEntries), so raising
      //   them here reaches an already-planned week on its next generate —
      //   they froze at plan time before 2026-08-25, which left David's
      //   live week crediting a stale 550/48 against a stated 800/65.
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
The `remedy` tag (sick-day food, `remedies.js`) is fenced the same way since
2026-08-25: a BRAT plate had auto-planned itself into a well week. Remedy
recipes stay reachable by hand and through a symptom protocol, never by the
generator, with the same no-promotion rule.

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
