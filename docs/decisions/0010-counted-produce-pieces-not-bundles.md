# 0010. Counted produce reconciles as pieces against bundles, and pickup produce is bought small and often

- **Status:** accepted
- **Date:** 2026-08-19 (his first real curbside order)
- **Deciders:** David, after the order arrived
- **Tenet invoked:** none

## Context

The cart push sent a banana line as THREE bundles when one covered the need, because a
recipe's count of bananas was reconciled against a store product sold by the bunch as if
the units matched. Pickup shoppers also select ripe produce, so the bananas arrived
all-yellow: a week of bananas at once is a week of brown bananas by Wednesday.

## Options considered

- **Trust the store unit.** What happened.
- **Reconcile every counted quantity as PIECES against the pack's piece count before any
  cart push, and bias pickup produce to small quantities bought often.**

## Decision

The second, as rule 3.7 applied to every quantity, not only weights.

## Consequences

Produce lines buy what the week needs.

**What gets worse:** a food whose pack size the app does not know cannot be reconciled,
which is why pack sizes per food (the order-screenshot import) is queued; and "bought
often" is a habit the plan can suggest but not enforce.
