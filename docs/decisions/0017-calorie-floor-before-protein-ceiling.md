# 0017. A day reaches its calorie floor before it respects the protein ceiling

- **Status:** accepted
- **Date:** 2026-10-12
- **Deciders:** session tweener; targets ruled by David (3,700 kcal, 190 g)
- **Tenet invoked:** 1 (what remains is verified)

## Context

On the real 2026-09-25 week, 115 of 432 seat-days landed under the calorie floor. The
composer refused the protein-dense fills that would have closed the gap because they pushed
protein past the ceiling, which decision 0004 and Core Purpose P5 define as a grocery-spend
line, not a health line.

## Options considered

- **Ceiling first.** Protein stays inside the spend line; a quarter of days miss calories.
- **Floor first.** Every day is fed; some days exceed the protein spend line, reported as
  "over", never hidden.

## Decision

Floor first. The snack bake is the cheapest one that lets every seat land (band, then floor),
and `solveSeatDay` prefers reaching the floor with extra protein over an under-floor miss.
On `next` as `ca9fc47`; on the same data, under-floor days went from 115 to 0.

## Consequences

Health beats spend when they collide. What gets worse: some weeks spend more on protein than
the ceiling allows, and the review shows it.
