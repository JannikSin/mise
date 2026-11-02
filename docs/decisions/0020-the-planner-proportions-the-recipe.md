# 0020. The planner proportions the recipe, not only the servings

- **Status:** accepted
- **Date:** 2026-11-02
- **Deciders:** David ("you have complete autonomy and ability to make recipes with any combination of ingredients ... please fix once and for all", 11/2); session on `next`
- **Tenet invoked:** 1 (what remains is verified)

## Context

David's 11/2 week, as generated, averaged 264 g of protein a day against a 190 g aim and a
215 g ceiling (P5: protein past the ceiling is grocery money spent for nothing). The composer
sized every dish by whole servings on a quarter grid, so calories and protein moved together
along each recipe's fixed ratio. With a 900 kcal / 70 g dining swipe at lunch, the home food
had to deliver about 2,800 kcal at 43 to 52 g per 1,000 kcal; every dish in his pool runs 55 to
80. Decision 0017 then correctly chose the calorie floor over the ceiling, so every day
landed "over". Replayed read-only on the live data (three weeks, six salts): 97 of 120 of
David's seat-days over 215 g, every one of Elliot's over his.

The transform built for this (`synth.js`, per-person plates) never reached the planner: it
ran at the table, only for the 18 bank recipes tagged `plated`, against a per-slot share of
the whole day that ignores the swipe, and neither the day meters nor the shopping list read
it. Running it on the bank also found its tables were wrong for how the bank is written:
grains were priced cooked though written dry (100 g of rolled oats read as 71 kcal of
porridge), and protein powder was not in the protein bucket at all.

## Options considered

- **Servings only, with 0017 as is.** Every day fed, every day over the ceiling. Costs the
  money P5 exists to save, and it is what David reported.
- **Per-seat continuous solve for every dish.** Exact, but a shared pot cannot be cooked at
  two ratios, so it is only true for plated dishes, which are 18 of 221.
- **A pot-level ratio ladder chosen by the composer.** Each dish may be cooked at one of five
  steps from as written to half the protein bucket and twice the starch bucket, the same for
  everyone at the pot and every night it feeds. Discrete, so not exact, but cookable.

## Decision

The ladder. `RATIO_STEPS` and `withRatio` live in `synth.js`; `composeDay` tries the ladder
only when the recipes as written do not land every seat, and keeps the plating that leaves no
seat under its floor, lands the most seats, then sits nearest protein aim, then changes the
recipe least (each step must buy 3 g nearer aim). Pinned, cooked, bought, leftover and
already-baked slots are locked. The chosen step is stored on the table as `ratio` and every
reader goes through `withRatio`: day meters, the buy, the recipe page, plates and the ledger.
Leavened batters (baking powder, soda, yeast) are never re-proportioned. Grains are priced
dry unless the row says cooked, marked-raw meat raw, and protein powder is protein. 0017
stands: when even the ladder cannot reach both, the floor still wins.

On the same replay: 0 of 120 seat-days over 215 g, 0 under the 3,500 kcal floor, average
about 200 g; Elliot 0 over, 0 under.

## Consequences

Days land under the ceiling and the list stops buying the protein the plate trimmed. What gets
worse: plates are bigger and starchier than the recipe as written (the far step is half the
meat and twice the rice), carbs and fat on a re-proportioned recipe are an Atwater estimate,
the per-seat plate solve is skipped on a re-proportioned table (the pot is one ratio for
everyone), and the solo week builder (`weekbuilder.js`) still sizes by servings only.
