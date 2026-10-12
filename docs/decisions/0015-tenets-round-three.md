# 0015. Seven ordered tenets replace the six of 2026-09-21

- **Status:** accepted
- **Date:** 2026-10-12
- **Deciders:** David; drafted by session tweener, cross-reviewed by wallfacer
- **Tenet invoked:** none (this record amends the tenets)

## Context

The 2026-09-21 tenets mixed values with working rules: "his reading is the scarce resource"
is a session habit, and "the bought week is never disturbed" was already an invariant. The
2026-10-12 audit showed the app had written no data since 2026-10-04 and that the four foods
David actually eats were not in the bank, so the tenets were deciding nothing. Three drafting
rounds, sourced from David's stated goals and the Acquired playbooks (Costco, IKEA, Trader
Joe's, Hermes), produced the set now in `DOCTRINE.md`. The reasoning is in Crystal
`Lanes/App-Doctrines-2026-10-12`.

## Options considered

- **Keep the 2026-09-21 tenets.** No churn; they had decided nothing in three weeks.
- **A flat set of new tenets.** Simpler; leaves collisions such as verification against
  flavour, or waste against variety, to whoever argues hardest.
- **An ordered stack (Crystal `System/App-Doctrine`, the Sol Price form).** The order breaks
  ties before the argument starts.

## Decision

The ordered seven in `DOCTRINE.md`: choices removed and what remains verified, flavour from a
few plain ingredients, buy whole and use completely, cook once and eat several times, decided
at the start of the week, priced and ready to buy, fitted to the person. The old six are
struck through and kept in the doctrine.

## Consequences

A feature that adds a choice now has to beat tenet 1, and a recipe with a long specialty list
has to beat tenet 2. What gets worse: tenet 6 makes a week without a cart load unfinished, so
a store without a price feed is a second-class store.
