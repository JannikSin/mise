# 0009. Dinners are pots cooked on named cook nights and eaten on the nights between

- **Status:** accepted
- **Date:** 2026-08-30 (commissioned), 2026-09-05 (shipped), 2026-09-07 (cook nights set to Sun, Mon, Tue, Fri, Sat)
- **Deciders:** David ("cook enough for six portions, have it for three meals; no reason to make different recipes every night, I'm a busy person")
- **Tenet invoked:** take the choices away

## Context

The July composer planned a distinct dinner every night and its variety gate refused
repeats. David is a student with about one free hour on a weekday. A kitchen with a
roommate wants one pot that feeds two people for two or three nights, inside the dish's
safe window.

## Options considered

- **Distinct dinners nightly, leftovers as an afterthought.** More variety, seven cooks a
  week, food dies.
- **Cook nights on the brigade, leftover nights stamped with their pot, round-robin pots,
  the safe window enforced, the protein rotated across cook nights.** Fewer cooks, the
  list buys pot-sized amounts.

## Decision

The second. A no-cook night eats the MOST RECENT pot; a feeding cook night is never
swapped by the cost sweep; every shared row says who cooks.

## Consequences

Cooking happens five nights, not seven, and the list sizes the pot for the leftover
plates.

**What gets worse:** "cooking once and having it for four days is not the best" (David,
2026-09-07), so the cook-night set is a ruling that will keep moving; and a pot that
misses its night cascades into the nights that were going to eat it.
