# 0014. An invited guest adds portions to that day's batch, never a separate meal

- **Status:** accepted
- **Date:** 2026-10-12
- **Deciders:** David
- **Tenet invoked:** 3 (buy whole, use completely) and 4 (cook once, eat several times)

## Context

David wants to cook for friends without guests reshaping the week. The week is cooked on the
weekend in batches: five days for two people is ten portions. A Tuesday dinner for four
should be the Tuesday batch made larger, not a new dish.

## Options considered

- **A guest is a separate meal.** Most flexible; adds a recipe, shopping lines and a cook,
  which is the cost the week is built to avoid.
- **A guest adds portions to the meal already planned for their day.** One dish, scaled; the
  guest eats what the household eats.
- **Guests are planned at a default count.** Simple; buys food for people who may not come.

## Decision

Guests appear in the plan only when invited. An invited guest adds portions to the batch
already planned for their day and nothing else: no extra recipe and no extra cook. The list
and the budget scale with the added portions.

## Consequences

Hosting costs one quantity change. A guest cannot be offered a different dish from the
household's, and a guest with an allergy the day's batch cannot meet needs the plan to say
so (Core Purpose P3) rather than quietly substitute. Amends the "one more plate on a default
profile" wording in Core Purpose P8, changed the same day.
