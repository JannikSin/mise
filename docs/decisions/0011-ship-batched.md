# 0011. Ship a coherent set once, never several pushes in a row

- **Status:** accepted (2026-07-26); mechanised by decision 0008 (2026-09-07)
- **Date:** 2026-07-26
- **Deciders:** session, after watching the phone churn
- **Tenet invoked:** none

## Context

Every push to `main` bumps the service worker's `CACHE_VERSION`, and every bump makes
each phone download the whole shell and swap it on next open. Several pushes in quick
succession made the app churn on David's phone mid-use.

## Options considered

- **Push as you go.** Fast feedback, a churning phone.
- **Batch a coherent set and push once.** Slower feedback, one swap.

## Decision

Batch. The pre-commit hook bumps the version automatically so a batch is one bump; the
release train later made the batch a week.

## Consequences

One shell swap per set.

**What gets worse:** a fix waits for its batch, and a batch that mixes a fix with a
feature ships both or neither.
