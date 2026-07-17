# Recipe Bank Gap Analysis and Expansion (2026-07-17)

Companion to `docs/survey-v2-design.md`. Question answered here: if the survey v2 axes go live, where does the current bank structurally fail to produce a valid week, and which recipes were added to fix it.

## Scope and counts

Analyzed: the SHARED bank at `seed-data/generated/recipes/` (72 files before this pass, 88 after). Excluded: `seed-data/generated/profiles/mom/recipes/` (58 profile-local files: loss-adjusted variants plus load-bearing shadow duplicates per SCHEMAS.md, never part of the public pool) and `fixtures/recipes/` (1 schema-exemplar test fixture).

Classification method: keyword scan over non-staple ingredient names (same approach the survey design proposes for `dietOf`). Counts are approximate to within 1-2 recipes because of substring quirks; the structural conclusions are not sensitive to that.

### Bank before expansion (72 recipes)

By meal type (generator needs per week: dinner committee 4, lunch 3, breakfast 2, smoothie 1, plus a protein-dense snack top-up pool):

| mealType | count |
|----------|-------|
| dinner | 33 |
| breakfast | 13 |
| snack | 13 |
| lunch | 8 |
| smoothie | 5 |

By effective dietary pattern (ingredient-derived):

| pattern | count |
|---------|-------|
| omnivore-only (contains meat) | 33 |
| vegetarian (dairy/egg, no meat/fish) | ~27 |
| pescatarian-only (fish, no meat) | 5 |
| fully vegan | 7 |

By cuisine: american 22, italian 7, japanese 7, chinese 6, korean 6, middle-eastern 5, french 3, mediterranean 3, other 3, moroccan 2, mexican 2, plus singletons (greek, indian, spanish, north-african, asian, tropical). By effort: assembly 31, cook 35, project 6. `phases` tags: none in the bank (everything serves every phase).

## Gap matrix: survey axes x meal slots

Cell = usable recipes in the pre-expansion bank / what the generator needs. FAIL = generation is structurally broken (committee cannot fill, or macroTopUp cannot reach protein floors), THIN = fills but with no variety (re-roll changes nothing).

| Survey answer | Dinner (need 4) | Lunch (need 3) | Breakfast (need 2) | Smoothie (need 1) | Protein snacks (need ~3) |
|---|---|---|---|---|---|
| Vegetarian | 3 / THIN | 6 / ok | 12 / ok | 5 / ok | 6 / ok |
| Vegan | 1 / FAIL | 1 / FAIL | 1 / FAIL (sick-day plate, 6 g) | 0 / FAIL | 0 over 10 g / FAIL |
| Pescatarian | 5 / THIN | 6 / ok | 12 / ok | 5 / ok | 7 / ok |
| Dairy excluded | ~14 / ok | 5 / ok | 2 / FAIL | 0 / FAIL | 2 / FAIL (onigiri 24 g, egg-drop 14 g) |
| Gluten excluded | 13 / ok | 3 / THIN | 6 / ok | 5 / ok | 10 / ok |
| Nuts excluded | ~30 / ok | 7 / ok | 12 / ok | 4 / ok | 2 over 10 g / FAIL |
| Soy excluded | ~28 / ok | 5 / ok | 12 / ok | 4 / ok | 11 / ok |
| Shellfish excluded | 31 / ok | 7 / ok | 13 / ok | 5 / ok | 12 / ok |
| Gain phase (800+ kcal mains) | 9, all animal / FAIL for vegan-gain | | 1 | | |
| 15-min weeknights (assembly dinners) | 5 / ok-THIN | | | | |

### The five structural failures, in priority order

1. **Smoothie slot, dairy-free**: all 5 smoothies defaulted to whey protein powder. Committee size for smoothie is 1, so ANY dairy exclusion (or vegan) produced an empty committee and a permanently unfilled proactive slot.
2. **Snack top-up pool, dairy-free or nut-free or vegan**: every snack over 10 g protein contained dairy AND nuts (cottage-cheese plates, almond-butter plates, energy bites). What survived an exclusion screen was 0-2 g herbal drinks plus at most onigiri/egg-drop. `macroTopUp` is the safety net for the protein floor; for these profiles the net had no strings. Days would honestly report proteinShortDays every single day.
3. **Vegan dinners**: exactly 1 (tempeh-broccoli-steam-fry) against a committee of 4. `pickCommittee` fills what it can, so a vegan week was the same tempeh pan seven days minus the two-repeat cap, i.e. two dinners and five empty slots.
4. **Vegan breakfasts and lunches**: one each, and the breakfast was the BRAT sick-day plate at 6 g protein. The lone vegan lunch (broccoli-cashew-tofu) also dies to a nut exclusion.
5. **Gain-phase density without animal products**: every 800+ kcal option was an animal-protein bowl, so a vegan gain profile could not reach a 3500+ kcal floor without absurd snack stacking.

### Real but non-structural gaps (noted, not filled this pass)

- Pescatarian dinner variety: only 2 fish dinners in the bank (plus vegetarian spillover). THIN, not broken.
- Cuisine skew: american 22 of 72; indian was a singleton (now 3), mexican 2 (now 3). Cosmetic until cuisine weighting ships.
- No `phases` tags anywhere in the bank: acceptable (untagged = serves everyone) but the gain/loss extremes rule from SCHEMAS.md is unused; only the new peanut-tempeh bowl now carries `phases:["gain"]`.
- Equipment metadata absent bank-wide: fine until survey Q16 ships; smoothies implicitly need a blender.
- Sesame is not distinguishable from nuts by the current keyword approach (tahini in hummus); flagged in the hummus recipe's lessons.
- `mergeRecipePool`'s avoid-screen counts `optional: true` ingredients (e.g. the chili's optional turkey and yogurt), over-excluding several nearly-vegan recipes. One-line fix specified in survey-v2-design.md Q10.

## Expansion: 16 recipes added

All follow the SCHEMAS.md recipe shape, pass `tests/recipe-data.test.js` (11 foodGroups keys + method, numeric servings, plant-forward invariant), and are tagged `plant-forward` + `greger-aligned` plus diet/allergen tags (`vegan`, `gluten-free`, `nut-free`, `dairy-free`) for the future tag short-circuit in `dietOf`. Nutrition and foodGroups are `method: "estimated"`. No deep frying anywhere; oil stays at roughly 1 tbsp per 2-4 servings; turmeric is paired with black pepper wherever it appears.

| Recipe | Slot | Fills gap |
|---|---|---|
| chana-masala-brown-rice | dinner | Vegan dinner committee (also GF, soy-free, nut-free: survives every screen) |
| black-bean-sweet-potato-tacos | dinner | Vegan + GF dinner; adds cruciferous via cabbage slaw; mexican cuisine depth |
| red-lentil-coconut-curry | dinner | Vegan + GF dinner; 200 g spinach targets the enforced greens floor |
| tuscan-white-bean-kale-skillet | dinner | Only vegan dinner clearing BOTH enforced daily floors (greens + cruciferous) in one pan; light enough for loss profiles |
| peanut-tempeh-brown-rice-bowl | dinner | Gain-phase vegan density (880 kcal, 44 g); tagged phases:["gain"] |
| edamame-quinoa-power-bowl | lunch | Vegan + GF + nut-free lunch, 29 g, packable |
| lentil-quinoa-tabbouleh-bowl | lunch | Vegan + GF lunch; fixes the GF-lunch THIN cell; greens serving from real parsley volume |
| tofu-veggie-breakfast-scramble | breakfast | Savory dairy-free/egg-free breakfast, 26 g |
| chickpea-flour-veggie-omelet | breakfast | The one breakfast passing every allergen screen at once (no gluten/dairy/egg/soy/nuts) |
| peanut-butter-banana-overnight-oats | breakfast | Dairy-free grab-and-go with gain-phase density (620 kcal, 27 g) |
| chocolate-peanut-butter-soy-smoothie | smoothie | Dairy-free smoothie committee, 42 g, hidden greens serving |
| mango-berry-pea-protein-smoothie | smoothie | The most exclusion-proof smoothie: no dairy, soy, nuts, or gluten; 30 g |
| roasted-chickpea-crunch | snack | Beans-based protein snack for the macroTopUp pool, batch of 4 |
| sea-salt-edamame-bowl | snack | Highest protein-per-minute exclusion-safe snack (18 g in 5 min) |
| silken-tofu-chocolate-pudding | snack | Dairy-free mirror of cottage-cheese-pre-bed (12 g, dessert-shaped) |
| hummus-veggie-snack-plate | snack | No-cook snack contributing otherVeg, a category snacks previously ignored |

### Matrix after expansion (changed cells only)

| Survey answer | Dinner | Lunch | Breakfast | Smoothie | Protein snacks |
|---|---|---|---|---|---|
| Vegan | 6 / ok | 3 / ok | 4 / ok | 2 / ok | 4 / ok |
| Dairy excluded | ~19 / ok | 7 / ok | 5 / ok | 2 / ok | 6 / ok |
| Nuts excluded | ~33 / ok | 9 / ok | 14 / ok | 5 / ok | 5 / ok |
| Gluten excluded | 17 / ok | 5 / ok | 8 / ok | 7 / ok | 13 / ok |
| Vegan + gain | 1 dense main + committees fill / workable | | | | |

Every FAIL cell is now at or above the committee/pool minimum. Vegetarian dinner THIN also resolved (all 6 vegan dinners serve vegetarians: 8 total).

## Loading: nothing to register

The app reads the bank as a directory collection: `store.js` `readCollection("recipes")` lists the data-repo `recipes/` directory via the GitHub Contents API and fetches new/changed files by sha. There is NO index or registry file; dropping the 16 JSON files into `seed-data/generated/recipes/` (and syncing them to the private `mise-data` repo's `recipes/`, the normal seed sync step) is the complete integration. `tests/recipe-data.test.js` and the weekbuilder real-pool integration tests scan the directory and already cover the new files: full suite 193/193 green as of this pass.
